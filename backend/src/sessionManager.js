import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import NodeCache from 'node-cache';
import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';
import messageHandler from './messageHandler.js';

const sessions = new Map();
const messageStores = new Map();
const railwayVolume = '/data/sessions';
const sessionsRoot = fs.existsSync('/data') ? railwayVolume : path.join(process.cwd(), 'sessions');

if (!fs.existsSync(sessionsRoot)) {
    fs.mkdirSync(sessionsRoot, { recursive: true });
}

const sanitizeUserId = (userId) => String(userId).replace(/[^a-zA-Z0-9_-]/g, '_');

const emitToUser = (io, userId, event, payload) => {
    if (!io) return;
    io.to(`user:${userId}`).emit(event, payload);
};

export const startPairing = async (userId, phoneNumber, io, method = 'code', isRestart = false) => {
    const safeUserId = sanitizeUserId(userId);
    const sessionPath = path.join(sessionsRoot, safeUserId);

    console.log(`[SESSION] Starting ${method} pairing for ${safeUserId}${isRestart ? ' (RESTART)' : ''}`);

    if (sessions.has(safeUserId) && !isRestart) {
        try { sessions.get(safeUserId).end(undefined); } catch (e) {}
        sessions.delete(safeUserId);
    }

    if (!isRestart && !fs.existsSync(path.join(sessionPath, 'creds.json'))) {
        if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
        fs.mkdirSync(sessionPath, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    const msgRetryCounterCache = new NodeCache();
    const messageStore = new NodeCache({ stdTTL: 3600 });
    messageStores.set(safeUserId, messageStore);

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: state,
        msgRetryCounterCache,
        generateHighQualityLinkPreview: true,
        printQRInTerminal: false,
        browser: ["BlvckBot", "Chrome", "121.0.6167.160"],
        syncFullHistory: false,
        markOnline: true,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 10000
    });

    sessions.set(safeUserId, sock);
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr && method === 'qr') {
            try {
                const qrBase64 = await QRCode.toDataURL(qr);
                emitToUser(io, safeUserId, 'qr-code', { qr: qrBase64 });
            } catch (err) {}
        }

        if (connection === 'open') {
            console.log(`[SESSION] ${safeUserId} connected successfully!`);
            emitToUser(io, safeUserId, 'session-status', { status: 'connected' });

            setTimeout(async () => {
                try {
                    const myJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                    const welcome = `╭━━━〔 *𝐁𝐋𝐕𝐂𝐊-𝐁𝐎𝐓* 〕━━━┈⊷
┃
┃  *🚀 Successfully Connected!*
┃
┃  Hello *${safeUserId}*, your bot is now
┃  active and ready for action.
┃
┃  *🌐 Link:* https://blvckbot.vercel.app/
┃
┣━━〔 *𝐐𝐔𝐈𝐂𝐊 𝐒𝐓𝐀𝐑𝐓* 〕━━┈⊷
┃
┃  ⋄ Type *.menu* to see all commands.
┃  ⋄ Type *.ping* to check bot status.
┃
╰━━━━━━━━━━━━━━━┈⊷
    𝐌𝐚𝐝𝐞 𝐰𝐢𝐭𝐡 ❤️ 𝐟𝐨𝐫 𝐆𝐡𝐚𝐧𝐚𝐢𝐚𝐧𝐬`;
                    await sock.sendMessage(myJid, { text: welcome });
                } catch (err) {}
            }, 3000);
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === 515 || statusCode === 408) {
                setTimeout(() => startPairing(safeUserId, undefined, io, method, true).catch(console.error), 2000);
                return;
            }
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            emitToUser(io, safeUserId, 'session-status', { status: shouldReconnect ? 'reconnecting' : 'disconnected' });
            if (shouldReconnect) setTimeout(() => startPairing(safeUserId, undefined, io, method, true).catch(console.error), 5000);
            else {
                sessions.delete(safeUserId);
                if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type === 'notify' && m.messages[0]?.key?.id) messageStore.set(m.messages[0].key.id, m.messages[0]);
        await messageHandler(sock, m, messageStore, safeUserId);
    });

    if (method === 'code' && phoneNumber && !state.creds.registered) {
        const normalizedPhone = String(phoneNumber).replace(/\D/g, '');
        await new Promise(resolve => setTimeout(resolve, 3000));
        try {
            const pairingCode = await sock.requestPairingCode(normalizedPhone);
            emitToUser(io, safeUserId, 'pairing-code', { code: pairingCode, isLatest });
            return { userId: safeUserId, code: pairingCode, status: 'pairing_code_generated' };
        } catch (err) { throw err; }
    }

    return { userId: safeUserId, status: state.creds.registered ? 'connected' : 'ready', waVersion: version.join('.'), isLatest };
};

export const resumeAllSessions = async (io) => {
    if (!fs.existsSync(sessionsRoot)) return;
    const userFolders = fs.readdirSync(sessionsRoot);
    for (const userId of userFolders) {
        const sessionPath = path.join(sessionsRoot, userId);
        if (fs.statSync(sessionPath).isDirectory() && fs.existsSync(path.join(sessionPath, 'creds.json'))) {
            startPairing(userId, undefined, io, 'code', true).catch(() => {});
        }
    }
};

export const getSessionStatus = (userId) => ({ userId: sanitizeUserId(userId), connected: sessions.has(sanitizeUserId(userId)) });

export const disconnectSession = async (userId) => {
    const safeUserId = sanitizeUserId(userId);
    const sock = sessions.get(safeUserId);
    if (sock) {
        sock.end(undefined);
        sessions.delete(safeUserId);
        const sessionPath = path.join(sessionsRoot, safeUserId);
        if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
    }
};
