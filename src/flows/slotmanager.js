/**
 * Slot Manager — a per-tournament channel (auto-created in the registration
 * channel's category) where teams manage their own slots, plus admin tools.
 *
 * Team panel: Cancel My Slot · My Groups · Change Team Name · Swap Groups
 * Admin panel: Cancel Slot (any team) · Transfer IDP Role
 */
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
} = require('discord.js');
const { prisma } = require('../db');
const { requireAdmin, errorEmbed, successEmbed, audit, postAdminLog, getSettings } = require('../utils');
const { refreshAnnouncementPanel } = require('./events');

const ACTIVE_REG = ['PENDING', 'APPROVED'];

/** The user's active team + registration for a tournament (owner or roster member). */
async function myTeamReg(tournamentId, discordId) {
  const teams = await prisma.team.findMany({
    where: {
      status: 'ACTIVE',
      OR: [{ owner: { discordId } }, { members: { some: { player: { discordId } } } }],
    },
    include: { registrations: { where: { tournamentId } }, owner: true },
  });
  for (const t of teams) {
    const reg = t.registrations.find((r) => ACTIVE_REG.includes(r.status));
    if (reg) return { team: t, reg };
  }
  return null;
}

/** All Discord IDs of a team (owner + roster). */
async function teamDiscordIds(teamId) {
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    include: { owner: true, members: { include: { player: true } } },
  });
  if (!team) return [];
  const ids = [];
  if (team.owner?.discordId) ids.push(team.owner.discordId);
  for (const m of team.members || []) if (m.player?.discordId) ids.push(m.player.discordId);
  return [...new Set(ids)];
}

/** Log a slot-manager action to the tournament log channel + admin audit. Never throws. */
async function slotLog(interaction, event, title, description, color = 0x5865f2) {
  try {
    await audit(title.replace(/[^A-Z_]/g, '_').slice(0, 40) || 'SLOT_MANAGER', interaction.user.id, `${event.name}: ${description}`);
  } catch {}
  try {
    await postAdminLog(interaction.client, interaction.guildId, 'SLOT_MANAGER', interaction.user.id, `${event.name} — ${description}`);
  } catch {}
  try {
    if (event.logChannelId) {
      const ch = await interaction.guild.channels.fetch(event.logChannelId).catch(() => null);
      if (ch && ch.isTextBased()) {
        await ch.send({ embeds: [new EmbedBuilder().setColor(color).setTitle(`🎰 ${title}`).setDescription(description)] });
      }
    }
  } catch (e) {
    console.error('[slotmanager] log failed:', e.message);
  }
}

function teamPanelPayload(tid) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🎰 Tourney Slot Manager')
    .setDescription(
      'Manage your tournament slot right here — no need to ping the staff.\n\n' +
        '• Click **Cancel My Slot** below to cancel your slot.\n' +
        '• Click **My Groups** to get info about all your slots.\n' +
        '• Click **Change Team Name** if you want to update your team\'s name.\n' +
        '• Click **Swap Groups** to move your team to a different group.\n\n' +
        '_Note that slot cancel is irreversible._'
    )
    .setFooter({ text: 'Your slot · your control' });
  const b = (action, label, style, emoji) =>
    new ButtonBuilder().setCustomId(`slot:${action}:${tid}`).setLabel(label).setStyle(style).setEmoji(emoji);
  const row = new ActionRowBuilder().addComponents(
    b('cancelmy', 'Cancel My Slot', ButtonStyle.Danger, '❌'),
    b('mygroups', 'My Groups', ButtonStyle.Success, '👥'),
    b('changename', 'Change Team Name', ButtonStyle.Primary, '✏️'),
    b('swap', 'Swap Groups', ButtonStyle.Secondary, '🔀')
  );
  return { embeds: [embed], components: [row] };
}

