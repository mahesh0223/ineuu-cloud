const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());
// Serves public/admin.html at /admin - a real fleet dashboard on top of the /api/mdm/* JSON
// endpoints, which previously had no human-usable UI at all (managing 12,000 devices via raw
// curl/Postman calls doesn't scale to an actual ops workflow).
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// ==========================================
// ⚙️ CLOUD ENVIRONMENT CONFIGURATION
// ==========================================
const PORT = process.env.PORT || 3000;
const B2_KEY_ID = process.env.B2_KEY_ID || "YOUR_B2_KEY_ID";
const B2_APP_KEY = process.env.B2_APP_KEY || "YOUR_B2_APP_KEY";
const B2_BUCKET_NAME = process.env.B2_BUCKET_NAME || "ineuu-assets";

// No hardcoded fallback: a default admin password baked into source is a standing
// backdoor for a 12,000-device fleet. If this isn't set in the environment, the
// key-generation endpoint refuses to run instead of silently accepting a known password.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;
if (!ADMIN_PASSWORD) {
    console.warn("⚠️  ADMIN_PASSWORD is not set - /api/admin/generate-keys is disabled until it is configured.");
}

// Emergency activation override, OFF by default. Only usable if explicitly set via
// environment variable (never committed to source). Previously this was a hardcoded
// string ("INEUU-MASTER-2026") baked directly into the repo, which is a permanent
// backdoor for every device in the fleet the moment the repo is exposed.
const MASTER_ACTIVATION_KEY = process.env.MASTER_ACTIVATION_KEY || null;

// Signs per-school admin login sessions (see /api/school/login below). Falls back to a
// random secret generated at boot if not configured - that keeps the server usable in local
// dev without any setup, but it means every school admin gets logged out on every restart/
// redeploy (a new random secret can't verify tokens signed with the old one). Set JWT_SECRET
// in the environment before relying on school-admin logins staying alive across deploys.
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) {
    console.warn("⚠️  JWT_SECRET is not set - using a random secret generated at boot. Every school admin will be logged out on the next restart/redeploy. Set JWT_SECRET before relying on this.");
}

// A school's license validity, in days - "48 hours" and "5 years" are both real options a
// customer can be sold, so this spans both ends rather than assuming a fixed billing period.
const MIN_VALIDITY_DAYS = 2; // 48 hours
const MAX_VALIDITY_DAYS = 365 * 5;
// How long before expiry a panel gets a one-time "license expiring soon" notice.
const LICENSE_WARNING_DAYS = 7;

// ==========================================
// 🗄️ POSTGRES (real persistence for a paid fleet)
// ==========================================
// Both the panel registry and the license-key database used to live as plain JSON files on
// Render's own filesystem. That's fine for an in-place restart/crash, but Render's free/
// starter tier filesystem is EPHEMERAL - a redeploy or a move to a new container can wipe it
// outright. For a handful of pilot devices that's a nuisance (panels just re-register). For
// 12,000 REAL, PAID activations it's a support disaster: the next code push could make every
// already-activated panel start failing with "Invalid activation key" for no reason a customer
// can see. Postgres survives redeploys/container moves, which local disk never did.
//
// DATABASE_URL is not set by default - without it, this falls back to the original local-JSON
// behavior (useful for local dev), but prints a loud warning, since shipping real devices
// against the fallback path silently reintroduces the exact risk this migration exists to fix.
const DATABASE_URL = process.env.DATABASE_URL || null;
let pool = null;
if (DATABASE_URL) {
    pool = new Pool({
        connectionString: DATABASE_URL,
        // Managed Postgres providers (Render Postgres, Supabase, Neon, Railway, etc.) require
        // SSL for external connections and use a certificate that isn't in Node's default trust
        // store - this is the standard, widely-used way to connect without vendoring each
        // provider's CA bundle into the repo, not a downgrade of this app's own traffic.
        ssl: { rejectUnauthorized: false }
    });
} else {
    console.warn("⚠️  DATABASE_URL is not set - falling back to local JSON files (connected_panels.json / license_keys.json). This is NOT safe for real fleet devices: Render's free/starter filesystem does not survive a redeploy, so every activated license key would be lost on the next deploy. Set DATABASE_URL (any managed Postgres works) before shipping real devices.");
}

const PANELS_FILE = './connected_panels.json';
const KEYS_FILE = './license_keys.json';
const SCHOOLS_FILE = './schools.json';

let connectedPanels = {};
let validLicenseKeys = {};
// School tenants - each school gets its own admin login (separate from the vendor-wide
// ADMIN_PASSWORD) scoped to only their own panels, regardless of whether they bought 1 unit
// or 1000. Keyed by school_id.
let schools = {};
// hardware_id -> school_id, derived from whichever license key activated that device. Built at
// load time and updated on every activation - lets both the Socket.IO panel registry and the
// license-expiry engine look up "which school owns this panel" without a DB round-trip on the
// hot path (panel connect / telemetry heartbeat).
let hardwareIdToSchoolId = {};

