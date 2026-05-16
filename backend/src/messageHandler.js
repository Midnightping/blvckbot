import fs from 'fs';
import path from 'path';
import { getContentType, downloadContentFromMessage } from '@whiskeysockets/baileys';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to get user-specific storage paths
const getUserStorage = (userId) => {
    // Determine the sessions root (same logic as sessionManager)
    const railwayVolume = '/data/sessions';
    const sessionsRoot = fs.existsSync('/data') ? railwayVolume : path.join(process.cwd(), 'sessions');
    const userDir = path.join(sessionsRoot, userId);
    
    if (!fs.existsSync(userDir)) {
        fs.mkdirSync(userDir, { recursive: true });
    }

    const statePath = path.join(userDir, 'bot_state.json');
    const viewOnceDir = path.join(userDir, 'viewonce_media');
    const viewOnceIndexPath = path.join(userDir, 'viewonce_index.json');

    if (!fs.existsSync(viewOnceDir)) {
        fs.mkdirSync(viewOnceDir, { recursive: true });
    }

    // Load state
    let state = { autoViewStatus: false };
    if (fs.existsSync(statePath)) {
        state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    }

    // Load index
    let index = {};
    if (fs.existsSync(viewOnceIndexPath)) {
        index = JSON.parse(fs.readFileSync(viewOnceIndexPath, 'utf8'));
    }

    return {
        state,
        index,
        statePath,
        viewOnceDir,
        viewOnceIndexPath,
        saveState: (newState) => fs.writeFileSync(statePath, JSON.stringify(newState, null, 2)),
        saveIndex: (newIndex) => fs.writeFileSync(viewOnceIndexPath, JSON.stringify(newIndex, null, 2))
    };
};

const sendRecoveredViewOnce = async (sock, from, msg, mediaType, buffer, caption) => {
    const finalCaption = caption ? `✅ *View-Once Retrieved*\n\n${caption}` : '✅ *View-Once Retrieved*';

    if (mediaType === 'image') {
        await sock.sendMessage(from, { image: buffer, caption: finalCaption }, { quoted: msg });
    } else if (mediaType === 'video') {
        await sock.sendMessage(from, { video: buffer, caption: finalCaption }, { quoted: msg });
    } else if (mediaType === 'audio') {
        await sock.sendMessage(from, { audio: buffer, mimetype: 'audio/mpeg' }, { quoted: msg });
    }
};

