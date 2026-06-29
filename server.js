const express = require("express");
const cors = require("cors");
const https = require("https"); 
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' })); 

const s3 = new S3Client({
    region: "us-east-005", 
    endpoint: "https://s3.us-east-005.backblazeb2.com", 
    forcePathStyle: true, 
    // 🔥 THESE LINES STOP THE "AAAAAA==" EMPTY FILE BUG 🔥
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
        const contentType = fileType || "application/octet-stream";
        
        const command = new PutObjectCommand({
            Bucket: "ineuu-assets", 
            Key: safeName,
            ContentType: contentType
        });
        const signedUploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 }); 
        
        await new Promise((resolve, reject) => {
            const request = https.request(signedUploadUrl, {
                method: 'PUT',
                headers: {
                    'Content-Type': contentType,
                    'Content-Length': buffer.length
                }
            }, (response) => {
                if (response.statusCode >= 200 && response.statusCode < 300) {
                    resolve(); 
                } else {
                    // Grab the exact Backblaze rejection reason if it fails
                    let errorBody = '';
                    response.on('data', chunk => errorBody += chunk);
                    response.on('end', () => {
                        console.error("Backblaze Rejection XML:", errorBody);
                        reject(new Error(`Backblaze rejected upload with status: ${response.statusCode}`));
                    });
                }
            });

            request.on('error', (err) => reject(err));
            request.write(buffer); 
            request.end();         
        });
        
        const readCommand = new GetObjectCommand({ Bucket: "ineuu-assets", Key: safeName });
        const downloadUrl = await getSignedUrl(s3, readCommand, { expiresIn: 3600 }); 
        
        res.json({ success: true, downloadUrl });
    } catch (error) {
        console.error("Direct Upload Failure:", error);
        res.status(500).json({ success: false, message: "Server upload failed." });
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