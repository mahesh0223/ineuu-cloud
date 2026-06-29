const express = require("express");
const cors = require("cors");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

const s3 = new S3Client({
    region: "us-east-005", 
    endpoint: "https://s3.us-east-005.backblazeb2.com", 
    forcePathStyle: true, 
    credentials: {
        accessKeyId: "005a1feb14f280f0000000002",         
        secretAccessKey: "K0053/IZi6tKktciH/D/nJlbKiPw9oU", 
    }
});

app.post('/api/storage/upload-direct', express.raw({ type: '*/*', limit: '100mb' }), async (req, res) => {
    try {
        if (!req.body || req.body.length === 0) {
            return res.status(400).json({ success: false, message: "Server received an empty file." });
        }

        const { fileName, fileType } = req.query;
        const cleanName = (fileName || 'file').replace(/[^a-zA-Z0-9.-]/g, "_");
        const safeName = `asset-${Date.now()}-${cleanName}`;
        const contentType = fileType || "application/octet-stream";
        
        // 1. Ask the SDK to ONLY generate the secure URL (Do not let it upload!)
        const command = new PutObjectCommand({
            Bucket: "ineuu-assets", 
            Key: safeName,
            ContentType: contentType
        });
        const signedUploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 }); 
        
        // 2. BYPASS THE SDK ENTIRELY. Use standard Node.js to push the raw bytes.
        const uploadRes = await fetch(signedUploadUrl, {
            method: 'PUT',
            headers: {
                'Content-Type': contentType,
                'Content-Length': req.body.length.toString()
            },
            body: req.body
        });

        if (!uploadRes.ok) {
            const errorText = await uploadRes.text();
            console.error("Backblaze Native Rejection:", uploadRes.status, errorText);
            throw new Error("Native upload failed.");
        }
        
        // 3. Generate the secure read link
        const readCommand = new GetObjectCommand({ Bucket: "ineuu-assets", Key: safeName });
        const downloadUrl = await getSignedUrl(s3, readCommand, { expiresIn: 3600 }); 
        
        res.json({ success: true, downloadUrl });
    } catch (error) {
        console.error("Direct Upload Failure:", error);
        res.status(500).json({ success: false, message: "Server upload failed." });
    }
});

app.use(express.json()); 

let connectedPanels = {
    "HW_ID_BOARD_01": { school_id: "Oakridge_High_Class_A", status: "LOCKED" },
    "HW_ID_BOARD_02": { school_id: "Greenwood_Academy_Lab", status: "UNLOCKED" }
};

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