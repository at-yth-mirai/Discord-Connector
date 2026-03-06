require('dotenv').config();
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');

const commands = [{
  name: 'upload',
  description: 'Get a signed URL to upload a file to Cloudflare R2',
  options: [{
    name: 'filename',
    description: 'Optional hint for the upload page; the selected file name is used by default',
    type: 3, // STRING
    required: false
  }]
}];

const rest = new REST({ version: '9' }).setToken(process.env.DISCORD_BOT_TOKEN);

(async () => {
  try {
    const GUILD_ID = process.env.TEST_GUILD_ID; // optional
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, GUILD_ID), { body: commands });
      console.log('Registered guild commands');
    } else {
      await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
      console.log('Registered global commands');
    }
  } catch (err) {
    console.error(err);
  }
})();
