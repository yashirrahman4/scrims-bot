const { REST, Routes } = require('discord.js');
const config = require('../src/config');
const { commands } = require('../src/commands');

async function main() {
  if (!config.token || !config.clientId || !config.guildId) {
    console.error('❌ Set DISCORD_TOKEN, CLIENT_ID and GUILD_ID in .env first.');
    process.exit(1);
  }
  const rest = new REST({ version: '10' }).setToken(config.token);
  console.log(`Registering ${commands.length} command(s) for guild ${config.guildId}…`);
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: commands });
  console.log('✅ Commands registered.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
