import { GoogleGenerativeAI } from '@google/generative-ai';

export default async (sock, from, msg, args, reply) => {
    const apiKey = process.env.GEMINI_API_KEY;
    
    console.log('[AI] Checking API key...', apiKey ? 'Key exists' : 'Key NOT found');
    
    if (!apiKey) {
        console.error('[AI] GEMINI_API_KEY not found in environment');
        return reply('🤖 *AI brain is offline!*\n\nPlease set `GEMINI_API_KEY` in Railway environment variables.\n\nGet a free key at: https://makersuite.google.com/app/apikey');
    }

    if (!args[0]) return reply('❓ Please ask a question!\n\n*Example:* `.ai what is the capital of Ghana?`');

    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        
        const prompt = args.join(' ');
        console.log(`[AI] Query: ${prompt.substring(0, 50)}...`);
        
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        
        console.log(`[AI] Response received (${text.length} chars)`);
        await reply(`🤖 *𝐀𝐈 𝐑𝐄𝐒𝐏𝐎𝐍𝐒𝐄*\n\n${text}`);

    } catch(e) {
        console.error('[AI Error]', e);
        
        // More specific error messages
        let errorMsg = '❌ *AI Error:* Failed to generate response.';
        
        if (e.message?.includes('API key not valid')) {
            errorMsg = '❌ *AI Error:* Invalid API key.\n\nPlease check your GEMINI_API_KEY is correct.';
        } else if (e.message?.includes('quota')) {
            errorMsg = '❌ *AI Error:* API quota exceeded.\n\nYou\'ve reached your daily limit.';
        } else if (e.message?.includes('safety')) {
            errorMsg = '❌ *AI Error:* Content blocked by safety filters.';
        } else if (e.message?.includes('fetch failed') || e.message?.includes('network')) {
            errorMsg = '❌ *AI Error:* Network error.\n\nPlease check your internet connection.';
        } else if (e.status === 429) {
            errorMsg = '❌ *AI Error:* Rate limited.\n\nToo many requests, please try again later.';
        }
        
        reply(errorMsg);
    }
};
