import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import NodeCache from 'node-cache';
import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';
import messageHandler from './messageHandler.js';

const sessions = new Map();
const messageStores = new Map();
// Check for Railway volume mount or fallback to local sessions
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

    // End existing in-memory session
    if (sessions.has(safeUserId) && !isRestart) {
        console.log(`[SESSION] Ending existing in-memory session for ${safeUserId}`);
        try {
            sessions.get(safeUserId).end(undefined);
        } catch (e) {}
        sessions.delete(safeUserId);
    }

    // Do NOT clear the folder on startup/redeploy. 
    // Only clear if the user is explicitly requesting a NEW pairing via the UI (not a restart)
    if (!isRestart && !fs.existsSync(path.join(sessionPath, 'creds.json'))) {
        if (fs.existsSync(sessionPath)) {
            console.log(`[SESSION] Clearing stale session folder for ${safeUserId}`);
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }
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
            } catch (err) {
                console.error('[SESSION] QR generation failed:', err);
            }
        }

        console.log(`[SESSION] Connection update for ${safeUserId}: ${connection}`);

        if (connection === 'open') {
            console.log(`[SESSION] ${safeUserId} connected successfully!`);
            emitToUser(io, safeUserId, 'session-status', { status: 'connected' });

            // Send welcome message if NOT a restart AND not an auto-resume
            if (!isRestart) {
                setTimeout(async () => {
                    try {
                        const myJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                        const welcomeText = `*🚀 BlvckLink Reconnected! *\n\n` +
                            `Hello *${safeUserId}*, your bot session has been restored.\n\n` +
                            `*Status:* Online 🟢\n` +
                            `_No action needed._`;
                        
                        await sock.sendMessage(myJid, { text: welcomeText });
                    } catch (err) {
                        console.error('[SESSION] Failed to send resume message:', err);
                    }
                }, 3000);
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const reason = lastDisconnect?.error?.message;
            console.log(`[SESSION] ${safeUserId} connection closed. Status: ${statusCode}, Reason: ${reason}`);
            
            if (statusCode === 515 || statusCode === 408) {
                console.log(`[SESSION] ${safeUserId} restarting connection...`);
                setTimeout(() => startPairing(safeUserId, undefined, io, method, true).catch(console.error), 2000);
                return;
            }

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            emitToUser(io, safeUserId, 'session-status', {
                status: shouldReconnect ? 'reconnecting' : 'disconnected',
                reason: reason
            });

            if (shouldReconnect) {
                console.log(`[SESSION] Reconnecting ${safeUserId}...`);
                setTimeout(() => startPairing(safeUserId, undefined, io, method, true).catch(console.error), 5000);
            } else {
                console.log(`[SESSION] ${safeUserId} logged out. Clearing data.`);
                sessions.delete(safeUserId);
                if (fs.existsSync(sessionPath)) {
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                }
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type === 'notify' && m.messages[0]?.key?.id) {
            messageStore.set(m.messages[0].key.id, m.messages[0]);
        }
        await messageHandler(sock, m, messageStore, safeUserId);
    });

    if (method === 'code' && phoneNumber && !state.creds.registered) {
        const normalizedPhone = String(phoneNumber).replace(/\D/g, '');
        await new Promise(resolve => setTimeout(resolve, 3000));
        console.log(`[SESSION] Requesting pairing code for ${normalizedPhone}`);
        try {
            const pairingCode = await sock.requestPairingCode(normalizedPhone);
            emitToUser(io, safeUserId, 'pairing-code', { code: pairingCode, isLatest });
            return { userId: safeUserId, code: pairingCode, status: 'pairing_code_generated' };
        } catch (err) {
            console.error('[SESSION] Pairing code request failed:', err);
            throw err;
        }
    }

    return {
        userId: safeUserId,
        status: state.creds.registered ? 'connected' : 'ready',
        waVersion: version.join('.'),
        isLatest
    };
};

// Auto-resume all sessions found in storage
export const resumeAllSessions = async (io) => {
    console.log('[SESSION] Resuming all saved sessions...');
    if (!fs.existsSync(sessionsRoot)) return;

    const userFolders = fs.readdirSync(sessionsRoot);
    for (const userId of userFolders) {
        const sessionPath = path.join(sessionsRoot, userId);
        if (fs.statSync(sessionPath).isDirectory() && fs.existsSync(path.join(sessionPath, 'creds.json'))) {
            console.log(`[SESSION] Resuming session for user: ${userId}`);
            startPairing(userId, undefined, io, 'code', true).catch(err => {
                console.error(`[SESSION] Failed to resume session for ${userId}:`, err);
            });
        }
    }
};

export const getSessionStatus = (userId) => {
    const safeUserId = sanitizeUserId(userId);
    return {
        userId: safeUserId,
        connected: sessions.has(safeUserId)
    };
};

export const disconnectSession = async (userId) => {
    const safeUserId = sanitizeUserId(userId);
    const sock = sessions.get(safeUserId);
    if (sock) {
        sock.end(undefined);
        sessions.delete(safeUserId);
        const sessionPath = path.join(sessionsRoot, safeUserId);
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }
    }
};
