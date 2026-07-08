const BUCKET_ID = "1ac14f3ecb91141f92f8001f"; 

const MASTER_KEY_ID = "a1feb14f280f";
const MASTER_APP_KEY = "005fd73582580481087942692d5670b6e4eea029c4";

async function unlockCORS() {
    try {
        console.log("⏳ 1/2: Authenticating with Backblaze Native API...");
        const auth = Buffer.from(`${MASTER_KEY_ID}:${MASTER_APP_KEY}`).toString('base64');

        const authRes = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
            headers: { 'Authorization': `Basic ${auth}` }
        });
        const authData = await authRes.json();

        if (!authData.authorizationToken) {
            console.log("❌ Auth Failed:", authData);
            return;
        }

        console.log("🔓 2/2: Injecting strict Upload CORS rules...");
        const updateRes = await fetch(`${authData.apiUrl}/b2api/v2/b2_update_bucket`, {
            method: 'POST',
            headers: {
                'Authorization': authData.authorizationToken,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                accountId: authData.accountId,
                bucketId: BUCKET_ID,
                corsRules: [
                    {
                        corsRuleName: "Allow-Direct-Uploads",
                        allowedOrigins: ["*"],
                        allowedOperations: ["s3_put", "s3_post", "s3_get", "s3_head", "b2_upload_file"],
                        allowedHeaders: ["*"],
                        exposeHeaders: ["ETag"],
                        maxAgeSeconds: 3600
                    }
                ]
            })
        });

        const updateData = await updateRes.json();
        if (updateData.corsRules) {
            console.log("✅ MASSIVE SUCCESS! Your bucket is permanently unlocked for browser uploads.");
        } else {
            console.error("❌ Failed:", updateData);
        }

    } catch (error) {
        console.error("❌ Script Error:", error);
    }
}

unlockCORS();