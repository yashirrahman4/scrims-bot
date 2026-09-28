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
  new SlashCommandBuilder()
    .setName('export')
    .setDescription('Export team sheets as CSV (Admin only)')
    .setDMPermission(false)
    .addSubcommand((s) => s.setName('verified').setDescription('All verified teams — full details for Krafton India Esports'))
    .addSubcommand((s) =>
      s
        .setName('tournament')
        .setDescription('Tournament registration sheet with team + player details')
        .addStringOption((o) =>
          o.setName('name').setDescription('Tournament name').setRequired(true).setAutocomplete(true)
        )
    )
    .toJSON(),
];

module.exports = { commands };
