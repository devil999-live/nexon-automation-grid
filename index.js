const { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const QRCodeLib = require('qrcode');
const express = require('express');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const multer = require('multer');
const https = require('https');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Configure Multer for multiple file uploads (up to 10 files)
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

let sock;
let botConnectionStatus = 'disconnected';
let latestQR = ""; 

// --- INDEPENDENT TELEGRAM LOGGER CONFIGURATION ---
const TG_CONFIG_FILE = path.join(__dirname, 'telegram_config.json');
let tgConfig = {
    enabled: false,
    botToken: '8654106704:AAHSbhQ5oy9Wb9pWdQzCC_sNzvDmOdYkzr4',
    chatId: '6670344997'
};

if (fs.existsSync(TG_CONFIG_FILE)) {
    try {
        const loaded = JSON.parse(fs.readFileSync(TG_CONFIG_FILE, 'utf8'));
        tgConfig = { ...tgConfig, ...loaded };
        console.log('[TG Config] Loaded Telegram configurations successfully.');
    } catch (e) {
        console.log('[TG Config] Error reading config:', e.message);
    }
}

function saveTgConfig() {
    try {
        fs.writeFileSync(TG_CONFIG_FILE, JSON.stringify(tgConfig, null, 2));
    } catch (e) {
        console.log('[TG Config] Failed to save config:', e.message);
    }
}

// --- TELEGRAM MEDIA QUEUE & RATE-LIMITING SYSTEM ---
let tgMessageQueue = [];
let isProcessingTgQueue = false;

function pushToTgQueue(task) {
    tgMessageQueue.push(task);
    processTgQueue();
}

async function processTgQueue() {
    if (isProcessingTgQueue || tgMessageQueue.length === 0) return;
    isProcessingTgQueue = true;

    if (!tgConfig.enabled || !tgConfig.botToken || !tgConfig.chatId) {
        isProcessingTgQueue = false;
        return;
    }

    const task = tgMessageQueue.shift();

    try {
        if (task.type === 'text') {
            const data = JSON.stringify({ chat_id: tgConfig.chatId, text: task.text, parse_mode: 'HTML' });
            const options = {
                hostname: 'api.telegram.org',
                port: 443,
                path: `/bot${tgConfig.botToken}/sendMessage`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
            };
            await new Promise((resolve, reject) => {
                const req = https.request(options, (res) => {
                    let responseBody = '';
                    res.on('data', (chunk) => { responseBody += chunk; });
                    res.on('end', () => {
                        if (res.statusCode !== 200) reject(new Error(`Status: ${res.statusCode}, Response: ${responseBody}`));
                        else resolve();
                    });
                });
                req.on('error', reject);
                req.write(data);
                req.end();
            });
        } else if (task.type === 'media') {
            let endpoint = 'sendDocument';
            let fileField = 'document';

            if (task.mediaType === 'imageMessage') {
                endpoint = 'sendPhoto';
                fileField = 'photo';
            } else if (task.mediaType === 'videoMessage') {
                endpoint = 'sendVideo';
                fileField = 'video';
            } else if (task.mediaType === 'audioMessage') {
                endpoint = 'sendAudio';
                fileField = 'audio';
            }

            const url = `https://api.telegram.org/bot${tgConfig.botToken}/${endpoint}`;
            const form = new FormData();
            form.append('chat_id', tgConfig.chatId);
            form.append(fileField, task.buffer, { filename: task.filename });
            if (task.caption) {
                form.append('caption', task.caption);
                form.append('parse_mode', 'HTML');
            }

            await axios.post(url, form, {
                headers: form.getHeaders(),
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            });
        }
        await new Promise(resolve => setTimeout(resolve, 1200));
    } catch (err) {
        console.error('[TELEGRAM QUEUE ERROR]:', err.response?.data || err.message);
    }

    isProcessingTgQueue = false;
    processTgQueue();
}

// Robust helper to handle View Once, Ephemeral, and nested media wrappers with size limits
async function downloadMediaMessageBuffer(msg) {
    try {
        let messageContent = msg.message;
        if (!messageContent) return null;

        let maxDepth = 5;
        while (maxDepth > 0) {
            if (messageContent.ephemeralMessage?.message) {
                messageContent = messageContent.ephemeralMessage.message;
            } else if (messageContent.viewOnceMessage?.message) {
                messageContent = messageContent.viewOnceMessage.message;
            } else if (messageContent.viewOnceMessageV2?.message) {
                messageContent = messageContent.viewOnceMessageV2.message;
            } else if (messageContent.viewOnceMessageV2Extension?.message) {
                messageContent = messageContent.viewOnceMessageV2Extension.message;
            } else {
                break;
            }
            maxDepth--;
        }

        let mediaType = null;
        let ext = 'bin';

        if (messageContent.imageMessage) {
            mediaType = 'imageMessage';
            ext = (messageContent.imageMessage.mimetype || 'image/jpeg').split('/')[1] || 'jpg';
        } else if (messageContent.videoMessage) {
            mediaType = 'videoMessage';
            ext = (messageContent.videoMessage.mimetype || 'video/mp4').split('/')[1] || 'mp4';
        } else if (messageContent.documentMessage) {
            mediaType = 'documentMessage';
            ext = messageContent.documentMessage.fileName?.split('.').pop() || 'file';
        } else if (messageContent.audioMessage) {
            mediaType = 'audioMessage';
            ext = 'mp3';
        } else if (messageContent.stickerMessage) {
            mediaType = 'imageMessage';
            ext = 'webp';
        }

        if (!mediaType) return null;

        const mediaObj = messageContent[mediaType] || messageContent;
        
        const fileSize = mediaObj.fileLength ? Number(mediaObj.fileLength) : 0;
        const MAX_ALLOWED_SIZE = 45 * 1024 * 1024; // 45 MB

        if (fileSize > MAX_ALLOWED_SIZE) {
            return {
                isTooLarge: true,
                fileSizeMB: (fileSize / (1024 * 1024)).toFixed(2),
                filename: mediaObj.fileName || `large_file.${ext}`
            };
        }

        const stream = await downloadContentFromMessage(
            mediaObj,
            mediaType === 'imageMessage' && messageContent.stickerMessage ? 'sticker' : mediaType.replace('Message', '')
        );

        let buffer = Buffer.from([]);
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }

        return {
            isTooLarge: false,
            buffer,
            mediaType: messageContent.stickerMessage ? 'imageMessage' : mediaType,
            filename: mediaObj.fileName || `media_${Date.now()}.${ext}`,
            caption: messageContent.imageMessage?.caption || messageContent.videoMessage?.caption || messageContent.documentMessage?.caption || ''
        };
    } catch (e) {
        console.error('[Media Download Error / View Once]:', e.message);
        return null;
    }
}

