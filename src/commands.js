const { SlashCommandBuilder, SlashCommandSubcommandBuilder } = require('discord.js');
// Black Raven scrims port: command builders live per-module; merged here.
const cmdsV = require('./scrimcmds/cmds-v');
const cmdsG = require('./scrimcmds/cmds-g');
const cmdsI = require('./scrimcmds/cmds-i');
const cmdsA = require('./scrimcmds/cmds-a');

/** Rebuild a SubcommandBuilder from a toJSON() fragment (for merging). */
function subcommandFromJson(j) {
  const s = new SlashCommandSubcommandBuilder().setName(j.name).setDescription(j.description);
  for (const o of j.options || []) {
    if (o.type === 3) {
      s.addStringOption((opt) => {
        opt.setName(o.name).setDescription(o.description).setRequired(!!o.required);
        for (const c of o.choices || []) opt.addChoices({ name: c.name, value: c.value });
        return opt;
      });
    } else if (o.type === 4) {
      s.addIntegerOption((opt) => {
        opt.setName(o.name).setDescription(o.description).setRequired(!!o.required);
        if (o.min_value !== undefined) opt.setMinValue(o.min_value);
        if (o.max_value !== undefined) opt.setMaxValue(o.max_value);
        for (const c of o.choices || []) opt.addChoices({ name: c.name, value: c.value });
        return opt;
      });
    }
  }
  return s;
}

// Builders may be raw toJSON() or wrapped as { data } — normalize.
const norm = (b) => (b && b.data ? b.data : b);

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
          { name: 'Admin Control Panel', value: 'admin' },
          { name: 'BR Scrims Verification', value: 'br_verify' },
          { name: 'BR OQ Registration', value: 'br_oq' },
          { name: 'BR T3 Registration', value: 'br_t3' },
          { name: 'BR Scrims Admin', value: 'br_admin' },
          { name: 'BR Live Lobby', value: 'br_lobby' }
        )
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('export')
    .setDescription('Export team sheets as Excel (Admin only)')
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
    // Black Raven scrims port: /export scrim (fragment supplied by cmds-a).
    .addSubcommand(subcommandFromJson(cmdsA.exportScrimSubcommand))
    .toJSON(),
];

// Merge Black Raven scrims-port command builders (each module owns its file).
for (const b of [...cmdsV.cmdBuilders, ...cmdsG.cmdBuilders, ...cmdsI.cmdBuilders, ...cmdsA.cmdBuilders]) {
  commands.push(norm(b));
}

module.exports = { commands };
