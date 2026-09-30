const { MessageFlags } = require('discord.js');
const teamFlows = require('./flows/team');
const eventFlows = require('./flows/events');
const adminFlows = require('./flows/admin');
const idpFlows = require('./flows/idp');
const slotFlows = require('./flows/slotmanager');
const exportFlows = require('./flows/export');
const panels = require('./panels');
const scrimsFlows = require('./flows/scrims');
const scrimGroups = require('./flows/scrimgroups');
const scrimIdp = require('./flows/scrimidp');
const scrimAdmin = require('./flows/scrimadmin');
const scrimPanels = require('./scrimpanels');
const cmdsG = require('./scrimcmds/cmds-g');
const { prisma } = require('./db');
const { requireAdmin, errorEmbed, audit } = require('./utils');

/** /ss_idp manual — staff posts room credentials without OCR. */
const LOBBY_TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
/** Room ID: 5–15 digits. Exported for tests. */
function isValidRoomId(v) { return /^\d{5,15}$/.test(String(v || '').trim()); }
/** Room password: 3–20 letters/digits. Exported for tests. */
function isValidRoomPassword(v) { return /^[a-z0-9]{3,20}$/i.test(String(v || '').trim()); }
/** Lobby time: HH:MM (24h IST) or blank. Exported for tests. */
function isValidLobbyTime(v) { const t = String(v || '').trim(); return !t || LOBBY_TIME_RE.test(t); }
async function handleSsIdpManual(interaction) {
  const track = interaction.options.getString('track', true);
  const groupNo = interaction.options.getInteger('group_no', true);
  const roomId = interaction.options.getString('room_id', true).trim();
  const password = interaction.options.getString('password', true).trim();
  const lobbyTime = (interaction.options.getString('lobby_time') || '').trim();
  // Format validation (was only in the dead cmds-i.execute — now enforced here).
  if (!isValidRoomId(roomId)) {
    return interaction.editReply({ embeds: [errorEmbed('room_id must be 5–15 digits.')] });
  }
  if (!isValidRoomPassword(password)) {
    return interaction.editReply({ embeds: [errorEmbed('password must be 3–20 letters/digits.')] });
  }
  if (!isValidLobbyTime(lobbyTime)) {
    return interaction.editReply({ embeds: [errorEmbed('lobby_time must be HH:MM (24h IST).')] });
  }
  const group = await prisma.scrimGroup.findFirst({
    where: { groupType: track, groupNo, status: 'OPEN' },
  });
  if (!group || !group.channelId) {
    return interaction.editReply({ embeds: [errorEmbed(`No OPEN ${track} group ${groupNo} found.`)] });
  }
  const sent = await scrimIdp.postRoomIdp(group.id, { roomId, password, lobbyTime: lobbyTime || null }, interaction.client);
  if (!sent) {
    return interaction.editReply({ embeds: [errorEmbed('Could not post to the group channel. Check that the channel still exists and try again.')] });
  }
  await audit('SCRIM_SSIDP_MANUAL', interaction.user.id, `${track} G${groupNo} room posted manually`);
  return interaction.editReply({ content: `✅ Room ID/password posted to ${track} Group ${groupNo}.` });
}