const DB_FILE = path.join(__dirname, 'contacts_db.json');
const BATCHES_FILE = path.join(__dirname, 'batches_db.json');
const SCHEDULE_FILE = path.join(__dirname, 'schedule_db.json');
const HISTORY_FILE = path.join(__dirname, 'history_db.json');

let cooldownMap = new Map();
const COOLDOWN_TIME_MS = 15 * 60 * 1000;

let contactsMap = new Map();
if (fs.existsSync(DB_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        savedData.forEach(c => {
            if (c.id) contactsMap.set(c.id, c);
        });
        console.log(`[DB] Loaded ${contactsMap.size} contacts from local database.`);
    } catch (e) {
        console.log('[DB] Error reading database:', e.message);
    }
}

function saveContactsToDisk() {
    try {
        const arrayData = Array.from(contactsMap.values());
        fs.writeFileSync(DB_FILE, JSON.stringify(arrayData, null, 2));
    } catch (e) {
        console.log('[DB] Failed to save contacts:', e.message);
    }
}

let batchesConfig = []; 
if (fs.existsSync(BATCHES_FILE)) {
    try {
        batchesConfig = JSON.parse(fs.readFileSync(BATCHES_FILE, 'utf8'));
        console.log(`[DB] Loaded ${batchesConfig.length} custom batches.`);
    } catch (e) {
        console.log('[DB] Error reading batches:', e.message);
    }
}

