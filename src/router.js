const teamFlows = require('./flows/team');
const eventFlows = require('./flows/events');
const adminFlows = require('./flows/admin');
const idpFlows = require('./flows/idp');
const exportFlows = require('./flows/export');
const panels = require('./panels');
const { prisma } = require('./db');
const { requireAdmin, errorEmbed, audit } = require('./utils');

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
        };
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
        return interaction.editReply({ embeds: [errorEmbed('Unknown export.')] });
      }
      return;
    }

    const id = interaction.customId || '';
    if (id.startsWith('team:')) return teamFlows.handle(interaction);
    if (id.startsWith('scrim:') || id.startsWith('tournament:') || id.startsWith('event:')) return eventFlows.handle(interaction);
    if (id.startsWith('admin:')) return adminFlows.handle(interaction);
    if (id.startsWith('idp:')) return idpFlows.handle(interaction);
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