function adminPanelPayload(tid) {
  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('🛠️ Slot Manager — Admin Tools')
    .setDescription('• **Cancel Slot** — cancel any team\'s slot.\n• **Transfer IDP Role** — hand the IDP role to a new holder.')
    .setFooter({ text: 'Staff only' });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`slot:acancel:${tid}`).setLabel('Cancel Slot').setStyle(ButtonStyle.Danger).setEmoji('❌'),
    new ButtonBuilder().setCustomId(`slot:transfer:${tid}`).setLabel('Transfer IDP Role').setStyle(ButtonStyle.Primary).setEmoji('🔄')
  );
  return { embeds: [embed], components: [row] };
}

/**
 * Create the #slot-manager channel in the registration channel's category
 * (if it doesn't exist yet) and post both panels. Returns the channel.
 */
async function ensureSlotManager(client, guild, event) {
  if (event.slotManagerChannelId) {
    const existing = await guild.channels.fetch(event.slotManagerChannelId).catch(() => null);
    if (existing && existing.isTextBased()) return existing;
  }
  const regCh = event.regChannelId ? await guild.channels.fetch(event.regChannelId).catch(() => null) : null;
  const ch = await guild.channels.create({
    name: 'slot-manager',
    type: ChannelType.GuildText,
    parent: regCh?.parentId || null,
    reason: `Slot Manager for ${event.name}`,
  });
  await ch.send(teamPanelPayload(event.id));
  await ch.send(adminPanelPayload(event.id));
  await prisma.tournament.update({ where: { id: event.id }, data: { slotManagerChannelId: ch.id } });
  console.log(`[slotmanager] created #slot-manager for ${event.name}`);
  return ch;
}

/** Announce to the slot-manager channel. Never throws. */
async function announceSlotManager(client, guild, event, payload) {
  try {
    const id = (await prisma.tournament.findUnique({ where: { id: event.id }, select: { slotManagerChannelId: true } }))?.slotManagerChannelId;
    if (!id) return;
    const ch = await guild.channels.fetch(id).catch(() => null);
    if (ch && ch.isTextBased()) await ch.send(payload);
  } catch (e) {
    console.error('[slotmanager] announce failed:', e.message);
  }
}

async function handle(interaction) {
  try {
    if (interaction.isButton()) return handleButton(interaction);
    if (interaction.isModalSubmit()) return handleModal(interaction);
    if (interaction.isStringSelectMenu() || interaction.isUserSelectMenu?.()) return handleSelect(interaction);
  } catch (err) {
    console.error('[slotmanager] error:', err);
    try {
      if (interaction.deferred) {
        await interaction.editReply({ content: null, embeds: [errorEmbed('Something went wrong. Please try again.')], components: [] });
      } else if (!interaction.replied) {
        await interaction.reply({ embeds: [errorEmbed('Something went wrong. Please try again.')], ephemeral: true });
      }
    } catch {}
  }
}

async function getEvent(tid) {
  return prisma.tournament.findUnique({ where: { id: tid } });
}

// ---------- buttons ----------

