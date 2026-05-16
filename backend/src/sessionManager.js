import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import NodeCache from 'node-cache';
import fs from 'fs';
import path from 'path';
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

export const startPairing = async (userId, phoneNumber, io) => {
    const safeUserId = sanitizeUserId(userId);
    const sessionPath = path.join(sessionsRoot, safeUserId);

    if (sessions.has(safeUserId)) {
        sessions.get(safeUserId).end(undefined);
        sessions.delete(safeUserId);
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
        browser: ['BlvckBot', 'Chrome', '1.0.0']
    });

    sessions.set(safeUserId, sock);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            emitToUser(io, safeUserId, 'session-status', { status: 'connected' });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            emitToUser(io, safeUserId, 'session-status', {
                status: shouldReconnect ? 'reconnecting' : 'disconnected',
                reason: lastDisconnect?.error?.message
            });

            sessions.delete(safeUserId);

            if (shouldReconnect) {
                setTimeout(() => startPairing(safeUserId, phoneNumber, io).catch(console.error), 3000);
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type === 'notify' && m.messages[0]?.key?.id) {
            messageStore.set(m.messages[0].key.id, m.messages[0]);
        }
        await messageHandler(sock, m, messageStore, safeUserId);
    });

    const normalizedPhone = String(phoneNumber).replace(/\D/g, '');
    const pairingCode = await sock.requestPairingCode(normalizedPhone);

    emitToUser(io, safeUserId, 'pairing-code', { code: pairingCode, isLatest });

    return {
        userId: safeUserId,
        code: pairingCode,
        status: 'pairing_code_generated',
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
