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
    let state = { autoViewStatus: false, isPrivate: true, isAntiDelete: true, isAntiDeletePrivate: false };
    if (fs.existsSync(statePath)) { 
        try { 
            const savedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            state = { ...state, ...savedState };
        } catch (e) {} 
    }
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
    console.log(`[MSG-HANDLER] Called, type: ${m.type}, messages: ${m.messages?.length}`);
    try {
        if (m.type !== 'notify') return;
        const msg = m.messages[0];
        const storage = getUserStorage(userId);
        const { state, index, viewOnceDir, deletedCacheDir } = storage;
        const from = msg.key.remoteJid;

        // --- PRIVATE MODE CHECK ---
        // If private mode is ON, only allow commands from the owner (fromMe)
        const isCommand = msg.message && (
            msg.message.conversation?.startsWith('.') || 
            msg.message.extendedTextMessage?.text?.startsWith('.') ||
            msg.message.imageMessage?.caption?.startsWith('.') ||
            msg.message.videoMessage?.caption?.startsWith('.')
        );

        if (isCommand && state.isPrivate && !msg.key.fromMe) {
            return; // Ignore commands from others in private mode
        }

        // --- ANTI-DELETE: Detect protocol message (delete event) ---
        if (state.isAntiDelete && msg.message?.protocolMessage?.type === 0) {
            const deletedKey = msg.message.protocolMessage.key;
            // The person who DELETED is msg.key.participant (who triggered this protocol message)
            // The deletedKey.participant is the original sender of the message being deleted
            const deleter = (msg.key.participant || msg.key.remoteJid || '').split('@')[0];
            const originalSender = (deletedKey.participant || deletedKey.remoteJid || '').split('@')[0];
            const cachedMetaPath = path.join(deletedCacheDir, `${deletedKey.id}.json`);

            // Determine target JID (In-Chat or Private)
            const myJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            const targetJid = state.isAntiDeletePrivate ? myJid : from;

            console.log(`[ANTI-DELETE] @${deleter} deleted message from @${originalSender}, msgId: ${deletedKey.id} -> ${state.isAntiDeletePrivate ? 'Private' : 'In-Chat'}`);

            // Try 1: File-based cache (for media and metadata)
            const hasMeta = fs.existsSync(cachedMetaPath);
            if (hasMeta) {
                const meta = JSON.parse(fs.readFileSync(cachedMetaPath, 'utf8'));
                const mediaFile = fs.readdirSync(deletedCacheDir).find(f => f.startsWith(deletedKey.id) && !f.endsWith('.json'));

                const reportText = `╭━━━〔 *𝐀𝐍𝐓𝐈-𝐃𝐄𝐋𝐄𝐓𝐄* 〕━━━┈⊷\n┃\n┃  *👤 Deleted By:* @${deleter}\n┃  *📝 Original From:* @${originalSender}\n┃  *💬 Content:*\n┃  ${meta.text || '_[See media below]_'}\n┃\n╰━━━━━━━━━━━━━━━┈⊷`;
                await sock.sendMessage(targetJid, { text: reportText, mentions: [msg.key.participant || msg.key.remoteJid, deletedKey.participant || deletedKey.remoteJid].filter(Boolean) });

                // Re-send media if we have it
                if (mediaFile) {
                    const buffer = fs.readFileSync(path.join(deletedCacheDir, mediaFile));
                    try {
                        if (meta.mediaType === 'image') await sock.sendMessage(targetJid, { image: buffer, caption: meta.caption || '' });
                        else if (meta.mediaType === 'video') await sock.sendMessage(targetJid, { video: buffer, caption: meta.caption || '' });
                        else if (meta.mediaType === 'audio') await sock.sendMessage(targetJid, { audio: buffer, mimetype: 'audio/mpeg', ptt: meta.ptt || false });
                        else if (meta.mediaType === 'sticker') await sock.sendMessage(targetJid, { sticker: buffer });
                        else if (meta.mediaType === 'document') await sock.sendMessage(targetJid, { document: buffer, mimetype: meta.mimetype || 'application/octet-stream', fileName: meta.fileName || 'file' });
                    } catch (sendErr) {
                        console.error('[ANTI-DELETE] Failed to send cached media:', sendErr.message);
                    }
                    fs.unlinkSync(path.join(deletedCacheDir, mediaFile));
                }
                fs.unlinkSync(cachedMetaPath);
            } 
            // Try 2: In-memory store (for text messages - faster fallback)
            else if (store) {
                const oldMsg = store.get(deletedKey.id);
                if (oldMsg && oldMsg.message) {
                    const content = oldMsg.message;
                    let recoveredText = '';
                    const type = getContentType(content);
                    
                    if (type === 'conversation') recoveredText = content.conversation;
                    else if (type === 'extendedTextMessage') recoveredText = content.extendedTextMessage?.text;
                    else if (type === 'imageMessage') recoveredText = `[Image: ${content.imageMessage?.caption || 'no caption'}]`;
                    else if (type === 'videoMessage') recoveredText = `[Video: ${content.videoMessage?.caption || 'no caption'}]`;
                    else if (type === 'audioMessage') recoveredText = '[Voice Note]';
                    else if (type === 'stickerMessage') recoveredText = '[Sticker]';
                    else recoveredText = '[Media message]';

                    const reportText = `╭━━━〔 *𝐀𝐍𝐓𝐈-𝐃𝐄𝐋𝐄𝐓𝐄* 〕━━━┈⊷\n┃\n┃  *👤 Deleted By:* @${deleter}\n┃  *📝 Original From:* @${originalSender}\n┃  *💬 Content:*\n┃  ${recoveredText || '_[Media message]_'}\n┃\n╰━━━━━━━━━━━━━━━┈⊷`;
                    await sock.sendMessage(targetJid, { text: reportText, mentions: [msg.key.participant || msg.key.remoteJid, deletedKey.participant || deletedKey.remoteJid].filter(Boolean) });
                    
                    console.log(`[ANTI-DELETE] Recovered from memory store: ${deletedKey.id}`);
                } else {
                    await sock.sendMessage(targetJid, { text: `╭━━━〔 *𝐀𝐍𝐓𝐈-𝐃𝐄𝐋𝐄𝐓𝐄* 〕━━━┈⊷\n┃\n┃  *👤 Deleted By:* @${deleter}\n┃  *📝 Original From:* @${originalSender}\n┃  *📝* _Message was sent before bot started or cache expired._\n┃\n╰━━━━━━━━━━━━━━━┈⊷`, mentions: [msg.key.participant || msg.key.remoteJid, deletedKey.participant || deletedKey.remoteJid].filter(Boolean) });
                }
            } else {
                await sock.sendMessage(targetJid, { text: `╭━━━〔 *𝐀𝐍𝐓𝐈-𝐃𝐄𝐋𝐄𝐓𝐄* 〕━━━┈⊷\n┃\n┃  *👤 Deleted By:* @${deleter}\n┃  *📝 Original From:* @${originalSender}\n┃  *📝* _Message was sent before bot started._\n┃\n╰━━━━━━━━━━━━━━━┈⊷`, mentions: [msg.key.participant || msg.key.remoteJid, deletedKey.participant || deletedKey.remoteJid].filter(Boolean) });
            }
            return;
        }

        if (!msg.message) return;
        const isStatus = from === 'status@broadcast';

        // --- CACHE EVERY MESSAGE FOR ANTI-DELETE ---
        // Only cache if anti-delete is enabled and it's a private chat
        const isGroup = from.endsWith('@g.us');
        const shouldCache = state.isAntiDelete && !isStatus && !msg.key.fromMe && !isGroup;
        
        if (shouldCache) {
            try {
                const content = msg.message.ephemeralMessage?.message || msg.message;
                const type = getContentType(content);
                const msgId = msg.key.id;
                let meta = { text: '', mediaType: '', caption: '', ptt: false, mimetype: '', fileName: '' };
                
                // Check cache size - don't cache if too many files (prevent disk full)
                const cacheFiles = fs.readdirSync(deletedCacheDir);
                if (cacheFiles.length > 100) {
                    // Remove oldest files to make room
                    const sortedFiles = cacheFiles
                        .map(f => ({ name: f, mtime: fs.statSync(path.join(deletedCacheDir, f)).mtimeMs }))
                        .sort((a, b) => a.mtime - b.mtime);
                    for (let i = 0; i < 20 && i < sortedFiles.length; i++) {
                        fs.unlinkSync(path.join(deletedCacheDir, sortedFiles[i].name));
                    }
                }

                if (type === 'conversation') {
                    meta.text = content.conversation;
                } else if (type === 'extendedTextMessage') {
                    meta.text = content.extendedTextMessage.text;
                } else if (type === 'imageMessage' && content.imageMessage.fileLength <= 5 * 1024 * 1024) {
                    meta.mediaType = 'image';
                    meta.caption = content.imageMessage.caption || '';
                    meta.text = meta.caption || '[Image]';
                    const stream = await downloadContentFromMessage(content.imageMessage, 'image');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                    if (buffer.length < 5 * 1024 * 1024) {
                        fs.writeFileSync(path.join(deletedCacheDir, `${msgId}.jpg`), buffer);
                    }
                } else if (type === 'videoMessage' && content.videoMessage.fileLength <= 10 * 1024 * 1024) {
                    meta.mediaType = 'video';
                    meta.caption = content.videoMessage.caption || '';
                    meta.text = meta.caption || '[Video]';
                    const stream = await downloadContentFromMessage(content.videoMessage, 'video');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                    if (buffer.length < 10 * 1024 * 1024) {
                        fs.writeFileSync(path.join(deletedCacheDir, `${msgId}.mp4`), buffer);
                    }
                } else if (type === 'audioMessage' && content.audioMessage.fileLength <= 3 * 1024 * 1024) {
                    meta.mediaType = 'audio';
                    meta.ptt = content.audioMessage.ptt || false;
                    meta.mimetype = content.audioMessage.mimetype || 'audio/ogg; codecs=opus';
                    meta.text = '[Audio]';
                    const stream = await downloadContentFromMessage(content.audioMessage, 'audio');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                    if (buffer.length < 3 * 1024 * 1024) {
                        fs.writeFileSync(path.join(deletedCacheDir, `${msgId}.ogg`), buffer);
                    }
                } else if (type === 'stickerMessage') {
                    meta.mediaType = 'sticker';
                    meta.text = '[Sticker]';
                    const stream = await downloadContentFromMessage(content.stickerMessage, 'sticker');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                    fs.writeFileSync(path.join(deletedCacheDir, `${msgId}.webp`), buffer);
                } else if (type === 'documentMessage' && content.documentMessage.fileLength <= 10 * 1024 * 1024) {
                    meta.mediaType = 'document';
                    meta.mimetype = content.documentMessage.mimetype || 'application/octet-stream';
                    meta.fileName = content.documentMessage.fileName || 'file';
                    meta.caption = content.documentMessage.caption || '';
                    meta.text = meta.caption || content.documentMessage.title || '[Document]';
                    const stream = await downloadContentFromMessage(content.documentMessage, 'document');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                    if (buffer.length < 10 * 1024 * 1024) {
                        fs.writeFileSync(path.join(deletedCacheDir, `${msgId}.doc`), buffer);
                    }
                }

                // Save metadata
                fs.writeFileSync(path.join(deletedCacheDir, `${msgId}.json`), JSON.stringify(meta));
            } catch (err) {
                // If download fails silently continue (e.g. for text-only messages this is fine)
            }
        }

        // --- VIEW-ONCE DETECTION ---
        // Handle both wrapped format (viewOnceMessageV2) and direct format (imageMessage with viewOnce: true)
        let viewOnceContent = msg.message.viewOnceMessageV2?.message || msg.message.viewOnceMessageV2Extension?.message || msg.message.viewOnceMessage?.message;
        let msgType, mediaMessage, isViewOnce;

        if (viewOnceContent) {
            // Wrapped format
            msgType = getContentType(viewOnceContent);
            mediaMessage = viewOnceContent[msgType];
            isViewOnce = true;
            console.log(`[VIEW-ONCE-DEBUG] Wrapped format, msgType: ${msgType}, hasMedia: ${!!mediaMessage}`);
        } else {
            // Direct format
            msgType = getContentType(msg.message);
            mediaMessage = msg.message[msgType];
            isViewOnce = mediaMessage?.viewOnce === true;
            console.log(`[VIEW-ONCE-DEBUG] Direct format, msgType: ${msgType}, hasMedia: ${!!mediaMessage}, viewOnce: ${mediaMessage?.viewOnce}`);
        }

        if (isViewOnce && mediaMessage && ['imageMessage','videoMessage','audioMessage'].includes(msgType)) {
            console.log(`[VIEW-ONCE] Detected from ${from}, type: ${msgType}`);
            try {
                let mediaType = ''; let extension = '';
                if (msgType === 'imageMessage') { mediaType = 'image'; extension = 'jpg'; }
                else if (msgType === 'videoMessage') { mediaType = 'video'; extension = 'mp4'; }
                else if (msgType === 'audioMessage') { mediaType = 'audio'; extension = 'mp3'; }
                if (mediaType && mediaMessage) {
                    const stream = await downloadContentFromMessage(mediaMessage, mediaType);
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                    const senderNum = from.split('@')[0];
                    const filename = `${msg.key.id}_${senderNum}.${extension}`;
                    fs.writeFileSync(path.join(viewOnceDir, filename), buffer);
                    index[msg.key.id] = { id: msg.key.id, from, type: mediaType, filename, timestamp: Date.now(), caption: mediaMessage.caption || '' };
                    storage.saveIndex(index);
                    console.log(`[VIEW-ONCE] Saved to: ${filename}`);
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
        else if (command === 'private') {
            const toggle = args[0]?.toLowerCase();
            if (toggle === 'on') { 
                state.isPrivate = true; 
                storage.saveState(state); 
                await reply('🔒 *Private Mode Enabled*\nOnly you can trigger bot commands now.'); 
            }
            else if (toggle === 'off') { 
                state.isPrivate = false; 
                storage.saveState(state); 
                await reply('🔓 *Private Mode Disabled*\nAnyone in your chats/groups can trigger bot commands.'); 
            }
            else { 
                await reply(`Bot is currently in *${state.isPrivate ? 'PRIVATE' : 'PUBLIC'}* mode.\nUse .private on/off to toggle.`); 
            }
        }
        else if (command === 'antidelete') {
            const toggle = args[0]?.toLowerCase();
            if (toggle === 'on') { 
                state.isAntiDelete = true; 
                storage.saveState(state); 
                await reply('🛡️ *Anti-Delete Enabled*\nDeleted messages will now be recovered.'); 
            }
            else if (toggle === 'off') { 
                state.isAntiDelete = false; 
                storage.saveState(state); 
                await reply('❌ *Anti-Delete Disabled*\nDeleted messages will not be recovered.'); 
            }
            else { 
                await reply(`Anti-Delete is currently *${state.isAntiDelete ? 'ON 🛡️' : 'OFF ❌'}*\nUse .antidelete on/off to toggle.`); 
            }
        }
        else if (command === 'antideletep') {
            const toggle = args[0]?.toLowerCase();
            if (toggle === 'on') { 
                state.isAntiDeletePrivate = true; 
                storage.saveState(state); 
                await reply('👤 *Private Anti-Delete Enabled*\nRecovered messages will now be sent only to you.'); 
            }
            else if (toggle === 'off') { 
                state.isAntiDeletePrivate = false; 
                storage.saveState(state); 
                await reply('💬 *In-Chat Anti-Delete Enabled*\nRecovered messages will be sent in the chat where they were deleted.'); 
            }
            else { 
                await reply(`Private Anti-Delete is: *${state.isAntiDeletePrivate ? 'ENABLED 👤' : 'DISABLED 💬'}*\nUse .antideletep on/off to toggle.`); 
            }
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
┃  ⋄ *.hack* <name> - Fun hack simulation
┃  ⋄ *.sticker* - Convert image/video to sticker
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
┃  ⋄ *.private <on/off>* - ${state.isPrivate ? 'Locked 🔒' : 'Public 🔓'}
┃  ⋄ *.antidelete <on/off>* - ${state.isAntiDelete ? 'ON 🛡️' : 'OFF ❌'}
┃  ⋄ *.antideletep <on/off>* - ${state.isAntiDeletePrivate ? 'Sent to You 👤' : 'In-Chat 💬'}
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
        else if (command === 'sticker') {
            const { default: handleSticker } = await import('./commands/sticker.js');
            await handleSticker(sock, from, msg, reply);
        }
        else if (command === 'hack') {
            const { default: handleHack } = await import('./commands/hack.js');
            await handleHack(sock, from, msg, args, reply);
        }
        else if (command === 'sync') {
            const safeUserId = String(userId).replace(/[^a-zA-Z0-9_-]/g, '_');
            console.log(`[SYNC] User: ${userId} -> Safe: ${safeUserId}`);
            
            const railwayVolume = '/data/sessions';
            const sessionsRoot = fs.existsSync('/data') ? railwayVolume : path.join(process.cwd(), 'sessions');
            const viewOnceDir = path.join(sessionsRoot, safeUserId, 'viewonce_media');
            console.log(`[SYNC] ViewOnce Dir: ${viewOnceDir}, Exists: ${fs.existsSync(viewOnceDir)}`);
            
            if (fs.existsSync(viewOnceDir)) {
                const files = fs.readdirSync(viewOnceDir);
                console.log(`[SYNC] Files found: ${files.length}`, files);
            }
            
            const result = await syncUserToCloudinary(safeUserId);
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