function saveBatchesToDisk() {
    try {
        fs.writeFileSync(BATCHES_FILE, JSON.stringify(batchesConfig, null, 2));
    } catch (e) {
        console.log('[DB] Failed to save batches:', e.message);
    }
}

let scheduledMessages = [];
if (fs.existsSync(SCHEDULE_FILE)) {
    try {
        scheduledMessages = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
        console.log(`[DB] Loaded ${scheduledMessages.length} scheduled messages.`);
    } catch (e) {
        console.log('[DB] Error reading scheduled messages:', e.message);
    }
}

function saveScheduleToDisk() {
    try {
        fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(scheduledMessages, null, 2));
    } catch (e) {
        console.log('[DB] Failed to save schedule:', e.message);
    }
}

let messageHistory = [];
if (fs.existsSync(HISTORY_FILE)) {
    try {
        messageHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        console.log(`[DB] Loaded ${messageHistory.length} history logs.`);
    } catch (e) {
        console.log('[DB] Error reading history logs:', e.message);
    }
}

function saveHistoryToDisk() {
    try {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(messageHistory, null, 2));
    } catch (e) {
        console.log('[DB] Failed to save history logs:', e.message);
    }
}

function logHistory(type, recipient, message, extraDetails = {}) {
    messageHistory.unshift({
        id: 'hist_' + Date.now() + Math.random().toString(36).substring(2, 7),
        type, 
        recipient,
        message,
        details: extraDetails,
        timestamp: new Date().toISOString()
    });
    if (messageHistory.length > 200) messageHistory = messageHistory.slice(0, 200);
    saveHistoryToDisk();
}

let isBotEnabled = false;
let unknownFallbackMessage = "🎀 𝑫ᴇᴀʀ, 𝑫ᴇᴠɪʟ ɪs 𝑪ᴜʀʀᴇɴᴛʟʏ 𝑩ᴜꜱʏ. 🤍\n📩 𝒀ᴏᴜʀ 𝒁ᴇꜱꜱᴀɢᴇ 𝑯ᴀꜱ 𝑩ᴇᴇɴ 𝑵ᴏᴛᴇᴅ. ✨\n⏳ 𝑯ᴇ’ʟʟ 𝑮ᴇᴛ 𝑩ᴀᴄᴋ 𝑻ᴏ 𝒀ᴏᴜ 𝑺ᴏᴏɴ. 🌸";

function getLast10Digits(inputStr) {
    if (!inputStr) return "";
    const cleanStr = inputStr.toString().split('@')[0].split(':')[0];
    const rawDigits = cleanStr.replace(/[^0-9]/g, '');
    if (rawDigits.length >= 10) {
        return rawDigits.slice(-10);
    }
    return rawDigits;
}

function formatJidAndName(phoneOrJid, name) {
    const last10 = getLast10Digits(phoneOrJid);
    if (!last10 || last10.length < 10) return null;
    const formattedId = `91${last10}@s.whatsapp.net`;
    return {
        id: formattedId,
        name: name || `Contact ${last10}`
    };
}