async function handleButton(interaction) {
  const id = interaction.customId;
  const parts = id.split(':');
  const action = parts[1];
  const tid = parts[2];

  if (action === 'cancelmy' && parts.length === 3) {
    await interaction.deferReply({ ephemeral: true });
    const event = await getEvent(tid);
    if (!event) return interaction.editReply({ embeds: [errorEmbed('Tournament not found.')] });
    const found = await myTeamReg(tid, interaction.user.id);
    if (!found) return interaction.editReply({ embeds: [errorEmbed('You have no active slot in this tournament.')] });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`slot:cancelmy:yes:${found.reg.id}`).setLabel('Yes, cancel it').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`slot:cancelmy:no:${found.reg.id}`).setLabel('Keep my slot').setStyle(ButtonStyle.Secondary)
    );
    return interaction.editReply({
      content: `⚠️ Cancel **[${found.team.tag}] ${found.team.name}** — Slot **${found.reg.slotNo}**, Group **${found.reg.groupNo}**?\n_This is irreversible._`,
      components: [row],
    });
  }

  if (id.startsWith('slot:cancelmy:yes:')) {
    const regId = id.split(':')[3];
    await interaction.deferUpdate();
    const reg = await prisma.tournamentRegistration.findUnique({ where: { id: regId }, include: { team: true, tournament: true } });
    if (!reg || !ACTIVE_REG.includes(reg.status)) return interaction.editReply({ content: 'Slot already cancelled or not found.', components: [] });
    await prisma.tournamentRegistration.update({ where: { id: reg.id }, data: { status: 'REMOVED' } });
    // Take the IDP group role back, if one was given.
    try {
      const grp = await prisma.idpGroup.findFirst({ where: { tournamentId: reg.tournamentId, groupNo: reg.groupNo } });
      if (grp?.roleId) {
        const role = await interaction.guild.roles.fetch(grp.roleId).catch(() => null);
        if (role) {
          for (const did of await teamDiscordIds(reg.teamId)) {
            const m = await interaction.guild.members.fetch(did).catch(() => null);
            if (m && m.roles.cache.has(role.id)) await m.roles.remove(role).catch(() => {});
          }
        }
      }
    } catch (e) {
      console.error('[slotmanager] role removal failed:', e.message);
    }
    await announceSlotManager(interaction.client, interaction.guild, reg.tournament, {
      embeds: [new EmbedBuilder().setColor(0xed4245).setDescription(`❌ **[${reg.team.tag}] ${reg.team.name}** cancelled their slot (was Slot ${reg.slotNo}, Group ${reg.groupNo}).`)],
    });
    await slotLog(interaction, reg.tournament, 'SLOT_CANCELLED', `**[${reg.team.tag}] ${reg.team.name}** cancelled Slot ${reg.slotNo} (Group ${reg.groupNo})`, 0xed4245);
    await refreshAnnouncementPanel(interaction.client, interaction.guildId, reg.tournamentId);
    return interaction.editReply({ content: `✅ Your slot (Slot ${reg.slotNo}) has been cancelled.`, embeds: [], components: [] });
  }

  if (id.startsWith('slot:cancelmy:no:')) {
    return interaction.update({ content: 'Kept your slot. 👍', embeds: [], components: [] });
  }

  if (action === 'mygroups') {
    await interaction.deferReply({ ephemeral: true });
    const event = await getEvent(tid);
    if (!event) return interaction.editReply({ embeds: [errorEmbed('Tournament not found.')] });
    const found = await myTeamReg(tid, interaction.user.id);
    if (!found) return interaction.editReply({ embeds: [errorEmbed('You have no active slot in this tournament.')] });
    const regs = await prisma.tournamentRegistration.findMany({
      where: { tournamentId: tid, teamId: found.team.id, status: { in: ACTIVE_REG } },
      orderBy: { slotNo: 'asc' },
    });
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle(`👥 My Slots — ${event.name}`)
      .setDescription(
        `**[${found.team.tag}] ${found.team.name}**\n\n` +
          regs.map((r) => `• **Slot ${r.slotNo}** — Group **${r.groupNo}** — \`${r.status}\`${r.qualified ? ' ✅ Qualified' : ''}`).join('\n')
      );
    return interaction.editReply({ embeds: [embed] });
  }

  if (action === 'changename') {
    const event = await getEvent(tid);
    if (!event) return interaction.reply({ embeds: [errorEmbed('Tournament not found.')], ephemeral: true });
    const found = await myTeamReg(tid, interaction.user.id);
    if (!found) return interaction.reply({ embeds: [errorEmbed('You have no active slot in this tournament.')], ephemeral: true });
    const modal = new ModalBuilder().setCustomId(`slot:changename:modal:${found.team.id}`).setTitle('Change Team Name');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('t_name')
          .setLabel('New team name')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(3)
          .setMaxLength(40)
          .setValue(found.team.name)
      )
    );
    return interaction.showModal(modal);
  }

  if (action === 'swap') {
    const event = await getEvent(tid);
    if (!event) return interaction.reply({ embeds: [errorEmbed('Tournament not found.')], ephemeral: true });
    const found = await myTeamReg(tid, interaction.user.id);
    if (!found) return interaction.reply({ embeds: [errorEmbed('You have no active slot in this tournament.')], ephemeral: true });
    const settings = await getSettings(interaction.guildId);
    const perGroup = event.teamsPerGroup || settings?.groupSize || 20;
    const nGroups = Math.max(Math.ceil(event.teamLimit / perGroup), 1);
    const modal = new ModalBuilder().setCustomId(`slot:swap:modal:${tid}`).setTitle('Swap Groups');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('s_group')
          .setLabel(`New group number (1-${nGroups}) — now: ${found.reg.groupNo}`)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(4)
          .setPlaceholder(`e.g. ${found.reg.groupNo === 1 ? 2 : 1}`)
      )
    );
    return interaction.showModal(modal);
  }

  // ----- admin tools -----
  if (action === 'acancel' && parts.length === 3) {
    if (!(await requireAdmin(interaction))) return;
    const modal = new ModalBuilder().setCustomId(`slot:acancel:modal:${tid}`).setTitle('Cancel a Team Slot');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('c_who')
          .setLabel('Team tag or slot number')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(32)
          .setPlaceholder('e.g. BRV or 12')
      )
    );
    return interaction.showModal(modal);
  }

  if (id.startsWith('slot:acancel:yes:')) {
    if (!(await requireAdmin(interaction))) return;
    const regId = id.split(':')[3];
    await interaction.deferUpdate();
    const reg = await prisma.tournamentRegistration.findUnique({ where: { id: regId }, include: { team: true, tournament: true } });
    if (!reg || !ACTIVE_REG.includes(reg.status)) return interaction.editReply({ content: 'Slot already cancelled or not found.', components: [] });
    await prisma.tournamentRegistration.update({ where: { id: reg.id }, data: { status: 'REMOVED' } });
    await announceSlotManager(interaction.client, interaction.guild, reg.tournament, {
      embeds: [new EmbedBuilder().setColor(0xed4245).setDescription(`❌ Staff cancelled the slot of **[${reg.team.tag}] ${reg.team.name}** (was Slot ${reg.slotNo}, Group ${reg.groupNo}).`)],
    });
    await slotLog(interaction, reg.tournament, 'SLOT_CANCELLED', `Staff cancelled **[${reg.team.tag}] ${reg.team.name}** — Slot ${reg.slotNo}, Group ${reg.groupNo}`, 0xed4245);
    await refreshAnnouncementPanel(interaction.client, interaction.guildId, reg.tournamentId);
    return interaction.editReply({ content: `✅ Cancelled the slot of **[${reg.team.tag}] ${reg.team.name}**.`, embeds: [], components: [] });
  }

  if (id.startsWith('slot:acancel:no:')) {
    if (!(await requireAdmin(interaction))) return;
    return interaction.update({ content: 'Cancelled.', embeds: [], components: [] });
  }

  if (action === 'transfer') {
    if (!(await requireAdmin(interaction))) return;
    await interaction.deferReply({ ephemeral: true });
    const groups = await prisma.idpGroup.findMany({ where: { tournamentId: tid }, orderBy: { groupNo: 'asc' } });
    if (!groups.length) return interaction.editReply({ embeds: [errorEmbed('No IDP groups exist for this tournament yet.')] });
    const select = new StringSelectMenuBuilder()
      .setCustomId(`slot:transfer:group:${tid}`)
      .setPlaceholder('Select the IDP group')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        groups.slice(0, 25).map((g) => ({ label: `Group ${g.groupNo}`.slice(0, 100), value: g.id, description: `<#${g.channelId}>`.slice(0, 100) }))
      );
    return interaction.editReply({
      content: 'Which IDP group is this transfer for?',
      components: [new ActionRowBuilder().addComponents(select)],
    });
  }
}

