// Agent A slash-command builders for the scrims port.
// The integrator merges `cmdBuilders` into src/commands.js and merges
// `exportScrimSubcommand` into the existing /export command (verified/tournament).

const { SlashCommandBuilder, SlashCommandSubcommandBuilder } = require('discord.js');

const TEMPLATE_NAMES = [
  'qualification_idp',
  'qualification_results',
  'qualification_none_idp',
  'qualification_none_results',
  'ss_idp',
];

const messageTemplateCmd = new SlashCommandBuilder()
  .setName('message_template')
  .setDescription('View or edit scrims message templates (Admin only)')
  .setDMPermission(false)
  .addSubcommand((s) => s.setName('list').setDescription('List scrims message templates'))
  .addSubcommand((s) =>
    s
      .setName('set')
      .setDescription('Update a scrims message template')
      .addStringOption((o) =>
        o
          .setName('name')
          .setDescription('Template name')
          .setRequired(true)
          .addChoices(...TEMPLATE_NAMES.map((n) => ({ name: n, value: n })))
      )
      .addStringOption((o) =>
        o
          .setName('content')
          .setDescription('New template content; use {{placeholders}}')
          .setRequired(true)
      )
  )
  .toJSON();

const botHealthCmd = new SlashCommandBuilder()
  .setName('bot_health')
  .setDescription('Run scrims bot health diagnostics (Admin only)')
  .setDMPermission(false)
  .toJSON();

// Fragment merged by the integrator into the existing /export command.
const exportScrimSubcommand = new SlashCommandSubcommandBuilder()
  .setName('scrim')
  .setDescription('Export verified scrims teams + active registrations for a track (Admin only)')
  .addStringOption((o) =>
    o
      .setName('track')
      .setDescription('Scrims track')
      .setRequired(true)
      .addChoices({ name: 'OQ', value: 'OQ' }, { name: 'T3', value: 'T3' })
  )
  .toJSON();

module.exports = {
  cmdBuilders: [messageTemplateCmd, botHealthCmd],
  exportScrimSubcommand,
  TEMPLATE_NAMES,
};
