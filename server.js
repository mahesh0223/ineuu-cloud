// Disable Node 24 "Happy Eyeballs" — fixed the connect timeouts to B2 earlier
const net = require("net");
net.setDefaultAutoSelectFamily(false);

const express = require("express");
const cors = require("cors");
const https = require("https");
const crypto = require("crypto");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// 🌐 Create standard HTTP server and wrap it with Socket.IO
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

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
// 📦 STORAGE / UPLOAD ENDPOINT (Native B2)
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
// 📱 WEB-SOCKET LIVE DEVICE MANAGEMENT (MDM)
// ==========================================

// ZERO DUMMY PANELS. Devices register here instantly via WebSockets.
let connectedPanels = {};

io.on('connection', (socket) => {
    console.log(`🔌 Incoming Socket connection: ${socket.id}`);

    // 1. Android APK sends this event on connection
    socket.on('register_panel', (data) => {
        const { hardware_id, school_id } = data;
        
        if (!hardware_id) return;

        // Map the hardware ID to the specific WebSocket connection
        connectedPanels[hardware_id] = {
            school_id: school_id || "Unassigned Device",
            socket_id: socket.id,
            status: "ONLINE",
            lastSeen: Date.now()
        };
        console.log(`✨ Panel Registered Live: ${hardware_id}`);
    });

    // 2. Automatically clean up when an Android panel goes offline (app closed/wifi dropped)
    socket.on('disconnect', () => {
        for (const [hwId, panelData] of Object.entries(connectedPanels)) {
            if (panelData.socket_id === socket.id) {
                console.log(`💀 Panel Disconnected: ${hwId}`);
                delete connectedPanels[hwId]; // Remove from dashboard instantly
                break;
            }
        }
    });
});

/**
 * 3. DASHBOARD GET DEVICES ENDPOINT
 * Dashboard calls this via HTTP GET to render the online cards.
 */
app.get('/api/mdm/panels', (req, res) => {
    res.json(connectedPanels);
});

/**
 * 4. DASHBOARD SEND COMMAND ENDPOINT
 * Control panel uses this to assign orders. We pipe it straight into the WebSocket.
 */
app.post('/api/mdm/command', (req, res) => {
    const { target_hardware_id, action, message } = req.body;
    
    if (!connectedPanels[target_hardware_id]) {
        return res.status(404).json({ success: false, message: "Device is offline or not registered." });
    }

    const panelSocketId = connectedPanels[target_hardware_id].socket_id;

    // Send the command directly down the live socket connection to that specific board
    io.to(panelSocketId).emit('mdm_execute', {
        action: action,
        message: message,
        payload: { text: message } 
    });

    // Update the server's local state for the dashboard UI
    if (action === "LOCK") connectedPanels[target_hardware_id].status = "LOCKED";
    if (action === "UNLOCK") connectedPanels[target_hardware_id].status = "ONLINE";

    console.log(`🚀 Sent ${action} to ${target_hardware_id}`);
    res.json({ success: true, message: `Command [${action}] transmitted securely to device.` });
});

// 🔥 MUST USE server.listen INSTEAD OF app.listen FOR WEBSOCKETS TO BIND!
server.listen(PORT, () => console.log(`🚀 Native B2 + WebSockets Server online on port ${PORT}`));