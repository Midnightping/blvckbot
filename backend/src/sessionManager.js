import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import NodeCache from 'node-cache';
import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';
import messageHandler from './messageHandler.js';

const sessions = new Map();
const messageStores = new Map();
const sessionsRoot = path.join(process.cwd(), 'sessions');

if (!fs.existsSync(sessionsRoot)) {
    fs.mkdirSync(sessionsRoot, { recursive: true });
}

const sanitizeUserId = (userId) => String(userId).replace(/[^a-zA-Z0-9_-]/g, '_');

const emitToUser = (io, userId, event, payload) => {
    io.to(`user:${userId}`).emit(event, payload);
};

export const startPairing = async (userId, phoneNumber, io, method = 'code', isRestart = false) => {
    const safeUserId = sanitizeUserId(userId);
    const sessionPath = path.join(sessionsRoot, safeUserId);

    console.log(`[SESSION] Starting ${method} pairing for ${safeUserId}${isRestart ? ' (RESTART)' : ''}`);

    // End existing in-memory session
    if (sessions.has(safeUserId)) {
        console.log(`[SESSION] Ending existing in-memory session for ${safeUserId}`);
        try {
            sessions.get(safeUserId).end(undefined);
        } catch (e) {}
        sessions.delete(safeUserId);
    }

    // Only clear session folder if NOT a restart
    if (!isRestart) {
        if (fs.existsSync(sessionPath)) {
            console.log(`[SESSION] Clearing session folder for ${safeUserId}`);
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
        logger: pino({ level: 'info' }),
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
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const reason = lastDisconnect?.error?.message;
            console.log(`[SESSION] ${safeUserId} connection closed. Status: ${statusCode}, Reason: ${reason}`);
            
            // 515 is a normal "restart required" after pairing
            if (statusCode === 515) {
                console.log(`[SESSION] ${safeUserId} restarting connection (515)...`);
                setTimeout(() => startPairing(safeUserId, phoneNumber, io, method, true).catch(console.error), 2000);
                return;
            }

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            emitToUser(io, safeUserId, 'session-status', {
                status: shouldReconnect ? 'reconnecting' : 'disconnected',
                reason: reason
            });

            if (shouldReconnect) {
                console.log(`[SESSION] Reconnecting ${safeUserId}...`);
                setTimeout(() => startPairing(safeUserId, phoneNumber, io, method, true).catch(console.error), 5000);
            } else {
                sessions.delete(safeUserId);
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type === 'notify' && m.messages[0]?.key?.id) {
            messageStore.set(m.messages[0].key.id, m.messages[0]);
        }
        await messageHandler(sock, m, messageStore, safeUserId);
    });

    if (method === 'code' && phoneNumber) {
        const normalizedPhone = String(phoneNumber).replace(/\D/g, '');
        
        // Small delay to ensure socket is ready
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        console.log(`[SESSION] Requesting pairing code for ${normalizedPhone}`);
        try {
            const pairingCode = await sock.requestPairingCode(normalizedPhone);
            emitToUser(io, safeUserId, 'pairing-code', { code: pairingCode, isLatest });
            
            return {
                userId: safeUserId,
                code: pairingCode,
                status: 'pairing_code_generated',
                waVersion: version.join('.'),
                isLatest
            };
        } catch (err) {
            console.error('[SESSION] Pairing code request failed:', err);
            throw err;
        }
    }

    return {
        userId: safeUserId,
        status: 'qr_ready',
        waVersion: version.join('.'),
        isLatest
    };
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
    }
};
