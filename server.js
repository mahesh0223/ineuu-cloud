const express = require("express");
const cors = require("cors");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const s3pkg = require("@aws-sdk/client-s3/package.json");
console.log("🔎 RUNNING @aws-sdk/client-s3 version:", s3pkg.version);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const s3 = new S3Client({
    region: "us-east-005",
    endpoint: "https://s3.us-east-005.backblazeb2.com",
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: {
        accessKeyId: "005a1feb14f280f0000000002",
        secretAccessKey: "K0053/IZi6tKktciH/D/nJlbKiPw9oU",
    }
});

app.post('/api/storage/upload-direct', async (req, res) => {
    try {
        const { fileName, fileType, fileData } = req.body;

        if (!fileData) {
            return res.status(400).json({ success: false, message: "No file data received." });
        }

        const buffer = Buffer.from(fileData, 'base64');
        const cleanName = (fileName || 'file').replace(/[^a-zA-Z0-9.-]/g, "_");
        const safeName = `asset-${Date.now()}-${cleanName}`;

        // SDK signs and uploads in one step — no presign, no raw https, no signature mismatch
        await s3.send(new PutObjectCommand({
            Bucket: "ineuu-assets",
            Key: safeName,
            Body: buffer,
            ContentType: fileType || "application/octet-stream"
        }));

        // Presigned GET for the download link (this part was always fine)
        const readCommand = new GetObjectCommand({
            Bucket: "ineuu-assets",
            Key: safeName,
            ResponseContentType: fileType || "application/octet-stream"
        });
        const downloadUrl = await getSignedUrl(s3, readCommand, { expiresIn: 3600 });

        res.json({ success: true, downloadUrl });
    } catch (error) {
        console.error("Direct Upload Failure:", error);
        res.status(500).json({
            success: false,
            message: "Server upload failed.",
            errorDetail: error.message || String(error)
        });
    }
});

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