import { downloadContentFromMessage } from '@whiskeysockets/baileys';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use static ffmpeg binary if available, otherwise fallback to system
if (ffmpegStatic) {
    ffmpeg.setFfmpegPath(ffmpegStatic);
}

export default async (sock, from, msg, reply) => {
    try {
        // Try getting media from current message or quoted message
        const isQuoted = !!msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
        const targetMsg = isQuoted ? msg.message.extendedTextMessage.contextInfo.quotedMessage : msg.message;
        
        if (!targetMsg || (!targetMsg.imageMessage && !targetMsg.videoMessage)) {
             return reply('❌ Please reply to an image or short video with .sticker');
        }

        const type = targetMsg.imageMessage ? 'image' : 'video';
        const mediaMessage = targetMsg[type + 'Message'];
        
        if (type === 'video' && mediaMessage.seconds > 10) {
            return reply('❌ Video cannot exceed 10 seconds for stickers.');
        }

        await reply('⏳ Generating sticker...');

        const stream = await downloadContentFromMessage(mediaMessage, type);
        let buffer = Buffer.from([]);
        for await(const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }

        const tempInput = path.join(__dirname, '..', '..', `temp_${msg.key.id}.${type === 'image' ? 'jpg' : 'mp4'}`);
        const tempOutput = path.join(__dirname, '..', '..', `temp_${msg.key.id}.webp`);
        fs.writeFileSync(tempInput, buffer);

        // Convert using ffmpeg
        ffmpeg(tempInput)
            .inputOptions(['-y'])
            .outputOptions(
                type === 'image' ? [
                    '-vcodec', 'libwebp',
                    '-vf', "scale='min(320,iw)':min'(320,ih)':force_original_aspect_ratio=decrease,fps=15, pad=320:320:-1:-1:color=white@0.0, split [a][b]; [a] palettegen=reserve_transparent=on:transparency_color=ffffff [p]; [b][p] paletteuse"
                ] : [
                    '-vcodec', 'libwebp',
                    '-vf', "scale='min(320,iw)':min'(320,ih)':force_original_aspect_ratio=decrease,fps=15, pad=320:320:-1:-1:color=white@0.0, split [a][b]; [a] palettegen=reserve_transparent=on:transparency_color=ffffff [p]; [b][p] paletteuse",
                    '-loop', '0',
                    '-ss', '00:00:00.0',
                    '-t', '00:00:10.0',
                    '-preset', 'default',
                    '-an',
                    '-vsync', '0'
                ]
            )
            .toFormat('webp')
            .save(tempOutput)
            .on('end', async () => {
                await sock.sendMessage(from, { sticker: { url: tempOutput } }, { quoted: msg });
                fs.unlinkSync(tempInput);
                fs.unlinkSync(tempOutput);
            })
            .on('error', async (err) => {
                console.error('Sticker ffmpeg error:', err);
                await reply('❌ Failed to convert media to sticker.');
                if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput);
                if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);
            });

    } catch(e) {
        console.error('Sticker command error:', e);
        reply('❌ Error generating sticker');
    }
};
