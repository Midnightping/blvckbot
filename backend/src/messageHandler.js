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

    if (!fs.existsSync(viewOnceDir)) fs.mkdirSync(viewOnceDir, { recursive: true });

    let state = { autoViewStatus: false };
    if (fs.existsSync(statePath)) {
        try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (e) {}
    }

    let index = {};
    if (fs.existsSync(viewOnceIndexPath)) {
        try { index = JSON.parse(fs.readFileSync(viewOnceIndexPath, 'utf8')); } catch (e) {}
    }

    return { state, index, statePath, viewOnceDir, viewOnceIndexPath,
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
        const { state, index, viewOnceDir } = storage;
        const from = msg.key.remoteJid;

        if (msg.message?.protocolMessage?.type === 0) {
            const deletedKey = msg.message.protocolMessage.key;
            if (store) {
                const oldMsg = store.get(deletedKey.id);
                if (oldMsg && oldMsg.message) {
                    const type = getContentType(oldMsg.message);
                    let contentText = '';
                    if (type === 'conversation') contentText = oldMsg.message.conversation;
                    else if (type === 'extendedTextMessage') contentText = oldMsg.message.extendedTextMessage.text;
                    else if (type === 'imageMessage') contentText = `[Image attached: ${oldMsg.message.imageMessage.caption || ''}]`;
                    else if (type === 'videoMessage') contentText = `[Video attached: ${oldMsg.message.videoMessage.caption || ''}]`;

                    await sock.sendMessage(from, { text: `🚨 *Anti-Delete Intercept* 🚨\nA message was deleted!\n\n_Recovered text:_\n${contentText}` });
                    try { await sock.sendMessage(from, { forward: oldMsg, force: true }); } catch (err) {}
                }
            }
            return;
        }

        if (!msg.message) return;
        const isStatus = from === 'status@broadcast';

        let viewOnceContent = msg.message.viewOnceMessageV2?.message || 
                            msg.message.viewOnceMessageV2Extension?.message ||
                            msg.message.viewOnceMessage?.message ||
                            msg.message;

        const msgType = getContentType(viewOnceContent);
        const isViewOnce = viewOnceContent?.[msgType]?.viewOnce;

        if (isViewOnce) {
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

        const type = getContentType(msg.message);
        let text = '';
        if (type === 'conversation') text = msg.message.conversation;
        else if (type === 'extendedTextMessage') text = msg.message.extendedTextMessage.text;
        else if (type === 'imageMessage' && msg.message.imageMessage.caption) text = msg.message.imageMessage.caption;
        else if (type === 'videoMessage' && msg.message.videoMessage.caption) text = msg.message.videoMessage.caption;

        if (!text.startsWith('.')) return;
        const args = text.slice(1).trim().split(/ +/);
        const command = args.shift().toLowerCase();
        const reply = async (textInfo) => await sock.sendMessage(from, { text: textInfo }, { quoted: msg });

        if (command === 'ping') {
            await reply('Pong! Bot is active 🤖');
        } 
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
┃  ⋄ *.vv*  - Recover View-Once
┃  ⋄ *.vvp* - Recover View-Once
┃  ⋄ *.save* - Save Status/Media
┃  ⋄ *.savep* - Save Status/Media
┃  ⋄ *.menu* - Show this menu
┃  ⋄ *.ping* - Check bot speed
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
        else if (command === 'sync') {
            const result = await syncUserToCloudinary(userId);
            if (result.success) await reply(`✅ Sync completed! Uploaded ${result.count} files.`);
            else await reply(`❌ Sync failed: ${result.error}`);
        }
        else if (command === 'save' || command === 'savep') {
            const contextInfo = msg.message.extendedTextMessage?.contextInfo;
            const isQuoted = !!contextInfo?.quotedMessage;
            if (!isQuoted) return reply(`❌ Reply to a status or media with *.${command}* to download it.`);
            
            const quotedMsg = contextInfo.quotedMessage;
            const qType = getContentType(quotedMsg);
            
            if (qType === 'imageMessage' || qType === 'videoMessage' || qType === 'audioMessage') {
                try {
                    const mType = qType.replace('Message', '');
                    const stream = await downloadContentFromMessage(quotedMsg[qType], mType);
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                    
                    const caption = quotedMsg[qType].caption || '';
                    
                    // Determine Target JID
                    let targetJid;
                    if (command === 'savep') {
                        targetJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                    } else {
                        // If it is a status reply, 'from' might be status@broadcast, so we use quoted participant
                        targetJid = (from === 'status@broadcast') ? contextInfo.participant : from;
                    }
                    
                    if (mType === 'image') await sock.sendMessage(targetJid, { image: buffer, caption: `📥 *Saved Media*\n\n${caption}` });
                    else if (mType === 'video') await sock.sendMessage(targetJid, { video: buffer, caption: `📥 *Saved Media*\n\n${caption}` });
                    else if (mType === 'audio') await sock.sendMessage(targetJid, { audio: buffer, mimetype: 'audio/mpeg' });
                    
                    await sock.sendMessage(from, { react: { text: "✅", key: msg.key } });
                } catch (err) { await reply('❌ Failed to save media.'); }
            } else {
                await reply('❌ The replied message is not a media file.');
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
                if (!saved) return reply('❌ Not found.');
                const buffer = fs.readFileSync(path.join(viewOnceDir, saved.filename));
                if (saved.type === 'image') await sock.sendMessage(from, { image: buffer, caption: `🔒 Recovered\n${saved.caption}` }, { quoted: msg });
                else if (saved.type === 'video') await sock.sendMessage(from, { video: buffer, caption: `🔒 Recovered\n${saved.caption}` }, { quoted: msg });
                else if (saved.type === 'audio') await sock.sendMessage(from, { audio: buffer, mimetype: 'audio/mpeg' }, { quoted: msg });
            }
        }
        else if (command === 'vv' || command === 'vvp') {
            const isQuoted = !!msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
            if (!isQuoted) return reply(`❌ Reply to a view-once message.`);
            const quotedMsg = msg.message.extendedTextMessage.contextInfo.quotedMessage;
            let unwrappedQuoted = quotedMsg.viewOnceMessageV2?.message || quotedMsg.viewOnceMessageV2Extension?.message || quotedMsg.viewOnceMessage?.message || quotedMsg;
            const qType = getContentType(unwrappedQuoted);
            if (!unwrappedQuoted[qType]?.viewOnce) return reply('❌ Not a view-once message.');
            try {
                let mediaType = ''; let mediaMessage = null;
                if (qType === 'imageMessage') { mediaType = 'image'; mediaMessage = unwrappedQuoted.imageMessage; }
                else if (qType === 'videoMessage') { mediaType = 'video'; mediaMessage = unwrappedQuoted.videoMessage; }
                else if (qType === 'audioMessage') { mediaType = 'audio'; mediaMessage = unwrappedQuoted.audioMessage; }
                if (mediaType && mediaMessage) {
                    if (command === 'vv') await reply('⏳ Retrieving...');
                    const stream = await downloadContentFromMessage(mediaMessage, mediaType);
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                    if (command === 'vvp') {
                        const myJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                        const rawSender = (msg.key.participant || from).split('@')[0].split(':')[0];
                        const senderNum = rawSender.startsWith('+') ? rawSender : `+${rawSender}`;
                        const privateCaption = `✅ *View-Once Retrieved*\n👤 *From:* ${senderNum}\n\n${mediaMessage.caption || ''}`;
                        if (mediaType === 'image') await sock.sendMessage(myJid, { image: buffer, caption: privateCaption });
                        else if (mediaType === 'video') await sock.sendMessage(myJid, { video: buffer, caption: privateCaption });
                        else if (mediaType === 'audio') await sock.sendMessage(myJid, { audio: buffer, mimetype: 'audio/mpeg' });
                        await sock.sendMessage(from, { react: { text: "👍", key: msg.key } });
                    } else {
                        await sendRecoveredViewOnce(sock, from, msg, mediaType, buffer, mediaMessage.caption || '');
                    }
                }
            } catch (err) { await reply('❌ Failed.'); }
        }
    } catch (err) {}
}