function parseVcfContent(vcfText) {
    const cards = vcfText.split(/BEGIN:VCARD/i);
    let count = 0;
    contactsMap.clear();

    for (let card of cards) {
        if (!card.includes('END:VCARD')) continue;

        const lines = card.split(/\r\n|\n/);
        let currentName = "";
        let phoneNumbers = [];

        for (let line of lines) {
            line = line.trim();
            if (line.startsWith('FN:')) {
                currentName = line.substring(3).trim();
            } else if (line.includes('FN;') && line.includes('QUOTED-PRINTABLE')) {
                const parts = line.split(':');
                if (parts[1]) {
                    currentName = parts[1].replace(/=([A-F0-9]{2})/g, (match, p1) => String.fromCharCode(parseInt(p1, 16)));
                }
            } else if (line.startsWith('N:') && !currentName) {
                const parts = line.substring(2).split(';');
                if (parts[0] && parts[1]) currentName = `${parts[1].trim()} ${parts[0].trim()}`;
            } else if (line.startsWith('TEL')) {
                const telMatch = line.match(/:([\+\d\s\-\(\)]+)/);
                if (telMatch && telMatch[1]) {
                    phoneNumbers.push(telMatch[1]);
                }
            }
        }

        if (!currentName) currentName = "Unknown Contact";

        for (let phone of phoneNumbers) {
            const contactObj = formatJidAndName(phone, currentName);
            if (contactObj && !contactsMap.has(contactObj.id)) {
                contactsMap.set(contactObj.id, {
                    id: contactObj.id,
                    name: currentName.replace(/=../g, '').trim()
                });
                count++;
            }
        }
    }

    saveContactsToDisk();
    logHistory('system', 'Local Database', `Parsed ${count} contacts from VCF file.`);
    console.log(`[VCF Parser] Successfully parsed ${count} clean contacts.`);
    return count;
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            botConnectionStatus = 'qr_waiting';
            latestQR = qr; 
            console.log('\n==============================');
            console.log('SCAN THIS FRESH QR CODE:');
            console.log('==============================\n');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            botConnectionStatus = 'disconnected';
            latestQR = "";
            logHistory('system', 'WhatsApp Core', 'Connection closed.');
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            botConnectionStatus = 'connected';
            latestQR = ""; 
            logHistory('system', 'WhatsApp Core', 'Connected successfully.');
            console.log('\n[SUCCESS] WhatsApp Bot connected successfully!\n');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Background Scheduler
    setInterval(async () => {
        if (!sock || !isBotEnabled) return;
        const now = new Date().getTime();
        
        let dueMessages = scheduledMessages.filter(sched => now >= new Date(sched.datetime).getTime());
        if (dueMessages.length === 0) return;

        scheduledMessages = scheduledMessages.filter(sched => now < new Date(sched.datetime).getTime());
        saveScheduleToDisk();

        for (let sched of dueMessages) {
            try {
                let mediaPayloads = [];
                if (sched.mediaPaths && Array.isArray(sched.mediaPaths)) {
                    for (let filePath of sched.mediaPaths) {
                        if (fs.existsSync(filePath)) {
                            const ext = path.extname(filePath).toLowerCase();
                            if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
                                mediaPayloads.push({ type: 'image', data: fs.readFileSync(filePath) });
                            } else if (['.mp4', '.mkv', '.avi'].includes(ext)) {
                                mediaPayloads.push({ type: 'video', data: fs.readFileSync(filePath) });
                            } else {
                                mediaPayloads.push({ type: 'document', data: fs.readFileSync(filePath), fileName: path.basename(filePath) });
                            }
                        }
                    }
                }

                for (let cId of sched.contactIds) {
                    if (mediaPayloads.length > 0) {
                        for (let i = 0; i < mediaPayloads.length; i++) {
                            let media = mediaPayloads[i];
                            let captionText = (i === 0) ? sched.message : '';
                            if (media.type === 'image') {
                                await sock.sendMessage(cId, { image: media.data, caption: captionText });
                            } else if (media.type === 'video') {
                                await sock.sendMessage(cId, { video: media.data, caption: captionText });
                            } else {
                                await sock.sendMessage(cId, { document: media.data, mimetype: 'application/octet-stream', fileName: media.fileName, caption: captionText });
                            }
                        }
                    } else {
                        await sock.sendMessage(cId, { text: sched.message });
                    }
                    logHistory('scheduled', cId, sched.message);
                }
            } catch (err) {
                console.error('[SCHEDULER ERROR]:', err.message);
            }
        }
    }, 1000);

    // --- MESSAGES UPSERT (CRASH-PROOF WITH SIZE LIMIT & SAFEGUARDS) ---
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;
            if (msg.message.protocolMessage) continue;

            let rawSender = msg.key.remoteJidAlt && msg.key.remoteJidAlt.includes('@s.whatsapp.net') 
                ? msg.key.remoteJidAlt 
                : msg.key.remoteJid;

            const senderLast10 = getLast10Digits(rawSender);
            const messageText = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || msg.message.videoMessage?.caption || msg.message.documentMessage?.caption || '';

            let mediaData = null;
            try {
                mediaData = await downloadMediaMessageBuffer(msg);
            } catch (mediaErr) {
                console.error('[Safe Media Catch]:', mediaErr.message);
                mediaData = null;
            }

            logHistory('incoming', rawSender, messageText || (mediaData ? `[Media Attachment: ${mediaData.filename}]` : '[Media/Other Message]'), { senderLast10 });

            // --- 1. INDEPENDENT TELEGRAM LOGGER CHECK (Crash-Proof) ---
            if (tgConfig.enabled) {
                try {
                    let senderInfo = `+${rawSender.split('@')[0]}`;
                    for (let [dbId, contact] of contactsMap.entries()) {
                        if (getLast10Digits(dbId) === senderLast10) {
                            senderInfo = `${contact.name} (+${senderLast10})`;
                            break;
                        }
                    }

                    if (mediaData) {
                        if (mediaData.isTooLarge) {
                            console.log(`[TG Logger] Skipped oversized media (${mediaData.fileSizeMB} MB) from ${senderInfo}`);
                            pushToTgQueue({
                                type: 'text',
                                text: `🛡️ [Anti-Revoke Logger]\n👤 From: ${senderInfo}\n⚠️ <b>[Media Skipped]</b>\nA media file was received but cannot be shown because its size (${mediaData.fileSizeMB} MB) exceeds Telegram's 50MB limit.`
                            });
                        } else {
                            console.log(`[TG Logger] Triggered for incoming media from ${senderInfo}`);
                            pushToTgQueue({
                                type: 'media',
                                mediaType: mediaData.mediaType,
                                buffer: mediaData.buffer,
                                filename: mediaData.filename,
                                caption: `🛡️ [Anti-Revoke Logger]\n👤 From: ${senderInfo}\n💬 <b>[Media Attachment]</b>\n${mediaData.caption}`
                            });
                        }
                    } else if (messageText) {
                        console.log(`[TG Logger] Triggered for incoming message from ${senderInfo}`);
                        pushToTgQueue({
                            type: 'text',
                            text: `🛡️ [Anti-Revoke Logger]\n👤 From: ${senderInfo}\n💬 Message: ${messageText}`
                        });
                    }
                } catch (tgErr) {
                    console.error('[TELEGRAM FORWARD ERROR]:', tgErr.message);
                }
            }

            // --- 2. MAIN BOT AUTO-REPLY / FALLBACK LOGIC ---
            if (!messageText && !mediaData) continue;
            if (!isBotEnabled) continue;

            let isSavedInVcfDb = false;
            for (let [dbId, contact] of contactsMap.entries()) {
                const dbLast10 = getLast10Digits(contact.id || dbId);
                if (dbLast10 === senderLast10) {
                    isSavedInVcfDb = true;
                    break;
                }
            }

            if (isSavedInVcfDb) {
                let matchedBatch = null;
                for (let batch of batchesConfig) {
                    if (batch.contacts && Array.isArray(batch.contacts)) {
                        const found = batch.contacts.some(cId => getLast10Digits(cId) === senderLast10);
                        if (found) {
                            matchedBatch = batch;
                            break;
                        }
                    }
                }

                if (matchedBatch) {
                    const lastMessageTime = cooldownMap.get(senderLast10) || 0;
                    const currentTime = Date.now();
                    if (currentTime - lastMessageTime >= COOLDOWN_TIME_MS) {
                        cooldownMap.set(senderLast10, currentTime);
                        await sock.sendMessage(msg.key.remoteJid, { text: matchedBatch.message });
                        logHistory('batch', msg.key.remoteJid, matchedBatch.message);
                    }
                }
                continue; 
            }

            const lastMessageTime = cooldownMap.get(senderLast10) || 0;
            const currentTime = Date.now();
            if (currentTime - lastMessageTime < COOLDOWN_TIME_MS) continue;

            cooldownMap.set(senderLast10, currentTime);
            await sock.sendMessage(msg.key.remoteJid, { text: unknownFallbackMessage });
            logHistory('fallback', msg.key.remoteJid, unknownFallbackMessage);
        }
    });
}

