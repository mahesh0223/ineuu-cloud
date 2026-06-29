const express = require("express");
const cors = require("cors");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware Configuration
app.use(cors());
app.use(express.json());

// Backblaze B2 Client Initialization with your verified Master Credentials
const s3 = new S3Client({
    region: "us-east-005", 
    endpoint: "https://s3.us-east-005.backblazeb2.com", 
    credentials: {
        accessKeyId: "005a1feb14f280f0000000002",         
        secretAccessKey: "K0053/IZi6tKktciH/D/nJlbKiPw9oU", 
    }
});

// Mock Fleet Telemetry Dataset
let connectedPanels = {
    "HW_ID_BOARD_01": { school_id: "Oakridge_High_Class_A", status: "LOCKED" },
    "HW_ID_BOARD_02": { school_id: "Greenwood_Academy_Lab", status: "UNLOCKED" }
};

// 1. Generate secure direct browser upload URL signatures
app.get('/api/storage/upload-url', async (req, res) => {
    try {
        const { fileName, fileType } = req.query;
        // Strip spaces and special characters cleanly to keep signatures valid
        const cleanName = (fileName || 'file').replace(/[^a-zA-Z0-9.]/g, "-");
        const safeName = `asset-${Date.now()}-${cleanName}`; 
        
        const command = new PutObjectCommand({
            Bucket: "ineuu-assets", 
            Key: safeName,
            ContentType: fileType || "application/octet-stream"
        });

        // Generate the upload url handshake ticket
        const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 }); 
        
        res.json({ 
            success: true, 
            uploadUrl: signedUrl, 
            fileNameKey: safeName 
        });
    } catch (error) {
        console.error("Signature Ticket Generation Failure:", error);
        res.status(500).json({ success: false, message: "Internal cloud server signer error" });
    }
});

// 2. Generate secure temporary private read download links
app.get('/api/storage/download-url/:fileName', async (req, res) => {
    try {
        const { fileName } = req.params;
        
        const command = new GetObjectCommand({
            Bucket: "ineuu-assets",
            Key: fileName
        });

        const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 }); 
        res.json({ success: true, downloadUrl: signedUrl });
    } catch (error) {
        console.error("Read Token Generation Error:", error);
        res.status(500).json({ success: false, message: "Download key negotiation failure" });
    }
});

// MDM Device Cluster Control Hooks
app.get('/api/mdm/panels', (req, res) => {
    res.json(connectedPanels);
});

app.post('/api/mdm/command', (req, res) => {
    const { target_hardware_id, action } = req.body;
    if (connectedPanels[target_hardware_id]) {
        connectedPanels[target_hardware_id].status = action === "LOCK" ? "LOCKED" : "UNLOCKED";
        res.json({ success: true, message: `Command transmitted successfully.` });
    } else {
        res.status(404).json({ success: false, message: "Device offline." });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Core system online and listening on port ${PORT}`);
});