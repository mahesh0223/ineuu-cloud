const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

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

// Live runtime cache for connected screens. This used to be purely in-memory, so every
// server restart or redeploy wiped the entire fleet's registry and the dashboard showed
// "no IFPD online" until every board happened to reconnect. Persisting it to disk means a
// restart at least remembers which devices exist (marked OFFLINE until they truly
// reconnect) instead of forgetting the fleet outright.
//
// CAVEAT: Render's free/starter web service tier uses an ephemeral filesystem - this file
// does NOT survive a redeploy or a move to a new container, only in-process restarts/crashes
// on the same instance. For real persistence across redeploys at 12,000-device scale, this
// needs to move to a real database (e.g. Postgres/Redis), not a JSON file.
const PANELS_FILE = './connected_panels.json';
let connectedPanels = {};
if (fs.existsSync(PANELS_FILE)) {
    try {
        connectedPanels = JSON.parse(fs.readFileSync(PANELS_FILE));
        for (const id in connectedPanels) connectedPanels[id].status = "OFFLINE";
        console.log(`♻️ Restored ${Object.keys(connectedPanels).length} known panel(s) from disk (marked OFFLINE pending reconnect).`);
    } catch (e) {
        console.error("⚠️ Failed to parse persisted panels file, starting fresh...", e);
        connectedPanels = {};
    }
}

let panelsSaveTimeout = null;
function savePanelsDebounced() {
    if (panelsSaveTimeout) return;
    panelsSaveTimeout = setTimeout(() => {
        panelsSaveTimeout = null;
        fs.writeFile(PANELS_FILE, JSON.stringify(connectedPanels, null, 2), (err) => {
            if (err) console.error("⚠️ Failed to persist panels file:", err);
        });
    }, 2000);
}

// ==========================================
// 🔑 ENTERPRISE KEY GENERATOR & DATABASE
// ==========================================
const KEYS_FILE = './license_keys.json';
let validLicenseKeys = {};

// Self-healing database load
if (fs.existsSync(KEYS_FILE)) {
    try {
        validLicenseKeys = JSON.parse(fs.readFileSync(KEYS_FILE));
    } catch (e) {
        console.error("⚠️ Failed to parse keys file, resetting...", e);
        validLicenseKeys = {};
    }
} else {
    fs.writeFileSync(KEYS_FILE, JSON.stringify({}));
}

// 🛠️ ADMIN API: Dynamic Key Generator
app.post('/api/admin/generate-keys', (req, res) => {
    if (!ADMIN_PASSWORD) {
        return res.status(503).json({ success: false, message: "Admin key generation is disabled: ADMIN_PASSWORD is not configured on the server." });
    }

    const { count, adminPassword } = req.body;

    if (adminPassword !== ADMIN_PASSWORD) {
        return res.status(403).json({ success: false, message: "Unauthorized Admin Password." });
    }

    const newKeys = [];
    const numToGenerate = count || 10;

    for (let i = 0; i < numToGenerate; i++) {
        const chunk1 = crypto.randomBytes(2).toString('hex').toUpperCase();
        const chunk2 = crypto.randomBytes(2).toString('hex').toUpperCase();
        const chunk3 = crypto.randomBytes(2).toString('hex').toUpperCase();
        const newKey = `INEUU-${chunk1}-${chunk2}-${chunk3}`;
        
        validLicenseKeys[newKey] = { 
            isUsed: false, 
            linkedDevice: null, 
            createdAt: new Date().toISOString() 
        };
        newKeys.push(newKey);
    }

    fs.writeFileSync(KEYS_FILE, JSON.stringify(validLicenseKeys, null, 2));
    console.log(`🛠️ Admin generated ${numToGenerate} new license keys.`);
    res.json({ success: true, generatedKeys: newKeys });
});

// 📺 IFPD API: Hardware Activation Router
app.post('/api/mdm/activate', (req, res) => {
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

    keyRecord.isUsed = true;
    keyRecord.linkedDevice = hardwareId;
    keyRecord.activatedAt = new Date().toISOString();
    
    fs.writeFileSync(KEYS_FILE, JSON.stringify(validLicenseKeys, null, 2));

    console.log(`🔐 Board verified! Hardware ID: ${hardwareId} bound permanently to Key: ${cleanKey}`);
    return res.json({ success: true, message: "Device license validated successfully." });
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
app.post('/api/mdm/command', (req, res) => {
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

app.get('/api/mdm/devices', (req, res) => {
    res.json(connectedPanels);
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
            socket_id: socket.id,
            status: "ONLINE",
            telemetry: { cpuTemp: "⚡", storage: "Reading...", wifi: "Connected" },
            lastSeen: Date.now()
        };
        console.log(`🖥️ Screen Terminal Authenticated and Cataloged: ${hardware_id}`);
        savePanelsDebounced();
    });

    socket.on('telemetry_update', (data) => {
        const { hardware_id, telemetry } = data;

        if (connectedPanels[hardware_id]) {
            connectedPanels[hardware_id].telemetry = telemetry;
            connectedPanels[hardware_id].lastSeen = Date.now();
            if (connectedPanels[hardware_id].status === "OFFLINE") {
                connectedPanels[hardware_id].status = "ONLINE";
            }
        } else {
            // 🔥 THE RENDER REBOOT AMNESIA PROTECTION PATCH 🔥
            connectedPanels[hardware_id] = {
                school_id: "INEUU_Board_" + hardware_id,
                socket_id: socket.id,
                status: "ONLINE",
                telemetry: telemetry || { cpuTemp: "N/A", storage: "N/A", wifi: "N/A" },
                lastSeen: Date.now()
            };
            console.log(`♻️ Cluster memory self-healed. Restored Active Panel Node: ${hardware_id}`);
        }
        savePanelsDebounced();
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
                savePanelsDebounced();
                break;
            }
        }
    });
});

// Sweeper function to flag lost boards
setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const id in connectedPanels) {
        if (connectedPanels[id].status !== "OFFLINE" && now - connectedPanels[id].lastSeen > 35000) {
            connectedPanels[id].status = "OFFLINE";
            changed = true;
        }
    }
    if (changed) savePanelsDebounced();
}, 15000);

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

server.listen(PORT, () => {
    console.log(`🚀 INEUU Slate Backbone online and running securely on Port ${PORT}`);
});