export default async function messageHandler(sock, m, store, userId) {
    try {
        if (m.type !== 'notify') return;
        const msg = m.messages[0];
        
        // Get private user storage
        const storage = getUserStorage(userId);
        const { state, index, viewOnceDir } = storage;

        // Anti-Delete Logic
        if (msg.message?.protocolMessage?.type === 0) {
            const deletedKey = msg.message.protocolMessage.key;
            if (store) {
                const oldMsg = store.get(deletedKey.id);
                if (oldMsg && oldMsg.message) {
                    const from = msg.key.remoteJid;
                    const type = getContentType(oldMsg.message);
                    let contentText = '';
                    if (type === 'conversation') contentText = oldMsg.message.conversation;
                    else if (type === 'extendedTextMessage') contentText = oldMsg.message.extendedTextMessage.text;
                    else if (type === 'imageMessage') contentText = `[Image attached: ${oldMsg.message.imageMessage.caption || ''}]`;
                    else if (type === 'videoMessage') contentText = `[Video attached: ${oldMsg.message.videoMessage.caption || ''}]`;

                    await sock.sendMessage(from, { 
                        text: `🚨 *Anti-Delete Intercept* 🚨\nA message was deleted!\n\n_Recovered text:_\n${contentText}` 
                    });
                    
                    try {
                        await sock.sendMessage(from, { forward: oldMsg, force: true });
                    } catch (err) {
                        console.error('Anti-delete forward failed:', err);
                    }
                }
            }
            return;
        }

        if (!msg.message) return;

        const from = msg.key.remoteJid;
        const isStatus = from === 'status@broadcast';

        // View-Once Message Detection (Automatic save for sync)
        const msgType = getContentType(msg.message);
        if (msg.message[msgType]?.viewOnce) {
            try {
                let mediaType = '';
                let mediaMessage = null;
                let extension = '';
                
                if (msgType === 'imageMessage') {
                    mediaType = 'image';
                    mediaMessage = msg.message.imageMessage;
                    extension = 'jpg';
                } else if (msgType === 'videoMessage') {
                    mediaType = 'video';
                    mediaMessage = msg.message.videoMessage;
                    extension = 'mp4';
                } else if (msgType === 'audioMessage') {
                    mediaType = 'audio';
                    mediaMessage = msg.message.audioMessage;
                    extension = 'mp3';
                }

                if (mediaType && mediaMessage) {
                    const stream = await downloadContentFromMessage(mediaMessage, mediaType);
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

                    const filename = `${msg.key.id}.${extension}`;
                    fs.writeFileSync(path.join(viewOnceDir, filename), buffer);

                    index[msg.key.id] = {
                        id: msg.key.id,
                        from: from,
                        type: mediaType,
                        filename: filename,
                        timestamp: Date.now(),
                        caption: mediaMessage.caption || ''
                    };
                    storage.saveIndex(index);
                    // We also send it back to them in the current chat as per earlier requirements
                    await sendRecoveredViewOnce(sock, from, msg, mediaType, buffer, mediaMessage.caption || '');
                }
            } catch (err) {
                console.error('[VIEW-ONCE] Error:', err);
            }
        }

        if (isStatus) {
            if (state.autoViewStatus && !msg.key.fromMe) {
                await sock.readMessages([msg.key]);
            }
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
            if (toggle === 'on') {
                state.autoViewStatus = true;
                storage.saveState(state);
                await reply('✅ Auto Status Viewer enabled.');
            } else if (toggle === 'off') {
                state.autoViewStatus = false;
                storage.saveState(state);
                await reply('❌ Auto Status Viewer disabled.');
            } else {
                await reply(`Auto Viewer is: ${state.autoViewStatus ? 'ON' : 'OFF'}\nUse .autoview on/off`);
            }
        }
        else if (command === 'menu') {
            await reply(`*🤖 BOT MENU 🤖*\n\n*Status:* Active 🟢\n\n*Commands:*\n.autoview <on/off>\n.vv - Recover (reply)\n.vvp - Recover to Private\n.viewonce - List yours\n.ping`);
        }
        else if (command === 'viewonce' || command === 'vo') {
            const action = args[0]?.toLowerCase();
            if (!action) {
                const savedKeys = Object.keys(index);
                if (savedKeys.length === 0) return reply('📭 No saved view-once messages.');
                let listText = `🔒 *Your Saved View-Once Messages*\n\n`;
                savedKeys.forEach((key, i) => {
                    const item = index[key];
                    listText += `${i + 1}. ${item.type.toUpperCase()} - ${new Date(item.timestamp).toLocaleString()}\nID: ${item.id}\n\n`;
                });
                await reply(listText + `Use .viewonce get <id>`);
            } else if (action === 'get') {
                const msgId = args[1];
                const saved = index[msgId];
                if (!saved) return reply('❌ Message not found.');
                const buffer = fs.readFileSync(path.join(viewOnceDir, saved.filename));
                if (saved.type === 'image') await sock.sendMessage(from, { image: buffer, caption: `🔒 Recovered\n${saved.caption}` }, { quoted: msg });
                else if (saved.type === 'video') await sock.sendMessage(from, { video: buffer, caption: `🔒 Recovered\n${saved.caption}` }, { quoted: msg });
                else if (saved.type === 'audio') await sock.sendMessage(from, { audio: buffer, mimetype: 'audio/mpeg' }, { quoted: msg });
            } else if (action === 'clear') {
                const savedKeys = Object.keys(index);
                savedKeys.forEach(k => {
                    const p = path.join(viewOnceDir, index[k].filename);
                    if (fs.existsSync(p)) fs.unlinkSync(p);
                });
                storage.saveIndex({});
                await reply('🗑️ Your saved messages cleared.');
            }
        }
        else if (command === 'vv' || command === 'vvp') {
            const isQuoted = !!msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
            if (!isQuoted) return reply(`❌ Reply to a view-once message.`);
            const quotedMsg = msg.message.extendedTextMessage.contextInfo.quotedMessage;
            const quotedType = getContentType(quotedMsg);
            if (!quotedMsg[quotedType]?.viewOnce) return reply('❌ Not a view-once message.');
            
            try {
                let mediaType = '';
                let mediaMessage = null;
                let extension = '';
                if (quotedType === 'imageMessage') { mediaType = 'image'; mediaMessage = quotedMsg.imageMessage; extension = 'jpg'; }
                else if (quotedType === 'videoMessage') { mediaType = 'video'; mediaMessage = quotedMsg.videoMessage; extension = 'mp4'; }
                else if (quotedType === 'audioMessage') { mediaType = 'audio'; mediaMessage = quotedMsg.audioMessage; extension = 'mp3'; }
                
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
            } catch (err) {
                await reply('❌ Failed.');
            }
        }
    } catch (err) {
        console.error('[ERROR]', err);
    }
}