// Global Unhandled Error Catchers so terminal NEVER crashes
process.on('uncaughtException', (err) => {
    console.error('[CRITICAL UNCAUGHT EXCEPTION]:', err.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[CRITICAL UNHANDLED REJECTION]:', reason);
});

// API Endpoints
app.get('/', (req, res) => {
    res.send('Nexon Automation Grid - Bot is Active 24/7');
});

// --- DISCONNECT / RESET SESSION ENDPOINT (FOR NEW DEVICE QR) ---
app.post('/api/reset-session', async (req, res) => {
    try {
        console.log('[SESSION RESET] Disconnecting current device and clearing auth_info...');
        if (sock) {
            try {
                await sock.logout();
            } catch (e) {
                sock.end();
            }
        }
        
        const authPath = path.join(__dirname, 'auth_info');
        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
            console.log('[SESSION RESET] auth_info folder cleared successfully.');
        }

        botConnectionStatus = 'disconnected';
        latestQR = "";

        setTimeout(() => {
            startBot();
        }, 1000);

        res.json({ status: 'Session disconnected and reset successfully! Go to /qr to scan new code.' });
    } catch (err) {
        console.error('[SESSION RESET ERROR]:', err.message);
        res.status(500).json({ status: 'Failed to reset session: ' + err.message });
    }
});

