// Disable Node 24 "Happy Eyeballs" — fixed the connect timeouts to B2 earlier
const net = require("net");
net.setDefaultAutoSelectFamily(false);

const express = require("express");
const cors = require("cors");
const https = require("https");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// --- Backblaze credentials ---
const B2_KEY_ID = "005a1feb14f280f0000000003";
const B2_APP_KEY = "K005DioSft/X8yJr87gDZXNNQJrd10Y";
const B2_BUCKET_NAME = "ineuu-assets";

// --- Small https helper: resolves { statusCode, body } for any request ---
function httpsRequest(options, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

async function b2PostJson(fullUrl, token, payload) {
    const u = new URL(fullUrl);
    const body = JSON.stringify(payload);
    const res = await httpsRequest({
        hostname: u.hostname,
        path: u.pathname,
        method: 'POST',
        headers: {
            Authorization: token,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
        }
    }, body);
    if (res.statusCode !== 200) throw new Error(`B2 ${u.pathname} [${res.statusCode}]: ${res.body}`);
    return JSON.parse(res.body);
}

// ==========================================
// 📦 STORAGE / UPLOAD ENDPOINT
// ==========================================
app.post('/api/storage/upload-direct', async (req, res) => {
    try {
        const { fileName, fileType, fileData } = req.body;
        if (!fileData) {
            return res.status(400).json({ success: false, message: "No file data received." });
        }

        const buffer = Buffer.from(fileData, 'base64');
        const cleanName = (fileName || 'file').replace(/[^a-zA-Z0-9.-]/g, "_");
        const safeName = `asset-${Date.now()}-${cleanName}`;
        console.log(`📦 Uploading ${safeName} | size: ${buffer.length} bytes`);

        const basic = Buffer.from(`${B2_KEY_ID}:${B2_APP_KEY}`).toString('base64');
        const authRes = await httpsRequest({
            hostname: 'api.backblazeb2.com',
            path: '/b2api/v3/b2_authorize_account',
            method: 'GET',
            headers: { Authorization: `Basic ${basic}` }
        });
        if (authRes.statusCode !== 200) throw new Error(`b2_authorize_account [${authRes.statusCode}]: ${authRes.body}`);
        const auth = JSON.parse(authRes.body);

        const storageApi = (auth.apiInfo && auth.apiInfo.storageApi) || auth;
        const apiUrl = storageApi.apiUrl;
        const downloadUrl = storageApi.downloadUrl;
        const accountToken = auth.authorizationToken;

        let bucketId = storageApi.bucketId || (auth.allowed && auth.allowed.bucketId);
        if (!bucketId) {
            const list = await b2PostJson(`${apiUrl}/b2api/v3/b2_list_buckets`, accountToken, {
                accountId: auth.accountId,
                bucketName: B2_BUCKET_NAME
            });
            if (!list.buckets || !list.buckets.length) throw new Error(`Bucket "${B2_BUCKET_NAME}" not found`);
            bucketId = list.buckets[0].bucketId;
        }

        const up = await b2PostJson(`${apiUrl}/b2api/v3/b2_get_upload_url`, accountToken, { bucketId });

        const sha1 = crypto.createHash('sha1').update(buffer).digest('hex');
        const upUrl = new URL(up.uploadUrl);
        const uploadRes = await httpsRequest({
            hostname: upUrl.hostname,
            path: upUrl.pathname + upUrl.search,
            method: 'POST',
            headers: {
                Authorization: up.authorizationToken,
                'X-Bz-File-Name': encodeURIComponent(safeName),
                'Content-Type': fileType || 'application/octet-stream',
                'Content-Length': buffer.length,
                'X-Bz-Content-Sha1': sha1
            }
        }, buffer);
        if (uploadRes.statusCode !== 200) throw new Error(`b2_upload_file [${uploadRes.statusCode}]: ${uploadRes.body}`);

        const dl = await b2PostJson(`${apiUrl}/b2api/v3/b2_get_download_authorization`, accountToken, {
            bucketId,
            fileNamePrefix: safeName,
            validDurationInSeconds: 3600
        });
        const link = `${downloadUrl}/file/${B2_BUCKET_NAME}/${encodeURIComponent(safeName)}?Authorization=${dl.authorizationToken}`;

        console.log(`✅ DONE: ${safeName}`);
        res.json({ success: true, downloadUrl: link });
    } catch (error) {
        console.error("Direct Upload Failure:", error);
        res.status(500).json({
            success: false,
            message: "Server upload failed.",
            errorDetail: error.message || String(error)
        });
    }
});

// ==========================================
// 📱 DYNAMIC LIVE DEVICE MANAGEMENT (MDM)
// ==========================================

// ZERO DUMMY PANELS. Devices fill this object live when they check in.
let connectedPanels = {};

/**
 * 1. HEARTBEAT / REGISTRATION ENDPOINT (For the APK / Phone app)
 * Your Android APK/Phone app should POST to this every 3–5 seconds.
 * * Payload from APK: { "hardware_id": "UNIQUE_DEVICE_ID", "school_id": "Room_404_IFPD" }
 */
app.post('/api/mdm/panel/heartbeat', (req, res) => {
    const { hardware_id, school_id } = req.body;

    if (!hardware_id) {
        return res.status(400).json({ success: false, message: "Missing hardware_id" });
    }

    // If the device is checking in for the first time, register it globally
    if (!connectedPanels[hardware_id]) {
        console.log(`✨ New Device Registered Live: ${hardware_id}`);
        connectedPanels[hardware_id] = {
            school_id: school_id || "Unassigned Device",
            status: "UNLOCKED",
            pendingAnnouncement: null,
            clearCanvasTriggered: false,
            lastSeen: Date.now()
        };
    } else {
        // Just update timestamp and school_id label if it changed
        connectedPanels[hardware_id].lastSeen = Date.now();
        if (school_id) connectedPanels[hardware_id].school_id = school_id;
    }

    // Immediately reply to the APK with any commands queued by the dashboard admin
    res.json({
        success: true,
        status: connectedPanels[hardware_id].status,
        pendingAnnouncement: connectedPanels[hardware_id].pendingAnnouncement,
        clearCanvasTriggered: connectedPanels[hardware_id].clearCanvasTriggered
    });
});

/**
 * 2. ACKNOWLEDGE COMMAND ENDPOINT (For the APK)
 * Once the APK reads an announcement or clears its canvas, it calls this to tell the server "I did it, clear the flag".
 */
app.post('/api/mdm/panel/acknowledge', (req, res) => {
    const { hardware_id, clearedAnnouncement, clearedCanvas } = req.body;
    
    if (connectedPanels[hardware_id]) {
        if (clearedAnnouncement) connectedPanels[hardware_id].pendingAnnouncement = null;
        if (clearedCanvas) connectedPanels[hardware_id].clearCanvasTriggered = false;
        return res.json({ success: true, message: "State cleared on server." });
    }
    res.status(404).json({ success: false, message: "Device profile not found." });
});

/**
 * 3. DASHBOARD GET DEVICES ENDPOINT
 * Dashboard calls this via GET to render the online cards.
 */
app.get('/api/mdm/panels', (req, res) => {
    // Optional: Auto-remove devices that haven't sent a heartbeat in over 20 seconds (offline)
    const now = Date.now();
    Object.keys(connectedPanels).forEach(id => {
        if (now - connectedPanels[id].lastSeen > 20000) {
            console.log(`💀 Device disconnected (Timeout): ${id}`);
            delete connectedPanels[id];
        }
    });

    res.json(connectedPanels);
});

/**
 * 4. DASHBOARD SEND COMMAND ENDPOINT
 * Control panel uses this to assign orders to the live devices.
 */
app.post('/api/mdm/command', (req, res) => {
    const { target_hardware_id, action, message } = req.body;
    
    if (!connectedPanels[target_hardware_id]) {
        return res.status(404).json({ success: false, message: "Device is offline or not registered." });
    }

    const panel = connectedPanels[target_hardware_id];

    switch (action) {
        case "LOCK":
            panel.status = "LOCKED";
            break;
        case "UNLOCK":
            panel.status = "UNLOCKED";
            break;
        case "ANNOUNCEMENT":
            panel.pendingAnnouncement = message || "Attention: Administrative broadcast.";
            break;
        case "CLEAR_CANVAS":
            panel.clearCanvasTriggered = true;
            break;
        default:
            return res.status(400).json({ success: false, message: "Invalid action." });
    }

    res.json({ success: true, message: `Command [${action}] sent. waiting for device synchronization.` });
});

app.listen(PORT, () => console.log(`🚀 Live Device Matrix Suite online on port ${PORT}`));