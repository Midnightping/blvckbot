export default async (sock, from, msg, args, reply) => {
    try {
        if (!args[0]) {
            return reply('❌ Please specify a target!\n\n*Example:* `.hack romeo`');
        }

        const target = args[0]; // Use the first word after .hack
        const randomNum = Math.floor(Math.random() * 999) + 1; // Random number 1-999
        const userId = target.replace(/[^a-zA-Z0-9]/g, '').substring(0, 15) || 'target';
        const realisticEmail = `${userId}${randomNum}@gmail.com`;
        
        // Step 1
        await reply(`🔓 *INITIATING HACK SEQUENCE* 🔓\n\n👤 *Target:* ${target}\n📍 *IP:* 192.168.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}\n\n⏳ Step 1/3: Bypassing security protocols...`);
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Step 2
        await sock.sendMessage(from, { 
            text: `🔓 *HACK IN PROGRESS* 🔓\n\n✅ Step 1 Complete: Firewall bypassed\n📡 Encrypting connection...\n🔑 Generating decryption keys...\n\n⏳ Step 2/3: Extracting credentials...` 
        }, { quoted: msg });
        
        await new Promise(resolve => setTimeout(resolve, 2500));
        
        // Step 3 - Success
        await sock.sendMessage(from, { 
            text: `✅ *HACK COMPLETE* ✅\n\n👤 *User:* ${target}\n📧 *Email:* ${realisticEmail}\n🔐 *Password:* ********${randomNum}\n📱 *Phone:* +233 ${Math.floor(Math.random() * 900000000 + 100000000)}\n\n💾 *Status:* Credentials saved\n📤 *Sending to your inbox...*` 
        }, { quoted: msg });

    } catch (e) {
        console.error('[Hack command error]', e);
        reply('❌ Error running hack simulation');
    }
};