// --- BROWSER QR CODE VIEWER ENDPOINT ---
app.get('/qr', async (req, res) => {
    if (!latestQR) {
        return res.send(`
            <div style="text-align:center; margin-top:50px; background:#090d16; color:#34d399; font-family:monospace; padding:40px; min-height:100vh;">
                <h2>✅ WhatsApp is already connected or QR code is regenerating!</h2>
                <p style="color:#94a3b8; margin-top:15px;">Check server console logs or refresh if needed.</p>
            </div>
        `);
    }
    try {
        const dataUrl = await QRCodeLib.toDataURL(latestQR);
        res.send(`
            <div style="text-align:center; margin-top:40px; background:#090d16; color:#f1f5f9; font-family:monospace; padding:30px; min-height:100vh;">
                <h2 style="color:#38bdf8; text-shadow: 0 0 10px rgba(56,189,248,0.5);">NEXON - Scan WhatsApp QR Code</h2>
                <p style="color:#94a3b8; margin:15px 0 25px 0;">Open WhatsApp on your phone &rarr; Linked Devices &rarr; Link a Device</p>
                <div style="display:inline-block; padding:15px; background:#fff; border-radius:12px; box-shadow: 0 0 30px rgba(56,189,248,0.5);">
                    <img src="${dataUrl}" alt="WhatsApp QR Code" style="width:320px; height:320px; display:block;" />
                </div>
                <p style="color:#34d399; margin-top:20px; font-size:0.85rem;">Page auto-refreshes every 10 seconds...</p>
                <script>setTimeout(() => window.location.reload(), 10000);</script>
            </div>
        `);
    } catch (err) {
        res.status(500).send('Error generating graphical QR code');
    }
});

app.get('/api/status', (req, res) => {
    res.json({
        enabled: isBotEnabled,
        status: botConnectionStatus,
        totalContacts: contactsMap.size,
        activeBatches: batchesConfig.length,
        scheduledCount: scheduledMessages.length
    });
});

// --- INDEPENDENT TELEGRAM SETTINGS API ENDPOINTS ---
app.get('/api/telegram-settings', (req, res) => {
    res.json(tgConfig);
});

app.post('/api/telegram-settings', (req, res) => {
    const { enabled, botToken, chatId } = req.body;
    if (typeof enabled === 'boolean') tgConfig.enabled = enabled;
    if (botToken) tgConfig.botToken = botToken.trim();
    if (chatId) tgConfig.chatId = chatId.trim();
    saveTgConfig();
    res.json({ status: 'Telegram settings updated successfully!', tgConfig });
});

