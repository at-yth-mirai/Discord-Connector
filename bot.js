require('dotenv').config();
const { Client, Intents } = require('discord.js');
const fetch = require('node-fetch');
const crypto = require('crypto');
const http = require('http');

const client = new Client({ intents: [Intents.FLAGS.GUILDS] });

client.once('ready', () => console.log('Discord Bot ready!'));

async function handleInteraction(interaction) {
  if (!interaction.isCommand()) return;
  if (interaction.commandName === 'upload') {
    try {
      // Acknowledge immediately to avoid timeout (guarded for tests)
      // On Cloud Run without "CPU always allocated", this might still be sluggish,
      // but deferReply is the best we can do in code.
      if (interaction.deferReply) {
        await interaction.deferReply({ ephemeral: true });
      }

      // The filename option is purely a *hint* – if the user doesn't care,
      // we leave it off and the client will simply use whatever file they
      // actually pick.
      const filenameOption = interaction.options.getString('filename');

      // Generate a short-lived session identifier and HMAC token to include in the Pages URL.
      const secret = process.env.UPLOAD_SECRET_KEY;
      if (!secret) {
        throw new Error('UPLOAD_SECRET_KEY is not configured in the environment.');
      }

      const sessionId = Math.random().toString(36).slice(2, 10);
      const payload = {
        sessionId,
        exp: Date.now() + 15 * 60 * 1000, // 15 minutes from now
        channelId: interaction.channelId,
        userId: interaction.user.id
      };

      const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const signature = crypto.createHmac('sha256', secret)
        .update(payloadB64)
        .digest('base64url');

      const token = `${payloadB64}.${signature}`;

      const pagesBase = process.env.WORKER_URL.replace(/\/$/, '');
      let pagesUrl = `${pagesBase}/?token=${token}`;
      if (filenameOption) {
        pagesUrl += `&filename=${encodeURIComponent(filenameOption)}`;
      }
      console.log(`Generated upload URL (hint=${filenameOption || '<none>'}): ${pagesUrl}`);

      if (interaction.editReply) {
        await interaction.editReply(`Upload page: ${pagesUrl}`);
      } else if (interaction.reply) {
        await interaction.reply(`Upload page: ${pagesUrl}`);
      }
    } catch (e) {
      console.error('Error handling upload command:', e);
      try {
        if (interaction.editReply) {
          await interaction.editReply({ content: 'Failed to generate upload link.' });
        } else if (interaction.reply) {
          await interaction.reply({ content: 'Failed to generate upload link.', ephemeral: true });
        }
      } catch (replyError) {
        console.error('Failed to send error reply:', replyError);
      }
    }
  }
}

client.on('interactionCreate', handleInteraction);

module.exports = { handleInteraction };

// When executed directly, start the bot. This prevents tests from attempting
// to connect to Discord when they `require('./bot')`.
if (require.main === module) {
  client.login(process.env.DISCORD_BOT_TOKEN);

  // Cloud Run requires the container to listen on a port.
  // We create a dummy HTTP server to pass health checks.
  const PORT = process.env.PORT || 8080;
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Discord Bot is running.\n');
  }).listen(PORT, () => {
    console.log(`Cloud Run health check server listening on port ${PORT}`);
  });
}
