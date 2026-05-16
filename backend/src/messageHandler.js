import fs from 'fs';
import path from 'path';
import { getContentType, downloadContentFromMessage } from '@whiskeysockets/baileys';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Simple JSON state for autoview setting
const statePath = path.join(__dirname, '..', 'bot_state.json');
let botState = { autoViewStatus: false };

if (fs.existsSync(statePath)) {
    botState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

const saveState = () => {
    fs.writeFileSync(statePath, JSON.stringify(botState, null, 2));
};

// View-once message storage
const viewOnceDir = path.join(__dirname, '..', 'viewonce_media');
if (!fs.existsSync(viewOnceDir)) {
    fs.mkdirSync(viewOnceDir, { recursive: true });
}

const viewOnceIndexPath = path.join(__dirname, '..', 'viewonce_index.json');
let viewOnceIndex = {};

if (fs.existsSync(viewOnceIndexPath)) {
    viewOnceIndex = JSON.parse(fs.readFileSync(viewOnceIndexPath, 'utf8'));
}

const saveViewOnceIndex = () => {
    fs.writeFileSync(viewOnceIndexPath, JSON.stringify(viewOnceIndex, null, 2));
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
        
        // Anti-Delete Logic
        if (msg.message?.protocolMessage?.type === 0) {
            const deletedKey = msg.message.protocolMessage.key;
            if (store) {
                const oldMsg = store.get(deletedKey.id);
                if (oldMsg && oldMsg.message) {
                    console.log(`[ANTI-DELETE] Intercepted deleted message from ${deletedKey.participant || msg.key.remoteJid}`);
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
                    
                    // Try to forward the original message to preserve media
                    try {
                        await sock.sendMessage(from, { forward: oldMsg, force: true });
                    } catch (err) {
                        console.error('Anti-delete forward failed natively:', err);
                    }
                }
            }
            return;
        }

        if (!msg.message) return; // sometimes empty messages arrive

        const from = msg.key.remoteJid;
        const isStatus = from === 'status@broadcast';

        // View-Once Message Detection and Saving
        const msgType = getContentType(msg.message);
        if (msg.message[msgType]?.viewOnce) {
            console.log(`[VIEW-ONCE] Detected view-once message from ${from}`);
            
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
                    for await (const chunk of stream) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }

                    const filename = `${msg.key.id}.${extension}`;
                    const filepath = path.join(viewOnceDir, filename);
                    fs.writeFileSync(filepath, buffer);

                    // Store metadata
                    viewOnceIndex[msg.key.id] = {
                        id: msg.key.id,
                        from: from,
                        participant: msg.key.participant,
                        type: mediaType,
                        filename: filename,
                        timestamp: Date.now(),
                        caption: mediaMessage.caption || ''
                    };
                    saveViewOnceIndex();

                    console.log(`[VIEW-ONCE] Saved view-once ${mediaType} to ${filename}`);

                    await sendRecoveredViewOnce(sock, from, msg, mediaType, buffer, mediaMessage.caption || '');
                }
            } catch (err) {
                console.error('[VIEW-ONCE] Error saving view-once message:', err);
            }
        }

        // 1. Handle Status Viewer
        if (isStatus) {
            if (botState.autoViewStatus && !msg.key.fromMe) {
                console.log(`[STATUS] Viewing status from: ${msg.key.participant}`);
                await sock.readMessages([msg.key]);
            }
            return; // We don't process status further
        }

        // Determine message text (handles text, extended text, and media captions)
        const type = getContentType(msg.message);
        let text = '';
        if (type === 'conversation') {
            text = msg.message.conversation;
        } else if (type === 'extendedTextMessage') {
            text = msg.message.extendedTextMessage.text;
        } else if (type === 'imageMessage' && msg.message.imageMessage.caption) {
            text = msg.message.imageMessage.caption;
        } else if (type === 'videoMessage' && msg.message.videoMessage.caption) {
            text = msg.message.videoMessage.caption;
        }

        if (!text.startsWith('.')) return; // Only process commands starting with '.'

        const args = text.slice(1).trim().split(/ +/);
        const command = args.shift().toLowerCase();

        // simple helper for replying
        const reply = async (textInfo) => {
            await sock.sendMessage(from, { text: textInfo }, { quoted: msg });
        };

        console.log(`[COMMAND] received: .${command} with args:`, args);

        // 2. Route Commands
        if (command === 'ping') {
            await reply('Pong! Bot is active 🤖');
        } 
        else if (command === 'autoview') {
            const toggle = args[0]?.toLowerCase();
            if (toggle === 'on') {
                botState.autoViewStatus = true;
                saveState();
                await reply('✅ Auto Status Viewer enabled.');
            } else if (toggle === 'off') {
                botState.autoViewStatus = false;
                saveState();
                await reply('❌ Auto Status Viewer disabled.');
            } else {
                await reply(`Auto Viewer is currently: ${botState.autoViewStatus ? 'ON' : 'OFF'}\nUse .autoview on/off`);
            }
        }
        else if (command === 'menu') {
            const menuText = `*🤖 BOT MENU 🤖*\n\n` +
                `*Status:* Active 🟢\n\n` +
                `*Commands:*\n` +
                `.autoview <on/off> - Toggle auto status reading.\n` +
                `.vv - Reply to view-once message to retrieve and resend it here.\n` +
                `.vvp - Reply to view-once message to send it to your private chat.\n` +
                `.viewonce - List and retrieve saved view-once messages.\n` +
                `.ping - Check if bot is alive.`;
            await reply(menuText);
        }
        else if (command === 'viewonce' || command === 'vo') {
            const action = args[0]?.toLowerCase();
            
            if (!action) {
                // List all saved view-once messages
                const savedKeys = Object.keys(viewOnceIndex);
                if (savedKeys.length === 0) {
                    await reply('📭 No saved view-once messages.');
                    return;
                }
                
                let listText = `🔒 *Saved View-Once Messages*\n\n`;
                savedKeys.forEach((key, index) => {
                    const item = viewOnceIndex[key];
                    const date = new Date(item.timestamp).toLocaleString();
                    listText += `${index + 1}. ${item.type.toUpperCase()} - ${date}\n   Caption: ${item.caption || 'None'}\n   ID: ${item.id}\n\n`;
                });
                
                listText += `Use .viewonce get <id> to retrieve a specific message.`;
                await reply(listText);
            } else if (action === 'get') {
                const msgId = args[1];
                if (!msgId) {
                    await reply('❌ Please provide a message ID. Use .viewonce to see the list.');
                    return;
                }
                
                const saved = viewOnceIndex[msgId];
                if (!saved) {
                    await reply('❌ Message not found. Use .viewonce to see the list.');
                    return;
                }
                
                const filepath = path.join(viewOnceDir, saved.filename);
                if (!fs.existsSync(filepath)) {
                    await reply('❌ File not found on disk.');
                    return;
                }
                
                await reply(`📤 Sending saved view-once ${saved.type}...`);
                const buffer = fs.readFileSync(filepath);
                
                if (saved.type === 'image') {
                    await sock.sendMessage(from, { image: buffer, caption: `🔒 Recovered view-once image\n${saved.caption}` }, { quoted: msg });
                } else if (saved.type === 'video') {
                    await sock.sendMessage(from, { video: buffer, caption: `🔒 Recovered view-once video\n${saved.caption}` }, { quoted: msg });
                } else if (saved.type === 'audio') {
                    await sock.sendMessage(from, { audio: buffer, mimetype: 'audio/mpeg' }, { quoted: msg });
                }
            } else if (action === 'clear') {
                // Clear all saved view-once messages
                const savedKeys = Object.keys(viewOnceIndex);
                savedKeys.forEach(key => {
                    const item = viewOnceIndex[key];
                    const filepath = path.join(viewOnceDir, item.filename);
                    if (fs.existsSync(filepath)) {
                        fs.unlinkSync(filepath);
                    }
                });
                viewOnceIndex = {};
                saveViewOnceIndex();
                await reply('🗑️ All saved view-once messages cleared.');
            } else {
                await reply('❌ Invalid action. Use: .viewonce, .viewonce get <id>, or .viewonce clear');
            }
        }
        else if (command === 'vv' || command === 'vvp') {
            // Check if replying to a view-once message
            const isQuoted = !!msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
            if (!isQuoted) {
                return reply(`❌ Please reply to a view-once message with .${command}`);
            }
            
            const quotedMsg = msg.message.extendedTextMessage.contextInfo.quotedMessage;
            const quotedType = getContentType(quotedMsg);
            
            if (!quotedMsg[quotedType]?.viewOnce) {
                return reply('❌ The replied message is not a view-once message.');
            }
            
            try {
                let mediaType = '';
                let mediaMessage = null;
                let extension = '';
                let originalCaption = '';
                
                if (quotedType === 'imageMessage') {
                    mediaType = 'image';
                    mediaMessage = quotedMsg.imageMessage;
                    extension = 'jpg';
                    originalCaption = mediaMessage.caption || '';
                } else if (quotedType === 'videoMessage') {
                    mediaType = 'video';
                    mediaMessage = quotedMsg.videoMessage;
                    extension = 'mp4';
                    originalCaption = mediaMessage.caption || '';
                } else if (quotedType === 'audioMessage') {
                    mediaType = 'audio';
                    mediaMessage = quotedMsg.audioMessage;
                    extension = 'mp3';
                }
                
                if (mediaType && mediaMessage) {
                    if (command === 'vv') {
                        await reply('⏳ Retrieving view-once message...');
                    }
                    
                    const stream = await downloadContentFromMessage(mediaMessage, mediaType);
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }
                    
                    const savedId = `${msg.key.id}_${Date.now()}`;
                    const filename = `${savedId}.${extension}`;
                    const filepath = path.join(viewOnceDir, filename);
                    fs.writeFileSync(filepath, buffer);
                    
                    // Store metadata
                    viewOnceIndex[savedId] = {
                        id: savedId,
                        from: from,
                        participant: msg.key.participant,
                        type: mediaType,
                        filename: filename,
                        timestamp: Date.now(),
                        caption: originalCaption
                    };
                    saveViewOnceIndex();
                    
                    console.log(`[${command.toUpperCase()}] Saved and resending view-once ${mediaType}`);

                    if (command === 'vvp') {
                        // Send to private (self) chat
                        const myJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                        const senderNum = (msg.key.participant || from).split('@')[0];
                        const privateCaption = `✅ *View-Once Retrieved*\n👤 *From:* ${senderNum}\n\n${originalCaption}`;
                        
                        if (mediaType === 'image') {
                            await sock.sendMessage(myJid, { image: buffer, caption: privateCaption });
                        } else if (mediaType === 'video') {
                            await sock.sendMessage(myJid, { video: buffer, caption: privateCaption });
                        } else if (mediaType === 'audio') {
                            await sock.sendMessage(myJid, { audio: buffer, mimetype: 'audio/mpeg' });
                        }
                        
                        // Discrete reaction instead of message
                        await sock.sendMessage(from, { react: { text: "👍", key: msg.key } });
                    } else {
                        // Resend to the current chat
                        await sendRecoveredViewOnce(sock, from, msg, mediaType, buffer, originalCaption);
                    }
                }
            } catch (err) {
                console.error(`[${command.toUpperCase()}] Error retrieving view-once message:`, err);
                await reply('❌ Failed to retrieve view-once message.');
            }
        }

    } catch (err) {
        console.error('[ERROR in message handler]', err);
    }
}