app.get('/api/history', (req, res) => res.json(messageHistory));
app.get('/api/contacts', (req, res) => res.json(Array.from(contactsMap.values())));

app.post('/api/contacts/update', (req, res) => {
    const { id, name } = req.body;
    try {
        if (contactsMap.has(id)) {
            const contact = contactsMap.get(id);
            contact.name = name;
            contactsMap.set(id, contact);
            saveContactsToDisk();
            res.json({ status: 'Contact updated successfully!' });
        } else {
            throw new Error('Contact not found.');
        }
    } catch (err) {
        res.status(500).json({ status: 'Failed to update contact: ' + err.message });
    }
});

app.delete('/api/contacts/:id', (req, res, next) => {
    const id = decodeURIComponent(req.params.id);
    try {
        if (contactsMap.has(id)) {
            contactsMap.delete(id);
            saveContactsToDisk();
            res.json({ status: 'Contact deleted successfully from database!' });
        } else {
            throw new Error('Contact not found.');
        }
    } catch (err) {
        res.status(500).json({ status: 'Failed to delete contact: ' + err.message });
    }
});

app.get('/api/batches', (req, res) => res.json(batchesConfig));
app.post('/api/batches', (req, res) => {
    const { batches } = req.body;
    try {
        if (batches && Array.isArray(batches)) {
            batchesConfig = batches;
            saveBatchesToDisk();
            res.json({ status: 'Batches updated and saved successfully!' });
        } else {
            throw new Error('Invalid batch data format.');
        }
    } catch (err) {
        res.status(500).json({ status: 'Failed to save batches: ' + err.message });
    }
});

app.get('/api/schedule', (req, res) => res.json(scheduledMessages));

app.post('/api/schedule', upload.array('mediaFiles', 10), (req, res) => {
    try {
        const { contactIds, datetime, message } = req.body;
        const parsedContactIds = typeof contactIds === 'string' ? JSON.parse(contactIds) : contactIds;
        
        if (!parsedContactIds || !parsedContactIds.length || !datetime || !message) {
            throw new Error('Missing required fields.');
        }

        const mediaPaths = req.files ? req.files.map(file => file.path) : [];

        scheduledMessages.path = mediaPaths; 
        scheduledMessages.push({
            id: 'sched_' + Date.now(),
            contactIds: parsedContactIds,
            datetime,
            message,
            mediaPaths
        });

        saveScheduleToDisk();
        res.json({ status: 'Message and multiple files scheduled successfully!' });
    } catch (err) {
        res.status(500).json({ status: 'Failed to schedule message: ' + err.message });
    }
});

app.delete('/api/schedule/:id', (req, res) => {
    const id = req.params.id;
    try {
        scheduledMessages = scheduledMessages.filter(s => s.id !== id);
        saveScheduleToDisk();
        res.json({ status: 'Scheduled message cancelled!' });
    } catch (err) {
        res.status(500).json({ status: 'Failed to schedule message: ' + err.message });
    }
});

app.post('/api/upload-vcf', (req, res) => {
    const { vcfData } = req.body;
    try {
        if (!vcfData) throw new Error('VCF data missing.');
        const addedCount = parseVcfContent(vcfData);
        res.json({ status: `Successfully parsed and added ${addedCount} clean contacts from VCF file!` });
    } catch (err) {
        res.status(500).json({ status: 'Failed to process VCF file: ' + err.message });
    }
});

app.post('/api/config', async (req, res) => {
    const { enabled, fallbackMessage } = req.body;
    try {
        if (!sock) throw new Error('WhatsApp socket not initialized.');
        if (typeof enabled === 'boolean') isBotEnabled = enabled;
        if (fallbackMessage) unknownFallbackMessage = fallbackMessage;

        res.json({ status: `Configuration updated! Status: ${isBotEnabled ? 'ON' : 'OFF'}` });
    } catch (err) {
        res.status(500).json({ status: 'Failed to update config: ' + err.message });
    }
});

app.listen(3000, () => {
    console.log('Nexon Automation Grid running at: http://localhost:3000');
});

startBot();