async function initDb() {
    if (!pool) return;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS license_keys (
            key TEXT PRIMARY KEY,
            is_used BOOLEAN NOT NULL DEFAULT FALSE,
            linked_device TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            activated_at TIMESTAMPTZ
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS panels (
            hardware_id TEXT PRIMARY KEY,
            school_id TEXT,
            status TEXT,
            telemetry JSONB,
            last_seen BIGINT
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS schools (
            school_id TEXT PRIMARY KEY,
            school_name TEXT NOT NULL,
            admin_username TEXT UNIQUE NOT NULL,
            admin_password_hash TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
    // Added after the original license_keys/panels tables already existed in production -
    // IF NOT EXISTS makes this safe to run on every boot rather than needing a one-off manual
    // migration step.
    await pool.query(`ALTER TABLE license_keys ADD COLUMN IF NOT EXISTS owner_school_id TEXT`);
    await pool.query(`ALTER TABLE license_keys ADD COLUMN IF NOT EXISTS validity_days INTEGER`);
    await pool.query(`ALTER TABLE license_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE license_keys ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT FALSE`);
    await pool.query(`ALTER TABLE license_keys ADD COLUMN IF NOT EXISTS warning_sent BOOLEAN NOT NULL DEFAULT FALSE`);
    await pool.query(`ALTER TABLE panels ADD COLUMN IF NOT EXISTS owner_school_id TEXT`);
    console.log("✅ Postgres tables ready (license_keys, panels, schools).");
}

// Loads both registries at startup - from Postgres if configured, otherwise the legacy local
// JSON files. Called once before server.listen() further down.
async function loadState() {
    if (pool) {
        try {
            const keysRes = await pool.query('SELECT key, is_used, linked_device, created_at, activated_at, owner_school_id, validity_days, expires_at, locked, warning_sent FROM license_keys');
            keysRes.rows.forEach(row => {
                validLicenseKeys[row.key] = {
                    isUsed: row.is_used,
                    linkedDevice: row.linked_device,
                    createdAt: row.created_at,
                    activatedAt: row.activated_at,
                    ownerSchoolId: row.owner_school_id,
                    validityDays: row.validity_days,
                    expiresAt: row.expires_at,
                    locked: row.locked,
                    warningSent: row.warning_sent
                };
                if (row.linked_device && row.owner_school_id) {
                    hardwareIdToSchoolId[row.linked_device] = row.owner_school_id;
                }
            });
            console.log(`♻️ Loaded ${keysRes.rows.length} license key(s) from Postgres.`);

            const panelsRes = await pool.query('SELECT hardware_id, school_id, telemetry, last_seen FROM panels');
            panelsRes.rows.forEach(row => {
                connectedPanels[row.hardware_id] = {
                    school_id: row.school_id,
                    ownerSchoolId: hardwareIdToSchoolId[row.hardware_id] || null,
                    socket_id: null,
                    status: "OFFLINE", // a socket_id from a previous process is never valid after a restart
                    telemetry: row.telemetry || { cpuTemp: "N/A", storage: "N/A", wifi: "N/A" },
                    lastSeen: Number(row.last_seen) || 0
                };
            });
            console.log(`♻️ Restored ${panelsRes.rows.length} known panel(s) from Postgres (marked OFFLINE pending reconnect).`);

            const schoolsRes = await pool.query('SELECT school_id, school_name, admin_username, admin_password_hash, created_at FROM schools');
            schoolsRes.rows.forEach(row => {
                schools[row.school_id] = {
                    schoolName: row.school_name,
                    adminUsername: row.admin_username,
                    adminPasswordHash: row.admin_password_hash,
                    createdAt: row.created_at
                };
            });
            console.log(`♻️ Loaded ${schoolsRes.rows.length} school(s) from Postgres.`);
        } catch (e) {
            console.error("⚠️ Failed to load state from Postgres:", e);
        }
        return;
    }

    if (fs.existsSync(KEYS_FILE)) {
        try {
            validLicenseKeys = JSON.parse(fs.readFileSync(KEYS_FILE));
            Object.values(validLicenseKeys).forEach(k => {
                if (k.linkedDevice && k.ownerSchoolId) hardwareIdToSchoolId[k.linkedDevice] = k.ownerSchoolId;
            });
        } catch (e) {
            console.error("⚠️ Failed to parse keys file, resetting...", e);
            validLicenseKeys = {};
        }
    } else {
        fs.writeFileSync(KEYS_FILE, JSON.stringify({}));
    }

    if (fs.existsSync(SCHOOLS_FILE)) {
        try {
            schools = JSON.parse(fs.readFileSync(SCHOOLS_FILE));
        } catch (e) {
            console.error("⚠️ Failed to parse schools file, resetting...", e);
            schools = {};
        }
    } else {
        fs.writeFileSync(SCHOOLS_FILE, JSON.stringify({}));
    }

    if (fs.existsSync(PANELS_FILE)) {
        try {
            connectedPanels = JSON.parse(fs.readFileSync(PANELS_FILE));
            for (const id in connectedPanels) {
                connectedPanels[id].status = "OFFLINE";
                connectedPanels[id].ownerSchoolId = hardwareIdToSchoolId[id] || null;
            }
            console.log(`♻️ Restored ${Object.keys(connectedPanels).length} known panel(s) from disk (marked OFFLINE pending reconnect).`);
        } catch (e) {
            console.error("⚠️ Failed to parse persisted panels file, starting fresh...", e);
            connectedPanels = {};
        }
    }
}

// Persists a single license key's current state. Called right after every in-memory mutation
// (key generation, activation) - the caller always has exactly one key to persist, so this
// stays a single-row upsert rather than rewriting the whole table.
async function persistLicenseKey(key) {
    const record = validLicenseKeys[key];
    if (pool) {
        try {
            await pool.query(
                `INSERT INTO license_keys (key, is_used, linked_device, created_at, activated_at, owner_school_id, validity_days, expires_at, locked, warning_sent)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                 ON CONFLICT (key) DO UPDATE SET is_used = EXCLUDED.is_used, linked_device = EXCLUDED.linked_device, activated_at = EXCLUDED.activated_at, owner_school_id = EXCLUDED.owner_school_id, validity_days = EXCLUDED.validity_days, expires_at = EXCLUDED.expires_at, locked = EXCLUDED.locked, warning_sent = EXCLUDED.warning_sent`,
                [key, record.isUsed, record.linkedDevice, record.createdAt, record.activatedAt || null, record.ownerSchoolId || null, record.validityDays || null, record.expiresAt || null, record.locked || false, record.warningSent || false]
            );
        } catch (e) {
            console.error("⚠️ Failed to persist license key to Postgres:", e);
        }
    } else {
        fs.writeFileSync(KEYS_FILE, JSON.stringify(validLicenseKeys, null, 2));
    }
}

// Bulk-inserts a freshly generated batch of keys (e.g. all 12,000 at once) in chunks, rather
// than one round-trip per key - the difference between a few seconds and tens of minutes when
// generating a whole shipment's worth of licenses at once.
async function bulkInsertLicenseKeys(keys) {
    if (!pool) {
        fs.writeFileSync(KEYS_FILE, JSON.stringify(validLicenseKeys, null, 2));
        return;
    }
    const chunkSize = 500;
    for (let i = 0; i < keys.length; i += chunkSize) {
        const chunk = keys.slice(i, i + chunkSize);
        const values = [];
        const rows = chunk.map((key, idx) => {
            const p = idx * 4;
            const rec = validLicenseKeys[key];
            values.push(key, rec.createdAt, rec.ownerSchoolId || null, rec.validityDays || null);
            return `($${p + 1}, false, NULL, $${p + 2}, NULL, $${p + 3}, $${p + 4}, NULL, false, false)`;
        });
        await pool.query(
            `INSERT INTO license_keys (key, is_used, linked_device, created_at, activated_at, owner_school_id, validity_days, expires_at, locked, warning_sent) VALUES ${rows.join(', ')} ON CONFLICT (key) DO NOTHING`,
            values
        );
    }
}

// Single-row upsert for a school record - generation-time-plus-onboarding is inherently
// infrequent (nowhere near the panel-heartbeat volume), so no batching/dirty-tracking is
// needed the way panels/keys have.
async function persistSchool(schoolId) {
    const record = schools[schoolId];
    if (pool) {
        try {
            await pool.query(
                `INSERT INTO schools (school_id, school_name, admin_username, admin_password_hash, created_at)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (school_id) DO UPDATE SET school_name = EXCLUDED.school_name, admin_username = EXCLUDED.admin_username, admin_password_hash = EXCLUDED.admin_password_hash`,
                [schoolId, record.schoolName, record.adminUsername, record.adminPasswordHash, record.createdAt]
            );
        } catch (e) {
            console.error("⚠️ Failed to persist school to Postgres:", e);
        }
    } else {
        fs.writeFileSync(SCHOOLS_FILE, JSON.stringify(schools, null, 2));
    }
}

// Panel state changes (registration, and ONLINE/OFFLINE transitions) are durably persisted;
// the routine 10-second telemetry heartbeat deliberately is NOT (see markPanelDirty below) -
// at 12,000 devices, writing every heartbeat to Postgres would mean roughly 1,200 writes/sec
// sustained, which no reasonably-priced plan absorbs, for a benefit (telemetry being a few
// seconds fresher immediately after a redeploy) nobody actually needs. The live dashboard reads
// straight from the in-memory connectedPanels object, which is always current regardless of
// what's been flushed to Postgres.
let dirtyPanelIds = new Set();
let panelsSaveTimeout = null;
function markPanelDirty(hardwareId) {
    dirtyPanelIds.add(hardwareId);
    if (panelsSaveTimeout) return;
    panelsSaveTimeout = setTimeout(async () => {
        panelsSaveTimeout = null;
        const idsToFlush = Array.from(dirtyPanelIds);
        dirtyPanelIds = new Set();
        if (idsToFlush.length === 0) return;
        if (pool) {
            for (const id of idsToFlush) {
                const p = connectedPanels[id];
                if (!p) continue;
                try {
                    await pool.query(
                        `INSERT INTO panels (hardware_id, school_id, status, telemetry, last_seen, owner_school_id)
                         VALUES ($1, $2, $3, $4, $5, $6)
                         ON CONFLICT (hardware_id) DO UPDATE SET school_id = EXCLUDED.school_id, status = EXCLUDED.status, telemetry = EXCLUDED.telemetry, last_seen = EXCLUDED.last_seen, owner_school_id = EXCLUDED.owner_school_id`,
                        [id, p.school_id, p.status, JSON.stringify(p.telemetry), p.lastSeen, p.ownerSchoolId || null]
                    );
                } catch (e) {
                    console.error(`⚠️ Failed to persist panel ${id} to Postgres:`, e);
                }
            }
        } else {
            fs.writeFile(PANELS_FILE, JSON.stringify(connectedPanels, null, 2), (err) => {
                if (err) console.error("⚠️ Failed to persist panels file:", err);
            });
        }
    }, 2000);
}

// 🛠️ ADMIN API: Dynamic Key Generator
app.post('/api/admin/generate-keys', async (req, res) => {
    if (!ADMIN_PASSWORD) {
        return res.status(503).json({ success: false, message: "Admin key generation is disabled: ADMIN_PASSWORD is not configured on the server." });
    }

    const { count, adminPassword, schoolId, validityDays } = req.body;

    if (adminPassword !== ADMIN_PASSWORD) {
        return res.status(403).json({ success: false, message: "Unauthorized Admin Password." });
    }

    // schoolId/validityDays are both optional at generation time - a batch can be pre-generated
    // as unassigned stock before it's known which school will get which physical unit, and
    // assigned later via /api/admin/assign-key. When validityDays IS given it must be a real
    // number of days somewhere between 48 hours and 5 years - anything shorter/longer than
    // that range is almost certainly a mistake (a mistyped value in days vs. hours/months),
    // not a real commercial term worth allowing silently.
    if (schoolId && !schools[schoolId]) {
        return res.status(400).json({ success: false, message: `Unknown schoolId "${schoolId}" - create the school first via /api/admin/create-school.` });
    }
    if (validityDays !== undefined && validityDays !== null && (validityDays < MIN_VALIDITY_DAYS || validityDays > MAX_VALIDITY_DAYS)) {
        return res.status(400).json({ success: false, message: `validityDays must be between ${MIN_VALIDITY_DAYS} (48 hours) and ${MAX_VALIDITY_DAYS} (5 years).` });
    }

    const newKeys = [];
    // Bumped default cap-free, but generating a real shipment's worth (thousands) in one
    // request is exactly what bulkInsertLicenseKeys's chunked inserts exist for - see there.
    const numToGenerate = count || 10;

    for (let i = 0; i < numToGenerate; i++) {
        const chunk1 = crypto.randomBytes(2).toString('hex').toUpperCase();
        const chunk2 = crypto.randomBytes(2).toString('hex').toUpperCase();
        const chunk3 = crypto.randomBytes(2).toString('hex').toUpperCase();
        const newKey = `INEUU-${chunk1}-${chunk2}-${chunk3}`;

        validLicenseKeys[newKey] = {
            isUsed: false,
            linkedDevice: null,
            createdAt: new Date().toISOString(),
            ownerSchoolId: schoolId || null,
            validityDays: validityDays || null,
            expiresAt: null,
            locked: false,
            warningSent: false
        };
        newKeys.push(newKey);
    }

    try {
        await bulkInsertLicenseKeys(newKeys);
    } catch (e) {
        console.error("⚠️ Failed to persist generated keys:", e);
        return res.status(500).json({ success: false, message: "Keys were generated in memory but failed to persist - do not ship these until this is resolved." });
    }
    console.log(`🛠️ Admin generated ${numToGenerate} new license keys.`);
    res.json({ success: true, generatedKeys: newKeys });
});

// 📺 IFPD API: Hardware Activation Router
app.post('/api/mdm/activate', async (req, res) => {
    const { licenseKey, hardwareId } = req.body;

    if (!licenseKey || !hardwareId) {
        return res.status(400).json({ success: false, reason: "Missing key or device configuration data." });
    }

    const cleanKey = licenseKey.toUpperCase().trim();

    // Emergency override, only live if MASTER_ACTIVATION_KEY is explicitly set in the
    // environment. Unset by default, so this path is inert on a stock deployment.
    if (MASTER_ACTIVATION_KEY && cleanKey === MASTER_ACTIVATION_KEY) {
        console.log(`🔐 MASTER KEY USED! Board activated! Hardware ID: ${hardwareId}`);
        return res.json({ success: true, message: "Master license validated successfully." });
    }

    const keyRecord = validLicenseKeys[cleanKey];

    if (!keyRecord) {
        return res.status(401).json({ success: false, reason: "Invalid software activation key." });
    }

    if (keyRecord.isUsed && keyRecord.linkedDevice !== hardwareId) {
        return res.status(403).json({ success: false, reason: "License key is already claimed by a different IFPD." });
    }

    // A key the expiry engine (below) already flagged locked stays locked even if the same
    // device tries to "re-activate" it (e.g. after a factory reset) - re-activation must not
    // be usable as a way to bypass an expired license.
    if (keyRecord.locked) {
        return res.status(403).json({ success: false, reason: "License has expired. Contact your administrator to renew.", locked: true });
    }

    keyRecord.isUsed = true;
    keyRecord.linkedDevice = hardwareId;
    // expiresAt is computed ONLY on first activation, never recalculated on a later re-check/
    // re-activation from the same already-linked device - otherwise a reset-and-reactivate
    // loop could indefinitely extend a license that was only ever paid for once.
    if (!keyRecord.activatedAt) {
        keyRecord.activatedAt = new Date().toISOString();
        if (keyRecord.validityDays) {
            keyRecord.expiresAt = new Date(Date.now() + keyRecord.validityDays * 24 * 60 * 60 * 1000).toISOString();
        }
    }
    if (keyRecord.ownerSchoolId) {
        hardwareIdToSchoolId[hardwareId] = keyRecord.ownerSchoolId;
        if (connectedPanels[hardwareId]) connectedPanels[hardwareId].ownerSchoolId = keyRecord.ownerSchoolId;
    }

    await persistLicenseKey(cleanKey);

    console.log(`🔐 Board verified! Hardware ID: ${hardwareId} bound permanently to Key: ${cleanKey}${keyRecord.expiresAt ? `, expires ${keyRecord.expiresAt}` : ' (no expiry)'}`);
    return res.json({
        success: true,
        message: "Device license validated successfully.",
        expiresAt: keyRecord.expiresAt || null
    });
});

// Called by the Android app on boot and periodically thereafter - a live MDM push (see the
// expiry engine near the bottom of this file) can be missed entirely if the panel is offline
// at the exact moment it fires. This lets a panel self-enforce its own lock state the next
// time it has connectivity, rather than depending on catching that one push.
app.post('/api/mdm/check-license', (req, res) => {
    const { hardwareId } = req.body || {};
    if (!hardwareId) {
        return res.status(400).json({ success: false, message: "hardwareId is required." });
    }
    const entry = Object.entries(validLicenseKeys).find(([, r]) => r.linkedDevice === hardwareId);
    if (!entry) {
        // No key on record for this device (e.g. activated via MASTER_ACTIVATION_KEY, or a
        // legacy activation from before this licensing system existed) - treat as unrestricted
        // rather than locking a device that was never issued an expiring key at all.
        return res.json({ success: true, locked: false, expiresAt: null, daysRemaining: null, warning: false });
    }
    const [, record] = entry;
    const now = Date.now();
    const expiresAtMs = record.expiresAt ? new Date(record.expiresAt).getTime() : null;
    const warning = expiresAtMs !== null && !record.locked && expiresAtMs > now && (expiresAtMs - now) <= LICENSE_WARNING_DAYS * 24 * 60 * 60 * 1000;
    res.json({
        success: true,
        locked: !!record.locked,
        expiresAt: record.expiresAt || null,
        daysRemaining: expiresAtMs !== null ? Math.max(0, Math.ceil((expiresAtMs - now) / (24 * 60 * 60 * 1000))) : null,
        warning
    });
});

// Assigns an already-generated (unassigned) key to a school after the fact - covers the case
// where stock was pre-generated before it was known which school would receive which physical
// unit.
app.post('/api/admin/assign-key', (req, res) => {
    if (!ADMIN_PASSWORD) {
        return res.status(503).json({ success: false, message: "Admin actions are disabled: ADMIN_PASSWORD is not configured on the server." });
    }
    const { adminPassword, key, schoolId, validityDays } = req.body;
    if (adminPassword !== ADMIN_PASSWORD) {
        return res.status(403).json({ success: false, message: "Unauthorized Admin Password." });
    }
    const cleanKey = (key || '').toUpperCase().trim();
    const record = validLicenseKeys[cleanKey];
    if (!record) {
        return res.status(404).json({ success: false, message: "Unknown license key." });
    }
    if (!schools[schoolId]) {
        return res.status(400).json({ success: false, message: `Unknown schoolId "${schoolId}".` });
    }
    if (validityDays !== undefined && validityDays !== null && (validityDays < MIN_VALIDITY_DAYS || validityDays > MAX_VALIDITY_DAYS)) {
        return res.status(400).json({ success: false, message: `validityDays must be between ${MIN_VALIDITY_DAYS} and ${MAX_VALIDITY_DAYS}.` });
    }
    record.ownerSchoolId = schoolId;
    if (validityDays) record.validityDays = validityDays;
    persistLicenseKey(cleanKey);
    res.json({ success: true });
});

// ==========================================
// 🏫 SCHOOL TENANTS - each school gets its own admin login, scoped to only their own panels
// ==========================================
// Vendor-side (super-admin, existing ADMIN_PASSWORD) creates a school account - real customer
// onboarding, not self-serve signup, since a school buying 1-1000 panels is a sales
// transaction, not an open registration.
app.post('/api/admin/create-school', async (req, res) => {
    if (!ADMIN_PASSWORD) {
        return res.status(503).json({ success: false, message: "Admin actions are disabled: ADMIN_PASSWORD is not configured on the server." });
    }
    const { adminPassword, schoolName, username, password } = req.body;
    if (adminPassword !== ADMIN_PASSWORD) {
        return res.status(403).json({ success: false, message: "Unauthorized Admin Password." });
    }
    if (!schoolName || !username || !password) {
        return res.status(400).json({ success: false, message: "schoolName, username, and password are all required." });
    }
    const usernameTaken = Object.values(schools).some(s => s.adminUsername.toLowerCase() === username.toLowerCase());
    if (usernameTaken) {
        return res.status(409).json({ success: false, message: "That username is already in use by another school." });
    }
    const schoolId = `SCH-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const passwordHash = await bcrypt.hash(password, 10);
    schools[schoolId] = {
        schoolName,
        adminUsername: username,
        adminPasswordHash: passwordHash,
        createdAt: new Date().toISOString()
    };
    await persistSchool(schoolId);
    console.log(`🏫 Created school "${schoolName}" (${schoolId}), admin username: ${username}`);
    res.json({ success: true, schoolId });
});

// Lists schools (name + username, never the password hash) for the super-admin dashboard's
// school picker when generating/assigning keys.
app.get('/api/admin/schools', requireAdmin, (req, res) => {
    const list = Object.entries(schools).map(([schoolId, s]) => ({
        schoolId,
        schoolName: s.schoolName,
        adminUsername: s.adminUsername,
        createdAt: s.createdAt
    }));
    res.json({ success: true, schools: list });
});

app.post('/api/school/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
        return res.status(400).json({ success: false, message: "username and password are required." });
    }
    const entry = Object.entries(schools).find(([, s]) => s.adminUsername.toLowerCase() === username.toLowerCase());
    if (!entry) {
        return res.status(401).json({ success: false, message: "Invalid username or password." });
    }
    const [schoolId, school] = entry;
    const matches = await bcrypt.compare(password, school.adminPasswordHash);
    if (!matches) {
        return res.status(401).json({ success: false, message: "Invalid username or password." });
    }
    const token = jwt.sign({ schoolId }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ success: true, token, schoolId, schoolName: school.schoolName });
});

// Every /api/school/* route below is scoped to req.schoolId from the verified token - a school
// admin can only ever see or command panels whose owner_school_id matches their own, even if
// they somehow guessed another panel's hardware_id.
function requireSchoolAuth(req, res, next) {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
        return res.status(401).json({ success: false, message: "Missing login token." });
    }
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.schoolId = payload.schoolId;
        next();
    } catch (e) {
        return res.status(401).json({ success: false, message: "Session expired or invalid - please log in again." });
    }
}

app.get('/api/school/devices', requireSchoolAuth, (req, res) => {
    const scoped = {};
    for (const id in connectedPanels) {
        if (connectedPanels[id].ownerSchoolId === req.schoolId) scoped[id] = connectedPanels[id];
    }
    res.json(scoped);
});

app.post('/api/school/command', requireSchoolAuth, (req, res) => {
    const { hardware_id, action, text } = req.body;
    if (!hardware_id || !action) {
        return res.status(400).json({ success: false, error: "Missing hardware_id or action command." });
    }
    const panel = connectedPanels[hardware_id];
    // Ownership check happens BEFORE dispatch - this is the actual multi-tenant boundary. A
    // school admin who doesn't own this hardware_id gets rejected here regardless of whether
    // the panel is even online.
    if (!panel || panel.ownerSchoolId !== req.schoolId) {
        return res.status(403).json({ success: false, error: "That panel does not belong to your school." });
    }
    const payload = { action, message: text || "", text: text || "" };
    if (panel.socket_id) {
        io.to(panel.socket_id).emit('mdm_execute', payload);
    }
    console.log(`📡 School [${req.schoolId}] triggered command: [${action}] for Device: [${hardware_id}]`);
    return res.json({ success: true, message: "Command dispatched successfully." });
});

// ==========================================
// 📚 PRIVATE B2 CURRICULUM FILE AUTO-INDEXER
// ==========================================
app.get('/api/storage/library', async (req, res) => {
    try {
        console.log("📚 Processing cloud library tree index optimization request...");
        const basic = Buffer.from(`${B2_KEY_ID}:${B2_APP_KEY}`).toString('base64');
        
        const authRes = await httpsRequest({
            hostname: 'api.backblazeb2.com',
            path: '/b2api/v3/b2_authorize_account',
            method: 'GET',
            headers: { Authorization: `Basic ${basic}` }
        });
        
        if (authRes.statusCode !== 200) throw new Error("Backblaze Auth Engine Refused Session");
        const auth = JSON.parse(authRes.body);

        const apiUrl = auth.apiInfo.storageApi.apiUrl;
        const downloadUrl = auth.apiInfo.storageApi.downloadUrl;
        const accountToken = auth.authorizationToken;
        const bucketId = auth.apiInfo.storageApi.bucketId;

        const listRes = await b2PostJson(`${apiUrl}/b2api/v3/b2_list_file_names`, accountToken, {
            bucketId: bucketId,
            maxFileCount: 1000,
            prefix: "NCERT/"
        });

        const dlAuthRes = await b2PostJson(`${apiUrl}/b2api/v3/b2_get_download_authorization`, accountToken, {
            bucketId: bucketId,
            fileNamePrefix: "NCERT/",
            validDurationInSeconds: 86400 
        });
        const secureToken = dlAuthRes.authorizationToken;

        let catalog = {};

        listRes.files.forEach(file => {
            const parts = file.fileName.split('/');
            if (parts.length >= 4) {
                const className = parts[1]; 
                const subject = parts[2];   
                const rawName = parts[3];   
                
                const type = rawName.toLowerCase().endsWith('.glb') ? '3d' : 'pdf';
                const cleanName = rawName.replace('.pdf', '').replace('.glb', '').replace(/_/g, ' ');

                if (!catalog[className]) catalog[className] = {};
                if (!catalog[className][subject]) catalog[className][subject] = [];

                catalog[className][subject].push({
                    name: cleanName,
                    type: type,
                    url: `${downloadUrl}/file/${B2_BUCKET_NAME}/${encodeURIComponent(file.fileName)}?Authorization=${secureToken}`
                });
            }
        });

        res.json({ success: true, library: catalog });
    } catch (error) {
        console.error("❌ Cloud Library Indexing Failure:", error);
        res.status(500).json({ success: false, message: "Internal Engine could not resolve assets storage bucket map." });
    }
});

// ==========================================
// 🚀 FLEET MDM COMMAND CENTER & SOCKET HUB
// ==========================================
// Both routes below had NO authentication at all - anyone who found the URL could see every
// school's hardware IDs/telemetry (GET /api/mdm/devices), or remotely command ANY panel
// (POST /api/mdm/command), including EXIT_KIOSK, which would let a student escape kiosk
// lockdown from entirely outside the device. Found while building the admin dashboard on top
// of these same endpoints - a real gap, not hypothetical, for a fleet this size. Uses a header
// (not a query param or body field) so the password never ends up in server logs or browser
// history the way a URL-embedded credential would.
function requireAdmin(req, res, next) {
    if (!ADMIN_PASSWORD) {
        return res.status(503).json({ success: false, message: "Admin access is disabled: ADMIN_PASSWORD is not configured on the server." });
    }
    if (req.get('x-admin-password') !== ADMIN_PASSWORD) {
        return res.status(403).json({ success: false, message: "Unauthorized." });
    }
    next();
}

app.post('/api/mdm/command', requireAdmin, (req, res) => {
    const { hardware_id, action, text } = req.body;

    if (!hardware_id || !action) {
        return res.status(400).json({ success: false, error: "Missing hardware_id or action command." });
    }

    console.log(`📡 Dashboard triggered command: [${action}] for Device: [${hardware_id}]`);

    let targetSocketId = null;
    
    // Look up socket mapping from the connectedPanels dictionary
    if (connectedPanels && connectedPanels[hardware_id]) {
        targetSocketId = connectedPanels[hardware_id].socket_id;
    }

    // Prepare payload exactly matching MdmFleetService.kt expectations
    const payload = {
        action: action,
        message: text || "",
        text: text || ""
    };

    if (targetSocketId) {
        // Direct targeting via specific socket ID mapping
        io.to(targetSocketId).emit('mdm_execute', payload);
        console.log(`➡️ Command pushed to specific socket channel: ${targetSocketId}`);
    } else {
        // Broadcast room backup if explicit mapping isn't found
        io.emit('mdm_execute', payload); 
        console.log(`📢 Command broadcasted widely across network channels.`);
    }

    return res.json({ success: true, message: "Command dispatched successfully." });
});

app.get('/api/mdm/devices', requireAdmin, (req, res) => {
    res.json(connectedPanels);
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/school-admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'school-admin.html'));
});

// ==========================================
// 🌐 SERVER-SIDE INDIC TRANSLATION (NLLB-200-distilled-600M)
// ==========================================
// Runs the translation model here instead of on each board. The on-device ONNX Runtime
// Mobile pipeline hit repeated Mobile-only bugs (MatMulNBits quantization scale errors,
// SimplifiedLayerNormFusion graph-optimizer crashes) that don't exist on desktop/server ONNX
// Runtime, and the same 600M-param model was too slow decoding on board-class ARM CPUs with
// no GPU/NPU acceleration. transformers.js runs the model's own well-tested generate() loop
// instead of a hand-rolled one, so none of the on-device decode-loop bugs apply here either.
// The model (~600MB-1.2GB depending on dtype) is loaded lazily on first request and reused
// for the life of the process - this needs a Render plan with enough RAM (the free/starter
// 512MB tier is NOT enough; use at least a 2GB-RAM plan).
let translatorPipelinePromise = null;
function getTranslator() {
    if (!translatorPipelinePromise) {
        translatorPipelinePromise = (async () => {
            const { pipeline } = await import('@huggingface/transformers');
            console.log('⏳ Loading NLLB-200 translation model (first request only)...');
            // Deliberately full precision (no dtype override). Both quantized variants tested
            // wrong: 'q8' loads fine but produces hallucinated, semantically unrelated output
            // (e.g. "Where is Shimla?" -> "What is it?"); 'fp16' crashes ONNX Runtime outright
            // with the same SimplifiedLayerNormFusion graph-optimizer bug hit on the Android
            // build. Only the unquantized model is both correct and stable, at the cost of
            // needing ~4GB+ RAM on whatever plan hosts this.
            const translator = await pipeline('translation', 'Xenova/nllb-200-distilled-600M');
            console.log('✅ NLLB-200 translation model loaded and ready.');
            return translator;
        })().catch((e) => {
            translatorPipelinePromise = null; // allow retry on next request instead of caching a failure forever
            throw e;
        });
    }
    return translatorPipelinePromise;
}

app.post('/api/translate', async (req, res) => {
    const { text, srcLang, tgtLang } = req.body || {};
    if (!text || !srcLang || !tgtLang) {
        return res.status(400).json({ error: 'text, srcLang, and tgtLang are required' });
    }
    try {
        const translator = await getTranslator();
        const output = await translator(text, { src_lang: srcLang, tgt_lang: tgtLang });
        res.json({ translatedText: output[0].translation_text });
    } catch (e) {
        console.error('Translation error:', e);
        res.status(500).json({ error: 'Translation failed' });
    }
});

io.on('connection', (socket) => {
    console.log(`🔌 Native Socket Handshake Initialized: ${socket.id}`);

    socket.on('register_panel', (data) => {
        const { hardware_id, school_id } = data;
        connectedPanels[hardware_id] = {
            school_id: school_id || "INEUU_Board_" + hardware_id,
            ownerSchoolId: hardwareIdToSchoolId[hardware_id] || null,
            socket_id: socket.id,
            status: "ONLINE",
            telemetry: { cpuTemp: "⚡", storage: "Reading...", wifi: "Connected" },
            lastSeen: Date.now()
        };
        console.log(`🖥️ Screen Terminal Authenticated and Cataloged: ${hardware_id}`);
        markPanelDirty(hardware_id);
    });

    socket.on('telemetry_update', (data) => {
        const { hardware_id, telemetry } = data;

        // Every field here updates the in-memory registry unconditionally, which is what the
        // live dashboard actually reads - only a real state change (new panel, or an
        // OFFLINE->ONLINE flip) gets marked dirty for Postgres. At 12,000 panels heartbeating
        // every 10 seconds, persisting every single heartbeat would mean roughly 1,200 writes/
        // sec sustained - durability only actually matters for surviving a redeploy, and
        // telemetry being a few seconds stale immediately after one is a complete non-issue.
        if (connectedPanels[hardware_id]) {
            connectedPanels[hardware_id].telemetry = telemetry;
            connectedPanels[hardware_id].lastSeen = Date.now();
            if (connectedPanels[hardware_id].status === "OFFLINE") {
                connectedPanels[hardware_id].status = "ONLINE";
                markPanelDirty(hardware_id);
            }
        } else {
            // 🔥 THE RENDER REBOOT AMNESIA PROTECTION PATCH 🔥
            connectedPanels[hardware_id] = {
                school_id: "INEUU_Board_" + hardware_id,
                ownerSchoolId: hardwareIdToSchoolId[hardware_id] || null,
                socket_id: socket.id,
                status: "ONLINE",
                telemetry: telemetry || { cpuTemp: "N/A", storage: "N/A", wifi: "N/A" },
                lastSeen: Date.now()
            };
            console.log(`♻️ Cluster memory self-healed. Restored Active Panel Node: ${hardware_id}`);
            markPanelDirty(hardware_id);
        }
    });

    // ==========================================================
    // 📺 WEBRTC WIRELESS SCREEN MIRRORING SIGNALING RELAYS
    // ==========================================================
    socket.on('request_cast', (data) => {
        const { target_hardware_id, offer } = data;
        const panel = connectedPanels[target_hardware_id];
        if (panel) {
            console.log(`📺 Relaying WebRTC Screen Offer from Laptop [${socket.id}] to Board Socket [${panel.socket_id}]`);
            io.to(panel.socket_id).emit('incoming_cast_offer', {
                sender_socket_id: socket.id,
                offer: offer
            });
        } else {
            console.log(`❌ Cast failed: Target Board [${target_hardware_id}] is currently offline.`);
        }
    });

    socket.on('answer_cast', (data) => {
        const { target_sender_id, answer } = data;
        console.log(`📺 Relaying WebRTC Accept Answer back to Laptop Dashboard [${target_sender_id}]`);
        io.to(target_sender_id).emit('cast_answered', { answer: answer });
    });

    socket.on('ice_candidate', (data) => {
        const { target_id, candidate } = data;
        const panel = connectedPanels[target_id];
        if (panel) {
            io.to(panel.socket_id).emit('incoming_ice_candidate', { candidate: candidate });
        } else {
            io.to(target_id).emit('incoming_ice_candidate', { candidate: candidate });
        }
    });

    socket.on('disconnect', () => {
        for (const id in connectedPanels) {
            if (connectedPanels[id].socket_id === socket.id) {
                connectedPanels[id].status = "OFFLINE";
                console.log(`⚠️ Panel drop alert context triggered. Socket pipeline lost: ${id}`);
                markPanelDirty(id);
                break;
            }
        }
    });
});

// Sweeper function to flag lost boards
setInterval(() => {
    const now = Date.now();
    for (const id in connectedPanels) {
        if (connectedPanels[id].status !== "OFFLINE" && now - connectedPanels[id].lastSeen > 35000) {
            connectedPanels[id].status = "OFFLINE";
            markPanelDirty(id);
        }
    }
}, 15000);

// ==========================================
// ⏳ LICENSE EXPIRY ENGINE
// ==========================================
// Checks every activated, unlocked key against its expires_at. A key past expiry gets locked
// (persisted immediately, so it's enforced even across a redeploy) and, if the panel is
// currently online, gets an immediate LOCK_DEVICE push - but the real enforcement backstop is
// /api/mdm/check-license above, since a panel that's offline right now will simply see
// locked: true the next time it calls that, whether or not it was online to catch this push.
// Keys inside the warning window get a one-time LICENSE_EXPIRING notice instead.
async function checkLicenseExpiries() {
    const now = Date.now();
    for (const key in validLicenseKeys) {
        const record = validLicenseKeys[key];
        if (!record.isUsed || !record.expiresAt || record.locked) continue;
        const expiresAtMs = new Date(record.expiresAt).getTime();
        const hardwareId = record.linkedDevice;
        const panel = connectedPanels[hardwareId];

        if (expiresAtMs <= now) {
            record.locked = true;
            try { await persistLicenseKey(key); } catch (e) { console.error(`⚠️ Failed to persist expiry lock for ${key}:`, e); }
            console.log(`🔒 License expired - locking device: ${hardwareId} (key ${key})`);
            if (panel && panel.socket_id) {
                const msg = "Your license has expired. Contact your administrator to renew.";
                io.to(panel.socket_id).emit('mdm_execute', { action: 'LOCK_DEVICE', message: msg, text: msg });
            }
        } else if (!record.warningSent && (expiresAtMs - now) <= LICENSE_WARNING_DAYS * 24 * 60 * 60 * 1000) {
            record.warningSent = true;
            try { await persistLicenseKey(key); } catch (e) { console.error(`⚠️ Failed to persist expiry warning for ${key}:`, e); }
            const daysLeft = Math.ceil((expiresAtMs - now) / (24 * 60 * 60 * 1000));
            console.log(`⏳ License expiring in ${daysLeft} day(s) for device: ${hardwareId} (key ${key})`);
            if (panel && panel.socket_id) {
                const msg = `Your license expires in ${daysLeft} day(s). Contact your administrator to renew.`;
                io.to(panel.socket_id).emit('mdm_execute', { action: 'LICENSE_EXPIRING', message: msg, text: msg });
            }
        }
    }
}
setInterval(checkLicenseExpiries, 60 * 60 * 1000); // hourly is plenty for day-granularity expiry

// ==========================================
// 🛠️ INTERNAL NETWORK UTILITY PROXIES
// ==========================================
function httpsRequest(options) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve({ statusCode: res.statusCode, body }));
        });
        req.on('error', err => reject(err));
        req.end();
    });
}

function b2PostJson(urlStr, token, payload) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const data = JSON.stringify(payload);
        const options = {
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Authorization': token,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        };
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve(JSON.parse(body)));
        });
        req.on('error', err => reject(err));
        req.write(data);
        req.end();
    });
}

(async () => {
    try {
        await initDb();
        await loadState();
    } catch (e) {
        console.error("❌ Startup failed while initializing/loading persistence:", e);
    }
    server.listen(PORT, () => {
        console.log(`🚀 INEUU Slate Backbone online and running securely on Port ${PORT}`);
    });
    // Don't make a freshly-deployed server wait a full hour before its first expiry sweep.
    checkLicenseExpiries().catch(e => console.error("⚠️ Initial license expiry check failed:", e));
})();