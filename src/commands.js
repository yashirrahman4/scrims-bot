const { SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('setup-panel')
    .setDescription('Post a bot panel in this channel (Admin only)')
    .setDMPermission(false)
    .addStringOption((o) =>
      o
        .setName('panel')
        .setDescription('Which panel to post')
        .setRequired(true)
        .addChoices(
          { name: 'Team Verification', value: 'team' },
          { name: 'Scrim Registration', value: 'scrim' },
          { name: 'Tournament Registration', value: 'tournament' },
          { name: 'Admin Control Panel', value: 'admin' }
        )
    )
    .toJSON(),
];

module.exports = { commands };
