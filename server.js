const express = require("express");
const cors = require("cors");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();
const PORT = process.env.PORT || 3000;

// ----------------------------------------------------
// MIDDLEWARE CONFIGURATION
// ----------------------------------------------------
app.use(cors());
app.use(express.json());

// ----------------------------------------------------
// BACKBLAZE B2 PRIVATE STORAGE CONFIGURATION
// ----------------------------------------------------
const s3 = new S3Client({
    region: "us-east-005", 
    endpoint: "https://s3.us-east-005.backblazeb2.com", 
    credentials: {
        accessKeyId: "005a1feb14f280f000000001",         
        secretAccessKey: "K005FTq+WQ6QDtVwCyAzImUXu1laVvA", 
    }
});

// ----------------------------------------------------
// MDM FLEET TELEMETRY DATA (In-Memory Database Mock)
// ----------------------------------------------------
// This mock matches the school panel data your dashboard displays
let connectedPanels = {
    "HW_ID_BOARD_01": { school_id: "Oakridge_High_Class_A", status: "LOCKED" },
    "HW_ID_BOARD_02": { school_id: "Greenwood_Academy_Lab", status: "UNLOCKED" }
};

// ----------------------------------------------------
// STORAGE ENDPOINTS (Secure VIP Upload & Download Tunnels)
// ----------------------------------------------------

// 1. Generate a temporary, secure UPLOAD link for the browser dashboard
app.get('/api/storage/upload-url', async (req, res) => {
    try {
        const { fileName, fileType } = req.query;
        // Sanitizes filenames by stripping spaces and prepending a timestamp
        const safeName = `asset-${Date.now()}-${(fileName || 'file').replace(/\s+/g, '-')}`; 
        
        const command = new PutObjectCommand({
            Bucket: "ineuu-assets", 
            Key: safeName,
            ContentType: fileType || "application/octet-stream" 
        });

        const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 }); // Valid for 1 hour
        
        res.json({ 
            success: true, 
            uploadUrl: signedUrl, 
            fileNameKey: safeName 
        });
    } catch (error) {
        console.error("Upload URL Generation Error:", error);
        res.status(500).json({ success: false, message: "Upload storage tunnel failure" });
    }
});

// 2. Generate a secure DOWNLOAD link from your private bucket
app.get('/api/storage/download-url/:fileName', async (req, res) => {
    try {
        const { fileName } = req.params;
        
        const command = new GetObjectCommand({
            Bucket: "ineuu-assets",
            Key: fileName
        });

        const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 }); // Valid for 1 hour
        
        res.json({ success: true, downloadUrl: signedUrl });
    } catch (error) {
        console.error("Download URL Generation Error:", error);
        res.status(500).json({ success: false, message: "Download storage tunnel failure" });
    }
});

// ----------------------------------------------------
// MDM SMARTBOARD COMMAND & CONTROL ENDPOINTS
// ----------------------------------------------------

// 1. Fetch live status of all online classroom panels
app.get('/api/mdm/panels', (req, res) => {
    res.json(connectedPanels);
});

// 2. Send commands (LOCK/UNLOCK) directly to a target smartboard
app.post('/api/mdm/command', (req, res) => {
    const { target_hardware_id, action } = req.body;
    
    if (!target_hardware_id || !action) {
        return res.status(400).json({ success: false, message: "Missing hardware ID or action command." });
    }

    if (connectedPanels[target_hardware_id]) {
        // Update local state to reflect dashboard actions
        connectedPanels[target_hardware_id].status = action === "LOCK" ? "LOCKED" : "UNLOCKED";
        console.log(`[MDM Command Routed] Board ${target_hardware_id} status changed to ${action}`);
        
        // This is where your WebSocket/MQTT push logic to the Android board goes
        res.json({ success: true, message: `Command ${action} successfully transmitted to device.` });
    } else {
        res.status(404).json({ success: false, message: "Target board is currently offline or unreachable." });
    }
});

// ----------------------------------------------------
// ERROR HANDLING & SERVER START
// ----------------------------------------------------
app.use((req, res) => {
    res.status(404).json({ success: false, message: "Endpoint node not found on Ineuu Server." });
});

app.listen(PORT, () => {
    console.log(`🚀 INEUU Core Engine running smoothly on port ${PORT}`);
});