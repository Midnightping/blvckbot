import fs from 'fs';
import path from 'path';
import { getContentType, downloadContentFromMessage } from '@whiskeysockets/baileys';
import { fileURLToPath } from 'url';
import { syncUserToCloudinary } from './cloudinaryService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const getUserStorage = (userId) => {
    const railwayVolume = '/data/sessions';
    const sessionsRoot = fs.existsSync('/data') ? railwayVolume : path.join(process.cwd(), 'sessions');
    const userDir = path.join(sessionsRoot, userId);
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
    const statePath = path.join(userDir, 'bot_state.json');
    const viewOnceDir = path.join(userDir, 'viewonce_media');
    const viewOnceIndexPath = path.join(userDir, 'viewonce_index.json');
    const deletedCacheDir = path.join(userDir, 'deleted_cache');
    if (!fs.existsSync(viewOnceDir)) fs.mkdirSync(viewOnceDir, { recursive: true });
    if (!fs.existsSync(deletedCacheDir)) fs.mkdirSync(deletedCacheDir, { recursive: true });
    let state = { autoViewStatus: false };
    if (fs.existsSync(statePath)) { try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (e) {} }
    let index = {};
    if (fs.existsSync(viewOnceIndexPath)) { try { index = JSON.parse(fs.readFileSync(viewOnceIndexPath, 'utf8')); } catch (e) {} }
    return { state, index, statePath, viewOnceDir, viewOnceIndexPath, deletedCacheDir,
        saveState: (newState) => fs.writeFileSync(statePath, JSON.stringify(newState, null, 2)),
        saveIndex: (newIndex) => fs.writeFileSync(viewOnceIndexPath, JSON.stringify(newIndex, null, 2))
    };
};

const sendRecoveredViewOnce = async (sock, from, msg, mediaType, buffer, caption) => {
    const finalCaption = caption ? `✅ *View-Once Retrieved*\n\n${caption}` : '✅ *View-Once Retrieved*';
    if (mediaType === 'image') await sock.sendMessage(from, { image: buffer, caption: finalCaption }, { quoted: msg });
    else if (mediaType === 'video') await sock.sendMessage(from, { video: buffer, caption: finalCaption }, { quoted: msg });
    else if (mediaType === 'audio') await sock.sendMessage(from, { audio: buffer, mimetype: 'audio/mpeg' }, { quoted: msg });
};