async function handleInteraction(interaction) {
  try {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === 'export') {
        const focused = interaction.options.getFocused(true);
        if (focused.name === 'name') {
          const q = focused.value || '';
          const events = await prisma.tournament.findMany({
            where: { name: { contains: q, mode: 'insensitive' } },
            orderBy: { createdAt: 'desc' },
            take: 25,
          });
          return interaction.respond(
            events.map((e) => ({
              name: `${e.type === 'SCRIM' ? '🎯' : '🏆'} ${e.name}`.slice(0, 100),
              value: e.name,
            }))
          );
        }
      }
      return;
    }

    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'setup-panel') {
        // Acknowledge FIRST — the admin check below hits the database.
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (!(await requireAdmin(interaction))) return;
        const which = interaction.options.getString('panel');
        const builders = {
          team: panels.teamVerificationPanel,
          scrim: panels.scrimRegistrationPanel,
          tournament: panels.tournamentRegistrationPanel,
          admin: panels.adminPanel,
          br_verify: scrimPanels.brVerifyPanel,
          br_oq: scrimPanels.brOqPanel,
          br_t3: scrimPanels.brT3Panel,
          br_admin: scrimPanels.brAdminPanel,
        };
        if (which === 'br_lobby') {
          await scrimAdmin.postLobbyPanel(interaction, 'ALL');
          await audit('PANEL_POST', interaction.user.id, `br_lobby panel posted in #${interaction.channel.name}`);
          return interaction.editReply({ content: `✅ Lobby panel posted in this channel.` });
        }
        const build = builders[which];
        if (!build) return interaction.editReply({ embeds: [errorEmbed('Unknown panel.')] });
        if (!interaction.channel || !interaction.channel.isTextBased()) {
          return interaction.editReply({ embeds: [errorEmbed('Run this inside a server text channel.')] });
        }
        await interaction.channel.send(build());
        await audit('PANEL_POST', interaction.user.id, `${which} panel posted in #${interaction.channel.name}`);
        return interaction.editReply({ content: `✅ Panel posted in this channel.` });
      }
      if (interaction.commandName === 'export') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (!(await requireAdmin(interaction))) return;
        const sub = interaction.options.getSubcommand();
        if (sub === 'verified') return exportFlows.exportVerified(interaction);
        if (sub === 'tournament') return exportFlows.exportTournament(interaction, interaction.options.getString('name', true));
        if (sub === 'scrim') return scrimAdmin.handle(interaction);
        return interaction.editReply({ embeds: [errorEmbed('Unknown export.')] });
      }
      if (interaction.commandName === 'create_group' || interaction.commandName === 'create_group_t3') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (await cmdsG.handleSlashCommand(interaction)) return;
        return interaction.editReply({ embeds: [errorEmbed('Unknown command.')] });
      }
      if (interaction.commandName === 'message_template' || interaction.commandName === 'bot_health') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        return scrimAdmin.handle(interaction);
      }
      if (interaction.commandName === 'ss_idp') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (!(await requireAdmin(interaction))) return;
        return handleSsIdpManual(interaction);
      }
      return;
    }

    const id = interaction.customId || '';
    if (id.startsWith('team:')) return teamFlows.handle(interaction);
    if (id.startsWith('scrim:') || id.startsWith('tournament:') || id.startsWith('event:')) return eventFlows.handle(interaction);
    if (id.startsWith('admin:')) return adminFlows.handle(interaction);
    if (id.startsWith('idp:')) return idpFlows.handle(interaction);
    if (id.startsWith('slot:')) return slotFlows.handle(interaction);
    if (id.startsWith('dm:')) return adminFlows.handleDmOptOut(interaction);
    // Black Raven scrims port (bs: namespace) — most specific first, then the
    // verification/registration catch-all.
    if (id.startsWith('bs:ssidp:')) return scrimIdp.handle(interaction);
    if (/^bs:(panel|warn|remove|qualify|team):/.test(id)) return scrimGroups.handle(interaction);
    if (/^bs:(admin|tpl|lobby):/.test(id)) return scrimAdmin.handle(interaction);
    if (id.startsWith('bs:')) return scrimsFlows.handle(interaction);
  } catch (err) {
    console.error('[router] error:', err);
    try {
      if (interaction) {
        if (interaction.deferred) {
          await interaction.editReply({ content: null, embeds: [errorEmbed('Something went wrong. Please try again.')], components: [] });
        } else if (!interaction.replied) {
          await interaction.reply({ embeds: [errorEmbed('Something went wrong. Please try again.')], flags: MessageFlags.Ephemeral });
        }
      }
    } catch {}
  }
}

module.exports = { handleInteraction, _test: { isValidRoomId, isValidRoomPassword, isValidLobbyTime } };