// ---------- selects ----------

async function handleSelect(interaction) {
  const id = interaction.customId;

  if (id.startsWith('slot:transfer:group:')) {
    if (!(await requireAdmin(interaction))) return;
    const gid = (interaction.values || [])[0];
    await interaction.deferUpdate();
    const group = await prisma.idpGroup.findUnique({ where: { id: gid } });
    if (!group) return interaction.editReply({ content: 'Group not found.', embeds: [], components: [] });
    const row = new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId(`slot:transfer:user:${gid}`)
        .setPlaceholder('Select the new IDP role holder')
        .setMinValues(1)
        .setMaxValues(1)
    );
    return interaction.editReply({
      content: `Who should hold the **IDP** role for **Group ${group.groupNo}**?${group.idpRoleHolderId ? ` (currently <@${group.idpRoleHolderId}>)` : ''}`,
      components: [row],
    });
  }

  if (id.startsWith('slot:transfer:user:')) {
    if (!(await requireAdmin(interaction))) return;
    const gid = id.split(':')[3];
    await interaction.deferUpdate();
    const group = await prisma.idpGroup.findUnique({ where: { id: gid }, include: { tournament: true } });
    if (!group) return interaction.editReply({ content: 'Group not found.', embeds: [], components: [] });
    const userId = (interaction.values || [])[0];
    if (!userId) return interaction.editReply({ content: 'No user selected.', embeds: [], components: [] });
    const guild = interaction.guild;
    let role = guild.roles.cache.find((r) => r.name === 'IDP');
    if (!role) role = await guild.roles.create({ name: 'IDP', reason: 'IDP role for tournament groups' });
    for (const [, member] of role.members) {
      await member.roles.remove(role).catch(() => {});
    }
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return interaction.editReply({ embeds: [errorEmbed('User not found in this server.')] });
    await member.roles.add(role).catch(() => {});
    await prisma.idpGroup.update({ where: { id: group.id }, data: { idpRoleHolderId: userId } });
    try {
      const ch = await guild.channels.fetch(group.channelId).catch(() => null);
      if (ch && ch.isTextBased()) {
        await ch.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription(`🔄 **IDP Role** for Group ${group.groupNo} transferred to <@${userId}>.`)] });
      }
    } catch {}
    await slotLog(interaction, group.tournament, 'IDP_ROLE', `IDP role for Group ${group.groupNo} → <@${userId}>`);
    return interaction.editReply({ content: `✅ IDP role transferred to <@${userId}>.`, embeds: [], components: [] });
  }
}

