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
async function handleSsIdpManual(interaction) {
  const track = interaction.options.getString('track', true);
  const groupNo = interaction.options.getInteger('group_no', true);
  const roomId = interaction.options.getString('room_id', true);
  const password = interaction.options.getString('password', true);
  const lobbyTime = interaction.options.getString('lobby_time') || '';
  const group = await prisma.scrimGroup.findFirst({
    where: { groupType: track, groupNo, status: { not: 'DELETED' } },
  });
  if (!group) {
    return interaction.editReply({ embeds: [errorEmbed(`No active ${track} group ${groupNo} found.`)] });
  }
  await scrimIdp.postRoomIdp(group.id, { roomId, password, lobbyTime }, interaction.client);
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
        await interaction.deferReply({ ephemeral: true });
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
        await interaction.deferReply({ ephemeral: true });
        if (!(await requireAdmin(interaction))) return;
        const sub = interaction.options.getSubcommand();
        if (sub === 'verified') return exportFlows.exportVerified(interaction);
        if (sub === 'tournament') return exportFlows.exportTournament(interaction, interaction.options.getString('name', true));
        if (sub === 'scrim') return scrimAdmin.handle(interaction);
        return interaction.editReply({ embeds: [errorEmbed('Unknown export.')] });
      }
      if (interaction.commandName === 'create_group' || interaction.commandName === 'create_group_t3') {
        await interaction.deferReply({ ephemeral: true });
        if (await cmdsG.handleSlashCommand(interaction)) return;
        return interaction.editReply({ embeds: [errorEmbed('Unknown command.')] });
      }
      if (interaction.commandName === 'message_template' || interaction.commandName === 'bot_health') {
        await interaction.deferReply({ ephemeral: true });
        return scrimAdmin.handle(interaction);
      }
      if (interaction.commandName === 'ss_idp') {
        await interaction.deferReply({ ephemeral: true });
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
          await interaction.reply({ embeds: [errorEmbed('Something went wrong. Please try again.')], ephemeral: true });
        }
      }
    } catch {}
  }
}

module.exports = { handleInteraction };