export default async function messageHandler(sock, m, store, userId) {
    try {
        if (m.type !== 'notify') return;
        const msg = m.messages[0];
        const storage = getUserStorage(userId);
        const { state, index, viewOnceDir, deletedCacheDir } = storage;
        const from = msg.key.remoteJid;

        // --- ANTI-DELETE: Detect protocol message (delete event) ---
        if (msg.message?.protocolMessage?.type === 0) {
            const deletedKey = msg.message.protocolMessage.key;
            const sender = (deletedKey.participant || deletedKey.remoteJid || '').split('@')[0];
            const cachedMetaPath = path.join(deletedCacheDir, `${deletedKey.id}.json`);
            const cachedMediaPath = path.join(deletedCacheDir, deletedKey.id);

            // Check if we have cached media for this message
            const hasMedia = fs.readdirSync(deletedCacheDir).some(f => f.startsWith(deletedKey.id) && !f.endsWith('.json'));
            const hasMeta = fs.existsSync(cachedMetaPath);

            if (hasMeta) {
                const meta = JSON.parse(fs.readFileSync(cachedMetaPath, 'utf8'));
                
                // Find the actual media file
                const mediaFile = fs.readdirSync(deletedCacheDir).find(f => f.startsWith(deletedKey.id) && !f.endsWith('.json'));

                const reportText = `╭━━━〔 *𝐀𝐍𝐓𝐈-𝐃𝐄𝐋𝐄𝐓𝐄* 〕━━━┈⊷\n┃\n┃  *👤 From:* @${sender}\n┃  *📝 Content:*\n┃  ${meta.text || '_[See media below]_'}\n┃\n╰━━━━━━━━━━━━━━━┈⊷`;
                await sock.sendMessage(from, { text: reportText, mentions: [deletedKey.participant || deletedKey.remoteJid] });

                // Re-send media if we have it
                if (mediaFile) {
                    const buffer = fs.readFileSync(path.join(deletedCacheDir, mediaFile));
                    if (meta.mediaType === 'image') await sock.sendMessage(from, { image: buffer, caption: meta.caption || '' });
                    else if (meta.mediaType === 'video') await sock.sendMessage(from, { video: buffer, caption: meta.caption || '' });
                    else if (meta.mediaType === 'audio') await sock.sendMessage(from, { audio: buffer, mimetype: 'audio/mpeg', ptt: meta.ptt || false });
                    else if (meta.mediaType === 'sticker') await sock.sendMessage(from, { sticker: buffer });
                    else if (meta.mediaType === 'document') await sock.sendMessage(from, { document: buffer, mimetype: meta.mimetype || 'application/octet-stream', fileName: meta.fileName || 'file' });
                    
                    // Cleanup after sending
                    fs.unlinkSync(path.join(deletedCacheDir, mediaFile));
                }
                fs.unlinkSync(cachedMetaPath);
            } else {
                // Fallback: We don't have a cached copy (message was before bot started)
                await sock.sendMessage(from, { text: `╭━━━〔 *𝐀𝐍𝐓𝐈-𝐃𝐄𝐋𝐄𝐓𝐄* 〕━━━┈⊷\n┃\n┃  *👤 From:* @${sender}\n┃  *📝* _Message was sent before bot started._\n┃\n╰━━━━━━━━━━━━━━━┈⊷`, mentions: [deletedKey.participant || deletedKey.remoteJid] });
            }
            return;
        }

        if (!msg.message) return;
        const isStatus = from === 'status@broadcast';

        // --- CACHE EVERY MESSAGE FOR ANTI-DELETE ---
        if (!isStatus && !msg.key.fromMe) {
            try {
                const content = msg.message.ephemeralMessage?.message || msg.message;
                const type = getContentType(content);
                const msgId = msg.key.id;
                let meta = { text: '', mediaType: '', caption: '', ptt: false, mimetype: '', fileName: '' };

                if (type === 'conversation') {
                    meta.text = content.conversation;
                } else if (type === 'extendedTextMessage') {
                    meta.text = content.extendedTextMessage.text;
                } else if (type === 'imageMessage') {
                    meta.mediaType = 'image';
                    meta.caption = content.imageMessage.caption || '';
                    meta.text = meta.caption || '[Image]';
                    const stream = await downloadContentFromMessage(content.imageMessage, 'image');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                    fs.writeFileSync(path.join(deletedCacheDir, `${msgId}.jpg`), buffer);
                } else if (type === 'videoMessage') {
                    meta.mediaType = 'video';
                    meta.caption = content.videoMessage.caption || '';
                    meta.text = meta.caption || '[Video]';
                    const stream = await downloadContentFromMessage(content.videoMessage, 'video');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                    fs.writeFileSync(path.join(deletedCacheDir, `${msgId}.mp4`), buffer);
                } else if (type === 'audioMessage') {
                    meta.mediaType = 'audio';
                    meta.ptt = content.audioMessage.ptt || false;
                    meta.text = '[Voice Note]';
                    const stream = await downloadContentFromMessage(content.audioMessage, 'audio');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                    fs.writeFileSync(path.join(deletedCacheDir, `${msgId}.ogg`), buffer);
                } else if (type === 'stickerMessage') {
                    meta.mediaType = 'sticker';
                    meta.text = '[Sticker]';
                    const stream = await downloadContentFromMessage(content.stickerMessage, 'sticker');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                    fs.writeFileSync(path.join(deletedCacheDir, `${msgId}.webp`), buffer);
                } else if (type === 'documentMessage') {
                    meta.mediaType = 'document';
                    meta.mimetype = content.documentMessage.mimetype || '';
                    meta.fileName = content.documentMessage.fileName || 'file';
                    meta.text = `[Document: ${meta.fileName}]`;
                    const stream = await downloadContentFromMessage(content.documentMessage, 'document');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                    const ext = meta.fileName.split('.').pop() || 'bin';
                    fs.writeFileSync(path.join(deletedCacheDir, `${msgId}.${ext}`), buffer);
                }

                // Save metadata
                fs.writeFileSync(path.join(deletedCacheDir, `${msgId}.json`), JSON.stringify(meta));
            } catch (err) {
                // If download fails silently continue (e.g. for text-only messages this is fine)
            }
        }

        // --- VIEW-ONCE DETECTION ---
        let viewOnceContent = msg.message.viewOnceMessageV2?.message || msg.message.viewOnceMessageV2Extension?.message || msg.message.viewOnceMessage?.message || msg.message;
        const msgType = getContentType(viewOnceContent);
        if (viewOnceContent?.[msgType]?.viewOnce) {
            try {
                let mediaType = ''; let mediaMessage = null; let extension = '';
                if (msgType === 'imageMessage') { mediaType = 'image'; mediaMessage = viewOnceContent.imageMessage; extension = 'jpg'; }
                else if (msgType === 'videoMessage') { mediaType = 'video'; mediaMessage = viewOnceContent.videoMessage; extension = 'mp4'; }
                else if (msgType === 'audioMessage') { mediaType = 'audio'; mediaMessage = viewOnceContent.audioMessage; extension = 'mp3'; }
                if (mediaType && mediaMessage) {
                    const stream = await downloadContentFromMessage(mediaMessage, mediaType);
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                    const filename = `${msg.key.id}.${extension}`;
                    fs.writeFileSync(path.join(viewOnceDir, filename), buffer);
                    index[msg.key.id] = { id: msg.key.id, from, type: mediaType, filename, timestamp: Date.now(), caption: mediaMessage.caption || '' };
                    storage.saveIndex(index);
                    await sendRecoveredViewOnce(sock, from, msg, mediaType, buffer, mediaMessage.caption || '');
                }
            } catch (err) {}
        }

        if (isStatus) {
            if (state.autoViewStatus && !msg.key.fromMe) await sock.readMessages([msg.key]);
            return;
        }

        // --- COMMAND PROCESSING ---
        const content = msg.message.ephemeralMessage?.message || msg.message;
        const type = getContentType(content);
        let text = '';
        if (type === 'conversation') text = content.conversation;
        else if (type === 'extendedTextMessage') text = content.extendedTextMessage.text;
        else if (type === 'imageMessage') text = content.imageMessage.caption || '';
        else if (type === 'videoMessage') text = content.videoMessage.caption || '';

        if (!text.startsWith('.')) return;
        const args = text.slice(1).trim().split(/ +/);
        const command = args.shift().toLowerCase();
        const reply = async (textInfo) => await sock.sendMessage(from, { text: textInfo }, { quoted: msg });

        if (command === 'ping') { await reply('Pong! Bot is active 🤖'); } 
        else if (command === 'autoview') {
            const toggle = args[0]?.toLowerCase();
            if (toggle === 'on') { state.autoViewStatus = true; storage.saveState(state); await reply('✅ Auto Status Viewer enabled.'); }
            else if (toggle === 'off') { state.autoViewStatus = false; storage.saveState(state); await reply('❌ Auto Status Viewer disabled.'); }
            else { await reply(`Auto Viewer is: ${state.autoViewStatus ? 'ON' : 'OFF'}\nUse .autoview on/off`); }
        }
        else if (command === 'menu') {
            const menu = `╭━━━〔 *𝐁𝐋𝐕𝐂𝐊-𝐁𝐎𝐓* 〕━━━┈⊷
┃
┃  *👤 User:* ${userId}
┃  *📶 Status:* Online 🟢
┃  *🌐 Link:* https://blvckbot.vercel.app/
┃
┣━━〔 *𝐌𝐀𝐈𝐍 𝐂𝐎𝐌𝐌𝐀𝐍𝐃𝐒* 〕━━┈⊷
┃
┃  ⋄ *.ai*   - Ask AI (Gemini)
┃  ⋄ *.vv*   - Recover View-Once
┃  ⋄ *.vvp*  - Recover View-Once
┃  ⋄ *.save*  - Save Status/Media
┃  ⋄ *.savep* - Save Status/Media
┃  ⋄ *.menu*  - Show this menu
┃  ⋄ *.ping*  - Check bot speed
┃
┣━━〔 *𝐒𝐄𝐓𝐓𝐈𝐍𝐆𝐒* 〕━━┈⊷
┃
┃  ⋄ *.autoview <on/off>*
┃  ⋄ *.viewonce* - List saved media
┃
╰━━━━━━━━━━━━━━━┈⊷
    𝐌𝐚𝐝𝐞 𝐰𝐢𝐭𝐡 ❤️ 𝐟𝐨𝐫 𝐆𝐡𝐚𝐧𝐚𝐢𝐚𝐧𝐬`;
            await reply(menu);
        }
        else if (command === 'ai') {
            const { default: handleAi } = await import('./commands/ai.js');
            await handleAi(sock, from, msg, args, reply);
        }
        else if (command === 'sync') {
            const result = await syncUserToCloudinary(userId);
            if (result.success) await reply(`✅ Sync completed! Uploaded ${result.count} files.`);
            else await reply(`❌ Sync failed: ${result.error}`);
        }
        else if (command === 'save' || command === 'savep') {
            const contextInfo = msg.message.extendedTextMessage?.contextInfo;
            if (contextInfo?.quotedMessage) {
                const qMsg = contextInfo.quotedMessage;
                const qType = getContentType(qMsg);
                if (['imageMessage','videoMessage','audioMessage'].includes(qType)) {
                    try {
                        const mType = qType.replace('Message', '');
                        const stream = await downloadContentFromMessage(qMsg[qType], mType);
                        let buffer = Buffer.from([]);
                        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                        const targetJid = command === 'savep' ? (sock.user.id.split(':')[0] + '@s.whatsapp.net') : ((from === 'status@broadcast') ? contextInfo.participant : from);
                        if (mType === 'image') await sock.sendMessage(targetJid, { image: buffer, caption: qMsg[qType].caption || '' });
                        else if (mType === 'video') await sock.sendMessage(targetJid, { video: buffer, caption: qMsg[qType].caption || '' });
                        else if (mType === 'audio') await sock.sendMessage(targetJid, { audio: buffer, mimetype: 'audio/mpeg' });
                        await sock.sendMessage(from, { react: { text: "✅", key: msg.key } });
                    } catch (err) { await reply('❌ Failed.'); }
                }
            }
        }
        else if (command === 'viewonce' || command === 'vo') {
            const action = args[0]?.toLowerCase();
            if (!action) {
                const savedKeys = Object.keys(index);
                if (savedKeys.length === 0) return reply('📭 No saved view-once messages.');
                let listText = `🔒 *Your Saved View-Once Messages*\n\n`;
                savedKeys.forEach((key, i) => { listText += `${i + 1}. ${index[key].type.toUpperCase()} - ${new Date(index[key].timestamp).toLocaleString()}\nID: ${index[key].id}\n\n`; });
                await reply(listText + `Use .viewonce get <id>`);
            } else if (action === 'get') {
                const saved = index[args[1]];
                if (saved) {
                    const buffer = fs.readFileSync(path.join(viewOnceDir, saved.filename));
                    if (saved.type === 'image') await sock.sendMessage(from, { image: buffer, caption: `🔒 Recovered\n${saved.caption}` }, { quoted: msg });
                    else if (saved.type === 'video') await sock.sendMessage(from, { video: buffer, caption: `🔒 Recovered\n${saved.caption}` }, { quoted: msg });
                    else if (saved.type === 'audio') await sock.sendMessage(from, { audio: buffer, mimetype: 'audio/mpeg' }, { quoted: msg });
                }
            }
        }
        else if (command === 'vv' || command === 'vvp') {
            const ctxInfo = msg.message.extendedTextMessage?.contextInfo;
            if (ctxInfo?.quotedMessage) {
                const qMsg = ctxInfo.quotedMessage;
                let unwrapped = qMsg.viewOnceMessageV2?.message || qMsg.viewOnceMessageV2Extension?.message || qMsg.viewOnceMessage?.message || qMsg;
                const qType = getContentType(unwrapped);
                if (unwrapped[qType]?.viewOnce) {
                    try {
                        let mediaType = ''; let mediaMessage = null;
                        if (qType === 'imageMessage') { mediaType = 'image'; mediaMessage = unwrapped.imageMessage; }
                        else if (qType === 'videoMessage') { mediaType = 'video'; mediaMessage = unwrapped.videoMessage; }
                        else if (qType === 'audioMessage') { mediaType = 'audio'; mediaMessage = unwrapped.audioMessage; }
                        if (mediaType && mediaMessage) {
                            if (command === 'vv') await reply('⏳ Retrieving...');
                            const stream = await downloadContentFromMessage(mediaMessage, mediaType);
                            let buffer = Buffer.from([]);
                            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                            if (command === 'vvp') {
                                const myJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                                const rawSender = (msg.key.participant || from).split('@')[0].split(':')[0];
                                const privateCaption = `✅ *View-Once Retrieved*\n👤 *From:* +${rawSender}\n\n${mediaMessage.caption || ''}`;
                                if (mediaType === 'image') await sock.sendMessage(myJid, { image: buffer, caption: privateCaption });
                                else if (mediaType === 'video') await sock.sendMessage(myJid, { video: buffer, caption: privateCaption });
                                else if (mediaType === 'audio') await sock.sendMessage(myJid, { audio: buffer, mimetype: 'audio/mpeg' });
                                await sock.sendMessage(from, { react: { text: "👍", key: msg.key } });
                            } else { await sendRecoveredViewOnce(sock, from, msg, mediaType, buffer, mediaMessage.caption || ''); }
                        }
                    } catch (err) { await reply('❌ Failed.'); }
                }
            }
        }
    } catch (err) {}
}