// ---------- modals ----------

async function handleModal(interaction) {
  const id = interaction.customId;

  if (id.startsWith('slot:changename:modal:')) {
    const teamId = id.split(':')[3];
    await interaction.deferReply({ ephemeral: true });
    const raw = interaction.fields.getTextInputValue('t_name').trim().replace(/\s+/g, ' ');
    if (raw.length < 3 || raw.length > 40) return interaction.editReply({ embeds: [errorEmbed('Team name must be 3–40 characters.')] });
    const team = await prisma.team.findUnique({ where: { id: teamId }, include: { registrations: { include: { tournament: true } } } });
    if (!team) return interaction.editReply({ embeds: [errorEmbed('Team not found.')] });
    const old = team.name;
    await prisma.team.update({ where: { id: team.id }, data: { name: raw } });
    const active = team.registrations.find((r) => ACTIVE_REG.includes(r.status));
    if (active?.tournament) {
      await slotLog(interaction, active.tournament, 'TEAM_RENAMED', `**${old}** → **${raw}** (Slot ${active.slotNo}, Group ${active.groupNo})`);
    }
    await audit('TEAM_RENAME', interaction.user.id, `${old} -> ${raw}`);
    return interaction.editReply({ embeds: [successEmbed(`Team name updated: **${old}** → **${raw}**.`)] });
  }

  if (id.startsWith('slot:swap:modal:')) {
    const tid = id.split(':')[3];
    await interaction.deferReply({ ephemeral: true });
    const event = await getEvent(tid);
    if (!event) return interaction.editReply({ embeds: [errorEmbed('Tournament not found.')] });
    const settings = await getSettings(interaction.guildId);
    const perGroup = event.teamsPerGroup || settings?.groupSize || 20;
    const nGroups = Math.max(Math.ceil(event.teamLimit / perGroup), 1);
    const to = parseInt(interaction.fields.getTextInputValue('s_group').trim(), 10);
    if (!Number.isInteger(to) || to < 1 || to > nGroups) {
      return interaction.editReply({ embeds: [errorEmbed(`Enter a group number between 1 and ${nGroups}.`)] });
    }
    const found = await myTeamReg(tid, interaction.user.id);
    if (!found) return interaction.editReply({ embeds: [errorEmbed('You have no active slot in this tournament.')] });
    if (to === found.reg.groupNo) return interaction.editReply({ embeds: [errorEmbed(`Your team is already in Group ${to}.`)] });
    const from = found.reg.groupNo;
    await prisma.tournamentRegistration.update({ where: { id: found.reg.id }, data: { groupNo: to } });
    // Move the IDP group roles along with the team.
    try {
      const ids = await teamDiscordIds(found.team.id);
      const fromGrp = await prisma.idpGroup.findFirst({ where: { tournamentId: tid, groupNo: from } });
      const toGrp = await prisma.idpGroup.findFirst({ where: { tournamentId: tid, groupNo: to } });
      for (const did of ids) {
        const m = await interaction.guild.members.fetch(did).catch(() => null);
        if (!m) continue;
        if (fromGrp?.roleId) {
          const r = await interaction.guild.roles.fetch(fromGrp.roleId).catch(() => null);
          if (r && m.roles.cache.has(r.id)) await m.roles.remove(r).catch(() => {});
        }
        if (toGrp?.roleId) {
          const r = await interaction.guild.roles.fetch(toGrp.roleId).catch(() => null);
          if (r && !m.roles.cache.has(r.id)) await m.roles.add(r).catch(() => {});
        }
      }
    } catch (e) {
      console.error('[slotmanager] swap role move failed:', e.message);
    }
    await slotLog(interaction, event, 'GROUP_SWAPPED', `**[${found.team.tag}] ${found.team.name}** moved Group ${from} → Group ${to} (Slot ${found.reg.slotNo})`);
    return interaction.editReply({ embeds: [successEmbed(`Your team moved from **Group ${from}** to **Group ${to}**.`)] });
  }

  if (id.startsWith('slot:acancel:modal:')) {
    if (!(await requireAdmin(interaction))) return;
    const tid = id.split(':')[3];
    await interaction.deferReply({ ephemeral: true });
    const raw = interaction.fields.getTextInputValue('c_who').trim();
    const event = await getEvent(tid);
    if (!event) return interaction.editReply({ embeds: [errorEmbed('Tournament not found.')] });
    let reg = null;
    const slotNo = parseInt(raw.replace('#', ''), 10);
    if (Number.isInteger(slotNo) && String(slotNo) === raw.replace('#', '').trim()) {
      reg = await prisma.tournamentRegistration.findFirst({
        where: { tournamentId: tid, slotNo, status: { in: ACTIVE_REG } },
        include: { team: true },
      });
    }
    if (!reg) {
      reg = await prisma.tournamentRegistration.findFirst({
        where: { tournamentId: tid, status: { in: ACTIVE_REG }, team: { tag: { equals: raw, mode: 'insensitive' } } },
        include: { team: true },
      });
    }
    if (!reg) return interaction.editReply({ embeds: [errorEmbed(`No active slot found for "${raw}". Try the team tag or slot number.`)] });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`slot:acancel:yes:${reg.id}`).setLabel('Yes, cancel it').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`slot:acancel:no:${reg.id}`).setLabel('Keep').setStyle(ButtonStyle.Secondary)
    );
    return interaction.editReply({
      content: `Cancel the slot of **[${reg.team.tag}] ${reg.team.name}** — Slot **${reg.slotNo}**, Group **${reg.groupNo}**?`,
      components: [row],
    });
  }
}

module.exports = { handle, ensureSlotManager, teamPanelPayload, adminPanelPayload, myTeamReg };
