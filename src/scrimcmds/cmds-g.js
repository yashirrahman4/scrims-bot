/**
 * Agent G slash commands — scrims group creation (scrimport-1).
 *
 * Exports:
 *   cmdBuilders       -> two SlashCommandBuilder JSONs for the integrator
 *   handleSlashCommand(interaction) -> true when handled (admin-only enforced in handler)
 */
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const config = require('../config');
const { createScrimGroup } = require('../flows/scrimgroups');
const { safeReply, errorEmbed } = require('../utils');

const MAP_CHOICES = (config.defaultMaps || ['Erangel', 'Miramar', 'Rondo']).map((m) => ({
  name: m,
  value: m,
}));

function addGroupOptions(builder) {
  return builder
    .addStringOption((o) =>
      o.setName('date').setDescription('Match date (YYYY-MM-DD)').setRequired(true)
    )
    .addStringOption((o) =>
      o.setName('map1').setDescription('Match 1 map').setRequired(true).addChoices(...MAP_CHOICES)
    )
    .addStringOption((o) =>
      o.setName('map2').setDescription('Match 2 map').setRequired(true).addChoices(...MAP_CHOICES)
    )
    .addStringOption((o) =>
      o.setName('idp1').setDescription('Match 1 IDP time (HH:MM, 24h, IST)').setRequired(true)
    )
    .addStringOption((o) =>
      o.setName('idp2').setDescription('Match 2 IDP time (HH:MM, 24h, IST)').setRequired(true)
    );
}

const cmdBuilders = [
  addGroupOptions(
    new SlashCommandBuilder()
      .setName('create_group')
      .setDescription('Create a scrim group (Admin only)')
      .setDMPermission(false)
      .addStringOption((o) =>
        o
          .setName('track')
          .setDescription('Track')
          .setRequired(true)
          .addChoices({ name: 'OQ', value: 'OQ' }, { name: 'T3', value: 'T3' })
      )
  ).toJSON(),
  addGroupOptions(
    new SlashCommandBuilder()
      .setName('create_group_t3')
      .setDescription('Create a T3 scrim group (Admin only)')
      .setDMPermission(false)
  ).toJSON(),
];

function readGroupOptions(interaction) {
  return {
    date: interaction.options.getString('date', true),
    map1: interaction.options.getString('map1', true),
    map2: interaction.options.getString('map2', true),
    idp1: interaction.options.getString('idp1', true),
    idp2: interaction.options.getString('idp2', true),
  };
}

async function handleSlashCommand(interaction) {
  try {
    if (interaction.commandName === 'create_group') {
      const track = interaction.options.getString('track', true);
      await createScrimGroup(interaction, track, readGroupOptions(interaction));
      return true;
    }
    if (interaction.commandName === 'create_group_t3') {
      await createScrimGroup(interaction, 'T3', readGroupOptions(interaction));
      return true;
    }
    return false;
  } catch (e) {
    console.error('[cmds-g] handleSlashCommand failed:', e);
    // Never leave the interaction hanging — the router already deferred it.
    await safeReply(interaction, {
      embeds: [errorEmbed('Could not create the scrim group. Please try again — if it keeps failing, check the bot console for [scrimgroups] errors.')],
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
    return true;
  }
}

module.exports = { cmdBuilders, handleSlashCommand };
