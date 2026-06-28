// key_maker.js - INEUU Enterprise License Generator
const crypto = require('crypto');

// ⚠️ IMPORTANT: This MUST exactly match the MASTER_SECRET inside your Android app
const MASTER_SECRET = "INEUU_ENTERPRISE_SECRET_2026";

// Change this to the specific Hardware ID of the board you are selling
const hardwareId = "IFPD-8829-X"; 

// 1. Mathematically hash the Hardware ID using your Master Secret
const hash = crypto.createHmac('sha256', MASTER_SECRET)
                   .update(hardwareId)
                   .digest('hex')
                   .toUpperCase();

// 2. Grab the first 16 characters
const rawKey = hash.substring(0, 16);

// 3. Format it beautifully with dashes (XXXX-XXXX-XXXX-XXXX)
const formattedKey = rawKey.match(/.{1,4}/g).join('-');

console.log("\n====================================");
console.log("   INEUU ENTERPRISE KEY GENERATOR   ");
console.log("====================================");
console.log("Hardware ID : " + hardwareId);
console.log("Product Key : " + formattedKey);
console.log("====================================\n");