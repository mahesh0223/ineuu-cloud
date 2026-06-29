const express = require("express");
const cors = require("cors");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const s3 = new S3Client({
    region: "us-east-005", 
    endpoint: "https://s3.us-east-005.backblazeb2.com", 
    forcePathStyle: true, 
    requestChecksumCalculation: "WHEN_REQUIRED", 
    credentials: {
        accessKeyId: "005a1feb14f280f0000000002",         
        secretAccessKey: "K0053/IZi6tKktciH/D/nJlbKiPw9oU", 
    }
});

let connectedPanels = {
    "HW_ID_BOARD_01": { school_id: "Oakridge_High_Class_A", status: "LOCKED" },
    "HW_ID_BOARD_02": { school_id: "Greenwood_Academy_Lab", status: "UNLOCKED" }
};

app.get('/api/storage/upload-url', async (req, res) => {
    try {
        const { fileName } = req.query;
        const cleanName = (fileName || 'file').replace(/[^a-zA-Z0-9.-]/g, "_");
        const safeName = `asset-${Date.now()}-${cleanName}`; 
        
        const command = new PutObjectCommand({
            Bucket: "ineuu-assets", 
            Key: safeName
            // 🔥 ContentType requirement REMOVED to prevent signature mismatch
        });

        const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 }); 
        res.json({ success: true, uploadUrl: signedUrl, fileNameKey: safeName });
    } catch (error) {
        console.error("Signature Ticket Generation Failure:", error);
        res.status(500).json({ success: false, message: "Internal cloud server signer error" });
    }
});

app.get('/api/storage/download-url/:fileName', async (req, res) => {
    try {
        const { fileName } = req.params;
        const command = new GetObjectCommand({ Bucket: "ineuu-assets", Key: fileName });
        const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 }); 
        res.json({ success: true, downloadUrl: signedUrl });
    } catch (error) {
        console.error("Read Token Generation Error:", error);
        res.status(500).json({ success: false, message: "Download key negotiation failure" });
    }
});

app.get('/api/mdm/panels', (req, res) => res.json(connectedPanels));

app.post('/api/mdm/command', (req, res) => {
    const { target_hardware_id, action } = req.body;
    if (connectedPanels[target_hardware_id]) {
        connectedPanels[target_hardware_id].status = action === "LOCK" ? "LOCKED" : "UNLOCKED";
        res.json({ success: true, message: `Command transmitted.` });
    } else {
        res.status(404).json({ success: false, message: "Device offline." });
    }
});

app.listen(PORT, () => console.log(`🚀 Core system online on port ${PORT}`));