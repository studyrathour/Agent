const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// Global memory cache for mapping numbers to Session IDs
let sessionCache = {};

// ==========================================
// 1. GOOGLE JULES API LOGIC
// ==========================================
const generateNewAgent = async (customInstructions, targetBranchName) => {
  const response = await fetch('https://jules.googleapis.com/v1alpha/sessions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': process.env.JULES_API_KEY
    },
    body: JSON.stringify({
      prompt: `You are an AI coding agent. Use the existing architecture in the main branch as your base template. ${customInstructions}. Ensure all new code is pushed to a new branch named '${targetBranchName}'.`,
      sourceContext: {
        // Hardcoded to your specific GitHub repository
        source: "sources/github/studyrathour/Ai-agent-repo",
        githubRepoContext: { startingBranch: "main" }
      },
      automationMode: "AUTO_CREATE_PR",
      title: `Task for branch: ${targetBranchName}`
    })
  });
  
  if (!response.ok) throw new Error('Failed to reach Jules API');
  const data = await response.json();
  return data.name; 
};

// ==========================================
// 2. WHATSAPP CLIENT SETUP
// ==========================================
// We use LocalAuth so you don't have to scan the QR code every time Render restarts.
// The puppeteer args are strict requirements to prevent crashes on Render.
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', qr => {
  qrcode.generate(qr, { small: true });
  console.log('📱 SCAN THIS QR CODE WITH YOUR WHATSAPP TO LINK THE BOT');
});

client.on('ready', () => {
  console.log('✅ WhatsApp Bot is ready and listening!');
});

// ==========================================
// 3. WHATSAPP COMMAND LISTENER
// ==========================================
client.on('message', async message => {
  const text = message.body.trim();

  // COMMAND: @new [Instructions]
  if (text.startsWith('@new ')) {
    const prompt = text.replace('@new ', '').trim();
    const branchName = `task-${Date.now()}`; 
    
    await message.reply('⏳ Dispatching Agent Jules. Please wait...');
    
    try {
      await generateNewAgent(prompt, branchName); 
      const reply = `✅ *Agent Jules Dispatched!*\n\n📝 *Task:* ${prompt}\n🌿 *Target Branch:* ${branchName}\n\n_Vercel will auto-deploy once Jules pushes the code!_`;
      await message.reply(reply);
    } catch (error) {
      console.error(error);
      await message.reply('❌ Failed to start Jules session. Check server logs.');
    }
  }

  // COMMAND: @all (Fetch history)
  else if (text === '@all') {
    await message.reply('🔄 Fetching your Agent Jules history...');
    
    try {
      const response = await fetch('https://jules.googleapis.com/v1alpha/sessions?pageSize=5', {
        method: 'GET',
        headers: { 'x-goog-api-key': process.env.JULES_API_KEY }
      });
      const data = await response.json();
      
      if (!data.sessions || data.sessions.length === 0) {
        return message.reply('No past sessions found.');
      }

      let replyText = "🗄️ *Your Recent Jules Sessions:*\n_Reply with a number to check its status_\n\n";
      sessionCache = {}; 
      
      data.sessions.forEach((session, index) => {
        const num = index + 1; 
        const sessionId = session.name.split('/').pop();
        sessionCache[num.toString()] = sessionId; 
        
        replyText += `*[ ${num} ]* - ${session.title || 'Untitled Task'}\n🚦 Status: ${session.state}\n\n`;
      });

      await message.reply(replyText.trim());
    } catch (error) {
      console.error(error);
      await message.reply('❌ Failed to fetch sessions.');
    }
  }

  // COMMAND: Number selection for status
  else if (sessionCache[text]) {
    const sessionId = sessionCache[text];
    await message.reply('🔍 Checking live session details...');
    
    try {
      const response = await fetch(`https://jules.googleapis.com/v1alpha/sessions/${sessionId}`, {
        method: 'GET',
        headers: { 'x-goog-api-key': process.env.JULES_API_KEY }
      });
      const sessionData = await response.json();
      
      const replyText = `📌 *Session Details*\n*Task:* ${sessionData.title}\n*Status:* ${sessionData.state}\n*Started:* ${new Date(sessionData.createTime).toLocaleString()}\n\n_If COMPLETED, the code is on GitHub and Vercel is handling the rest!_`;
      
      await message.reply(replyText);
    } catch (error) {
      await message.reply('❌ Could not fetch session details.');
    }
  }
});

// ==========================================
// 4. VERCEL WEBHOOK LISTENER
// ==========================================
app.post('/webhook/vercel', async (req, res) => {
  const payload = req.body;

  if (payload.type === 'deployment.succeeded') {
    const projectName = payload.payload.deployment.name;
    const deployedUrl = `https://${payload.payload.deployment.url}`; 
    const branchName = payload.payload.deployment.meta.githubCommitRef;

    const whatsappMessage = `✅ *Deployment Live!*\nAgent Jules's code has been deployed.\n\n📦 *Project:* ${projectName}\n🌿 *Branch:* ${branchName}\n🔗 *Review it here:* ${deployedUrl}`;

    // IMPORTANT: WHATSAPP_NUMBER must be set in Render Environment Variables
    // Format: Country code + Number without the '+' (e.g., "919876543210")
    const myNumber = process.env.WHATSAPP_NUMBER + "@c.us"; 
    
    try {
      await client.sendMessage(myNumber, whatsappMessage);
    } catch (err) {
      console.error("Failed to send Vercel webhook WhatsApp message:", err);
    }
  }

  res.status(200).send('Webhook processed');
});

// ==========================================
// 5. START UP
// ==========================================
app.listen(PORT, () => {
  console.log(`🚀 Webhook Server running on port ${PORT}`);
  client.initialize();
});
