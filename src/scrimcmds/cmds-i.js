/**
 * Agent I — scrimport-1 slash commands.
 *
 * Exports `cmdBuilders` (merged into src/commands.js by the integrator).
 * /ss_idp subcommand manual — staff posts Room ID/password when OCR fails.
 * Admin-only enforced in the handler.
 */

const { SlashCommandBuilder } = require('discord.js');
const { prisma } = require('../db');
const { requireAdmin, errorEmbed, successEmbed, audit } = require('../utils');

const LOBBY_TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

const ssIdpCommand = {
  data: new SlashCommandBuilder()
    .setName('ss_idp')
    .setDescription('Post Room ID / password to an IDP group channel.')
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
        .setDescription('Room ID')
        .setRequired(true))
      .addStringOption((o) => o
        .setName('password')
        .setDescription('Room password')
        .setRequired(true))
      .addStringOption((o) => o
        .setName('lobby_time')
        .setDescription('Lobby start time HH:MM (IST)')
        .setRequired(false))),

  async execute(interaction) {
    if (!(await requireAdmin(interaction))) return;
    try {
      if (interaction.options.getSubcommand() !== 'manual') return;
      const track = interaction.options.getString('track', true);
      const groupNo = interaction.options.getInteger('group_no', true);
      const roomId = interaction.options.getString('room_id', true).trim();
      const password = interaction.options.getString('password', true).trim();
      const lobbyTime = (interaction.options.getString('lobby_time') || '').trim();

      if (!/^\d{5,15}$/.test(roomId)) {
        await interaction.reply({ embeds: [errorEmbed('room_id must be 5–15 digits.')], ephemeral: true });
        return;
      }
      if (!/^[a-z0-9]{3,20}$/i.test(password)) {
        await interaction.reply({ embeds: [errorEmbed('password must be 3–20 letters/digits.')], ephemeral: true });
        return;
      }
      if (lobbyTime && !LOBBY_TIME_RE.test(lobbyTime)) {
        await interaction.reply({ embeds: [errorEmbed('lobby_time must be HH:MM (24h IST).')], ephemeral: true });
        return;
      }

      const group = await prisma.scrimGroup.findUnique({
        where: { groupType_groupNo: { groupType: track, groupNo } },
      });
      if (!group || group.status === 'DELETED' || !group.channelId) {
        await interaction.reply({
          embeds: [errorEmbed(`${track} Group ${groupNo} not found. Use an existing group channel or /create_group first.`)],
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });
      // eslint-disable-next-line global-require
      const { postRoomIdp } = require('../flows/scrimidp');
      const sent = await postRoomIdp(group.id, {
        roomId,
        password,
        lobbyTime: lobbyTime || null,
      }, interaction.client);
      if (!sent) {
        await interaction.editReply({
          embeds: [errorEmbed('Could not post to the group channel. Check that the channel still exists and try again.')],
        });
        return;
      }
      await audit('bs:ssidp:manual', interaction.user.id, `${track} G${groupNo} manual room post`);
      await interaction.editReply({
        embeds: [successEmbed(`Room details posted in ${track} Group ${groupNo}.`)],
      });
    } catch (err) {
      console.error('[cmds-i] ss_idp error:', err.message);
      try {
        const reply = { embeds: [errorEmbed('Something went wrong. Please try again.')], ephemeral: true };
        if (interaction.deferred || interaction.replied) await interaction.followUp(reply);
        else await interaction.reply(reply);
      } catch {}
    }
  },
};

module.exports = { cmdBuilders: [ssIdpCommand] };
