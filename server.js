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
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "INEUU_MASTER_ADMIN_2026";

// Live runtime cache for connected screens
let connectedPanels = {};

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
    console.log(`📡 Broadcast Request Received -> Target ID: ${hardware_id || 'ALL'}, Action: ${action}`);

    if (hardware_id) {
        const panel = connectedPanels[hardware_id];
        if (panel) {
            io.to(panel.socket_id).emit('mdm_execute', { action, text });
            if (action === "OTA_UPDATE") panel.status = "UPDATING SYSTEM...";
            return res.json({ success: true, message: `Dispatched ${action} successfully to targeted screen layout context.` });
        }
        return res.status(404).json({ success: false, message: "Target terminal array hardware matrix currently unmapped." });
    } else {
        io.emit('mdm_execute', { action, text });
        return res.json({ success: true, message: `Dispatched broad command sequence array globally.` });
    }
});

app.get('/api/mdm/devices', (req, res) => {
    res.json(Object.values(connectedPanels));
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
    });

    socket.on('disconnect', () => {
        for (const id in connectedPanels) {
            if (connectedPanels[id].socket_id === socket.id) {
                connectedPanels[id].status = "OFFLINE";
                console.log(`⚠️ Panel drop alert context triggered. Socket pipeline lost: ${id}`);
                break;
            }
        }
    });
});

// Sweeper function to flag lost boards
setInterval(() => {
    const now = Date.now();
    for (const id in connectedPanels) {
        if (now - connectedPanels[id].lastSeen > 35000) { 
            connectedPanels[id].status = "OFFLINE";
        }
    }
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