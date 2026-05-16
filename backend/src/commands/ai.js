import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
dotenv.config();

export default async (sock, from, msg, args, reply) => {
    const apiKey = process.env.GEMINI_API_KEY;
    
    if (!apiKey) {
        return reply('🤖 *AI brain is offline!*\n\nPlease add your `GEMINI_API_KEY` to the `.env` file to enable this feature.');
    }

    if (!args[0]) return reply('❓ Please ask a question!\n\n*Example:* `.ai what is the capital of Ghana?`');

    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash"});
        
        const prompt = args.join(' ');
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        
        await reply(`🤖 *𝐀𝐈 𝐑𝐄𝐒𝐏𝐎𝐍𝐒𝐄*\n\n${text}`);

    } catch(e) {
        console.error('AI error:', e);
        reply('❌ *AI Error:* Failed to generate response. Please ensure your API key is valid.');
    }
};
