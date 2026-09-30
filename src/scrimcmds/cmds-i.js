/**
 * Agent I — scrimport-1 slash commands.
 *
 * Exports `cmdBuilders` (merged into src/commands.js by the integrator).
 * /ss_idp subcommand manual — staff posts Room ID/password when OCR fails.
 * Admin-only enforced in the router; the handler lives in src/router.js
 * (handleSsIdpManual) because the router defers before dispatching.
 */

const { SlashCommandBuilder } = require('discord.js');

const ssIdpCommand = {
  data: new SlashCommandBuilder()
    .setName('ss_idp')
    .setDescription('Post Room ID / password to an IDP group channel.')
    .setDMPermission(false)
    .addSubcommand((sc) => sc
      .setName('manual')
      .setDescription('Manually post room details when screenshot OCR fails.')
      .addStringOption((o) => o
        .setName('track')
        .setDescription('Track (OQ or T3)')
        .setRequired(true)
        .addChoices(
          { name: 'OQ', value: 'OQ' },
          { name: 'T3', value: 'T3' },
        ))
      .addIntegerOption((o) => o
        .setName('group_no')
        .setDescription('Group number')
        .setRequired(true)
        .setMinValue(1))
      .addStringOption((o) => o
        .setName('room_id')
        .setDescription('Room ID (5–15 digits)')
        .setRequired(true))
      .addStringOption((o) => o
        .setName('password')
        .setDescription('Room password (3–20 letters/digits)')
        .setRequired(true))
      .addStringOption((o) => o
        .setName('lobby_time')
        .setDescription('Lobby start time HH:MM (IST)')
        .setRequired(false))),
};

module.exports = { cmdBuilders: [ssIdpCommand] };
