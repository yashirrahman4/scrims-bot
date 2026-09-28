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
  PermissionFlagsBits,
} = require('discord.js');
const { prisma } = require('../db');
const {
  getSettings,
  requireAdmin,
  errorEmbed,
  successEmbed,
  formatIST,
  audit,
  postAdminLog,
  sendLogEmbed,
} = require('../utils');

const ACTIVE_REG = ['PENDING', 'APPROVED'];

/** token -> { kind, gid, regIds, expiresAt } for punish/qualify/cancelslot confirmations */
const pendingIdp = new Map();
function stashPending(data) {
  const token = require('crypto').randomBytes(6).toString('hex');
  pendingIdp.set(token, { ...data, expiresAt: Date.now() + 10 * 60 * 1000 });
  setTimeout(() => pendingIdp.delete(token), 10 * 60 * 1000).unref?.();
  return token;
}

/** audit() + mirror to the Admin Activity log channel (never throws). */
async function idpAudit(interaction, action, details) {
  await audit(action, interaction.user.id, details);
  await postAdminLog(interaction.client, interaction.guildId, action, interaction.user.id, details);
}

async function handle(interaction) {
  if (!(await requireAdmin(interaction))) return;
  try {
    if (interaction.isButton()) return handleButton(interaction);
    if (interaction.isModalSubmit()) return handleModal(interaction);
    if (interaction.isStringSelectMenu() || interaction.isUserSelectMenu?.()) return handleSelect(interaction);
  } catch (err) {
    console.error('[idp] error:', err);
    try {
      if (interaction.deferred) {
        await interaction.editReply({ content: null, embeds: [errorEmbed('Something went wrong. Please try again.')], components: [] });
      } else if (!interaction.replied) {
        await interaction.reply({ embeds: [errorEmbed('Something went wrong. Please try again.')], ephemeral: true });
      }
    } catch {}
  }
}

// ---------- shared ----------

function groupCount(teamLimit, perGroup) {
  return Math.max(Math.ceil(teamLimit / Math.max(perGroup || 20, 1)), 1);
}

function groupLabel(group) {
  return `G${group.groupNo}-D1`;
}

async function getGroup(groupId) {
  return prisma.idpGroup.findUnique({
    where: { id: groupId },
    include: { matches: { orderBy: { matchNo: 'asc' } }, tournament: true },
  });
}

async function groupRegs(group) {
  return prisma.tournamentRegistration.findMany({
    where: { tournamentId: group.tournamentId, groupNo: group.groupNo, status: { in: ACTIVE_REG } },
    include: { team: { include: { owner: true } } },
    orderBy: { slotNo: 'asc' },
  });
}

function idpPanelPayload(group) {
  const label = groupLabel(group);
  const matches = [...(group.matches || [])].sort((a, b) => a.matchNo - b.matchNo);
  const dateStr = group.matchesDate ? formatIST(group.matchesDate).split(' ')[0] : 'TBD';
  const head =
    `**Matches Date:** ${dateStr}\n` +
    `**Total Slots:** ${group.tournament?.teamsPerGroup || '—'}\n` +
    `**Total Matches:** ${matches.length}\n\n` +
    `Below are the match details.\n\n`;
  const body =
    matches
      .map((m) => `**Match ${m.matchNo} - ${m.map}**\n✨ IDP AT: ${m.idpAt || 'TBD'}\n✨ START AT: ${m.startAt || 'TBD'}`)
      .join('\n\n') || '_No matches scheduled yet — press Edit to add one._';
  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle(`SCHEDULE FOR ${label}`)
    .setDescription(head + body)
    .setFooter({ text: group.locked ? '🔒 Group locked' : '🔓 Group unlocked' });
  const b = (action, btnLabel, style, emoji) =>
    new ButtonBuilder().setCustomId(`idp:${action}:${group.id}`).setLabel(btnLabel).setStyle(style).setEmoji(emoji);
  const row1 = new ActionRowBuilder().addComponents(
    b('edit', 'Edit', ButtonStyle.Primary, '✏️'),
    b('slotlist', 'Send Slot List', ButtonStyle.Success, '📋'),
    b('punish', 'Punish Teams', ButtonStyle.Danger, '⚠️'),
    b('qualify', 'Qualify Teams', ButtonStyle.Primary, '✅'),
    b('remind', 'Send Reminders', ButtonStyle.Secondary, '🔔')
  );
  const row2 = new ActionRowBuilder().addComponents(
    group.locked
      ? b('unlock', 'Unlock Group', ButtonStyle.Secondary, '🔓')
      : b('lock', 'Lock Group', ButtonStyle.Secondary, '🔒'),
    b('cancelslot', 'Cancel Slot', ButtonStyle.Danger, '❌'),
    b('transferrole', 'Transfer IDP Role', ButtonStyle.Primary, '🔄')
  );
  return { embeds: [embed], components: [row1, row2] };
}

/** Re-render the schedule panel message inside the group's channel. Never throws. */
async function refreshPanel(client, groupId) {
  try {
    const group = await getGroup(groupId);
    if (!group) return;
    const ch = await client.channels.fetch(group.channelId).catch(() => null);
    if (!ch || !ch.isTextBased()) return;
    const payload = idpPanelPayload(group);
    if (group.panelMsgId) {
      const msg = await ch.messages.fetch(group.panelMsgId).catch(() => null);
      if (msg) {
        await msg.edit(payload);
        return;
      }
    }
    const msg = await ch.send(payload);
    await prisma.idpGroup.update({ where: { id: group.id }, data: { panelMsgId: msg.id } });
  } catch (e) {
    console.error('[idp] refreshPanel failed:', e.message);
  }
}

async function groupChannel(client, group) {
  const ch = await client.channels.fetch(group.channelId).catch(() => null);
  return ch && ch.isTextBased() ? ch : null;
}

/**
 * Create the IDP category + group channels + schedule panels for an event.
 * Resumes a partially-created set instead of failing when the category already exists.
 * Asks nothing — the caller must confirm with the admin first.
 */
async function createIdpGroups(client, guild, eventId, guildId) {
  const event = await prisma.tournament.findUnique({ where: { id: eventId } });
  if (!event) throw new Error('Event not found.');
  const settings = await prisma.guildSettings.findUnique({ where: { guildId } });
  const perGroup = event.teamsPerGroup || settings?.groupSize || 20;
  const n = groupCount(event.teamLimit, perGroup);
  let category = null;
  const have = new Set();
  if (event.idpCategoryId) {
    // Resume a partially-created set.
    category = await guild.channels.fetch(event.idpCategoryId).catch(() => null);
    if (!category) throw new Error('The IDP category was deleted — ask a developer to reset it before retrying.');
    const existing = await prisma.idpGroup.findMany({ where: { tournamentId: event.id }, select: { groupNo: true } });
    for (const g of existing) have.add(g.groupNo);
  } else {
    const categoryName = `${event.name} — Round 1`.slice(0, 100);
    category = await guild.channels.create({ name: categoryName, type: ChannelType.GuildCategory });
    await prisma.tournament.update({ where: { id: event.id }, data: { idpCategoryId: category.id } });
  }
  const slug = event.name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12) || 'tourney';
  let created = 0;
  const failures = [];
  for (let g = 1; g <= n; g++) {
    if (have.has(g)) continue; // already exists from a previous run
    try {
      const ch = await guild.channels.create({
        name: `${slug}-g${g}-d1`.slice(0, 100),
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.SendMessages] }],
      });
      const grp = await prisma.idpGroup.create({
        data: {
          tournamentId: event.id,
          groupNo: g,
          channelId: ch.id,
          categoryId: category.id,
          locked: true,
          matchesDate: event.date,
          totalMatches: 1,
        },
      });
      await prisma.idpMatch.create({ data: { idpGroupId: grp.id, matchNo: 1, map: 'Erangel' } });
      const full = await getGroup(grp.id);
      const msg = await ch.send(idpPanelPayload(full));
      await prisma.idpGroup.update({ where: { id: grp.id }, data: { panelMsgId: msg.id } });
      created++;
      await new Promise((r) => setTimeout(r, 400)); // ease off channel-creation rate limits
    } catch (e) {
      console.error(`[idp] group ${g} creation failed:`, e.message);
      failures.push(g);
    }
  }
  return { eventName: event.name, categoryName: category.name, groups: created, failures, resumed: have.size > 0 };
}

// ---------- buttons ----------

async function handleButton(interaction) {
  const id = interaction.customId;
  const parts = id.split(':');
  // punish / qualify / cancelslot confirm + cancel buttons are handled with the select flow
  if (parts[2] === 'yes' || parts[2] === 'no') return handleSelect(interaction);
  const action = parts[1];
  const gid = parts[2];

  if (action === 'edit') {
    await interaction.deferReply({ ephemeral: true });
    const group = await getGroup(gid);
    if (!group) return interaction.editReply({ content: 'Group not found.', embeds: [], components: [] });
    const select = new StringSelectMenuBuilder()
      .setCustomId(`idp:ematch:${gid}`)
      .setPlaceholder('Select a match to edit')
      .addOptions([
        ...group.matches.map((m) => ({
          label: `Match ${m.matchNo} — ${m.map}`.slice(0, 100),
          value: m.id,
          description: `IDP ${m.idpAt || 'TBD'} · Start ${m.startAt || 'TBD'}`.slice(0, 100),
        })),
        { label: '➕ Add a new match', value: 'ADD' },
      ]);
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`idp:edate:${gid}`).setLabel('Edit Matches Date').setStyle(ButtonStyle.Secondary).setEmoji('📅')
    );
    return interaction.editReply({
      content: `Editing **${groupLabel(group)}** — pick a match:`,
      components: [new ActionRowBuilder().addComponents(select), row2],
    });
  }

  if (action === 'edate') {
    // showModal must NOT be preceded by defer — Discord forbids defer-then-modal.
    const modal = new ModalBuilder().setCustomId(`idp:edate:modal:${gid}`).setTitle('Matches Date');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('d_date')
          .setLabel('Date — YYYY-MM-DD (empty = clear)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(10)
          .setPlaceholder('2026-10-05')
      )
    );
    return interaction.showModal(modal);
  }

  if (action === 'slotlist') {
    await interaction.deferReply({ ephemeral: true });
    const group = await getGroup(gid);
    if (!group) return interaction.editReply({ content: 'Group not found.', embeds: [], components: [] });
    const regs = await groupRegs(group);
    const lines = regs.map(
      (r) => `**Slot ${r.slotNo}** — [${r.team.tag}] ${r.team.name} — <@${r.team.owner.discordId}>${r.qualified ? ' ✅ Qualified' : ''}`
    );
    const ch = await groupChannel(interaction.client, group);
    if (!ch) return interaction.editReply({ embeds: [errorEmbed('Group channel not found.')] });
    await ch.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle(`📋 Slot List — ${groupLabel(group)} · ${group.tournament.name}`)
          .setDescription(lines.join('\n') || 'No teams in this group yet.'),
      ],
    });
    await idpAudit(interaction, 'IDP_SLOTLIST', `${group.tournament.name} ${groupLabel(group)}: slot list posted (${regs.length} teams)`);
    return interaction.editReply({ content: `✅ Slot list posted in <#${group.channelId}>.` });
  }

  if (action === 'punish' || action === 'qualify' || action === 'cancelslot') {
    await interaction.deferReply({ ephemeral: true });
    const group = await getGroup(gid);
    if (!group) return interaction.editReply({ content: 'Group not found.', embeds: [], components: [] });
    const regs = await groupRegs(group);
    if (!regs.length) return interaction.editReply({ embeds: [errorEmbed('No active teams in this group.')] });
    const titles = { punish: 'Punish (disqualify)', qualify: 'Qualify', cancelslot: 'Cancel slot for' };
    const select = new StringSelectMenuBuilder()
      .setCustomId(`idp:${action}:pick:${gid}`)
      .setPlaceholder(`Select teams to ${titles[action].toLowerCase()}`)
      .setMinValues(1)
      .setMaxValues(Math.min(regs.length, 25))
      .addOptions(
        regs.slice(0, 25).map((r) => ({
          label: `Slot ${r.slotNo} — [${r.team.tag}] ${r.team.name}`.slice(0, 100),
          value: r.id,
          description: `Status: ${r.status}${r.qualified ? ' · Qualified' : ''}`.slice(0, 100),
        }))
      );
    return interaction.editReply({
      content: `Select teams to **${titles[action]}** in **${groupLabel(group)}**:`,
      components: [new ActionRowBuilder().addComponents(select)],
    });
  }

  if (action === 'remind') {
    // showModal must NOT be preceded by defer — Discord forbids defer-then-modal.
    const modal = new ModalBuilder().setCustomId(`idp:remind:modal:${gid}`).setTitle('Send Reminders');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('r_title').setLabel('Title').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('r_message').setLabel('Message').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500)
      )
    );
    return interaction.showModal(modal);
  }

  if (action === 'lock' || action === 'unlock') {
    await interaction.deferUpdate();
    const group = await getGroup(gid);
    if (!group) return interaction.editReply({ content: 'Group not found.', embeds: [], components: [] });
    const ch = await groupChannel(interaction.client, group);
    if (!ch) return interaction.editReply({ content: 'Group channel not found.', embeds: [], components: [] });
    const locked = action === 'lock';
    await ch.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: locked ? false : null });
    await prisma.idpGroup.update({ where: { id: group.id }, data: { locked } });
    await idpAudit(interaction, locked ? 'IDP_LOCK' : 'IDP_UNLOCK', `${group.tournament.name} ${groupLabel(group)} ${locked ? 'locked' : 'unlocked'}`);
    // deferUpdate was called, so editReply edits the panel message itself
    return interaction.editReply(idpPanelPayload({ ...group, locked }));
  }

  if (action === 'transferrole') {
    await interaction.deferReply({ ephemeral: true });
    const group = await getGroup(gid);
    if (!group) return interaction.editReply({ content: 'Group not found.', embeds: [], components: [] });
    const row = new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId(`idp:trole:pick:${gid}`)
        .setPlaceholder('Select the new IDP role holder')
        .setMinValues(1)
        .setMaxValues(1)
    );
    return interaction.editReply({
      content: `Who should hold the **IDP** role for **${groupLabel(group)}**?${group.idpRoleHolderId ? ` (currently <@${group.idpRoleHolderId}>)` : ''}`,
      components: [row],
    });
  }
}

// ---------- selects ----------

async function handleSelect(interaction) {
  const id = interaction.customId;

  if (id.startsWith('idp:ematch:')) {
    const gid = id.split(':')[2];
    const val = interaction.values[0];
    let matchId = val;
    if (val === 'ADD') {
      // One quick create before the modal — kept minimal so the 3s ack window holds.
      const group = await getGroup(gid);
      if (!group) return interaction.reply({ embeds: [errorEmbed('Group not found.')], ephemeral: true });
      const nextNo = group.matches.length ? Math.max(...group.matches.map((m) => m.matchNo)) + 1 : 1;
      const m = await prisma.idpMatch.create({ data: { idpGroupId: gid, matchNo: nextNo, map: 'Erangel' } });
      await prisma.idpGroup.update({ where: { id: gid }, data: { totalMatches: nextNo } });
      matchId = m.id;
    }
    const match = await prisma.idpMatch.findUnique({ where: { id: matchId } });
    if (!match) return interaction.reply({ embeds: [errorEmbed('Match not found.')], ephemeral: true });
    // showModal must be the first acknowledge — no defer allowed here.
    const modal = new ModalBuilder().setCustomId(`idp:ematch:modal:${match.id}`).setTitle(`Match ${match.matchNo} Details`);
    const mk = (cid, label, value, ph) =>
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId(cid).setLabel(label).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(32).setValue(value || '').setPlaceholder(ph)
      );
    modal.addComponents(
      mk('m_map', 'Map', match.map, 'Erangel'),
      mk('m_idpat', 'IDP AT (e.g. 12:45 PM)', match.idpAt, '12:45 PM'),
      mk('m_startat', 'START AT (e.g. 12:55 PM)', match.startAt, '12:55 PM')
    );
    return interaction.showModal(modal);
  }

  if (id.startsWith('idp:punish:pick:') || id.startsWith('idp:qualify:pick:') || id.startsWith('idp:cancelslot:pick:')) {
    const kind = id.split(':')[1];
    const gid = id.split(':')[3];
    await interaction.deferUpdate();
    const group = await getGroup(gid);
    if (!group) return interaction.editReply({ content: 'Group not found.', embeds: [], components: [] });
    const regIds = [...new Set(interaction.values || [])];
    const regs = await prisma.tournamentRegistration.findMany({
      where: { id: { in: regIds } },
      include: { team: true },
    });
    if (!regs.length) return interaction.editReply({ content: 'No teams selected.', embeds: [], components: [] });
    const token = stashPending({ kind, gid, regIds: regs.map((r) => r.id) });
    const verbs = { punish: 'punish (disqualify)', qualify: 'mark qualified', cancelslot: 'cancel the slot of' };
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`idp:${kind}:yes:${token}`)
        .setLabel('Confirm')
        .setStyle(kind === 'qualify' ? ButtonStyle.Success : ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`idp:${kind}:no:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    );
    return interaction.editReply({
      content: `Are you sure you want to **${verbs[kind]}**:\n${regs.map((r) => `• **[${r.team.tag}]** ${r.team.name} (Slot ${r.slotNo})`).join('\n')}`,
      embeds: [],
      components: [row],
    });
  }

  if (id.startsWith('idp:punish:yes:') || id.startsWith('idp:qualify:yes:') || id.startsWith('idp:cancelslot:yes:')) {
    const kind = id.split(':')[1];
    const token = id.split(':')[3];
    const pending = pendingIdp.get(token);
    await interaction.deferUpdate();
    if (!pending || pending.expiresAt < Date.now()) {
      pendingIdp.delete(token);
      return interaction.editReply({ content: 'Confirmation expired — start again.', embeds: [], components: [] });
    }
    pendingIdp.delete(token);
    const group = await getGroup(pending.gid);
    if (!group) return interaction.editReply({ content: 'Group not found.', embeds: [], components: [] });
    const regs = await prisma.tournamentRegistration.findMany({ where: { id: { in: pending.regIds } }, include: { team: true } });
    const ch = await groupChannel(interaction.client, group);
    if (kind === 'punish') {
      await prisma.tournamentRegistration.updateMany({ where: { id: { in: pending.regIds } }, data: { status: 'DISQUALIFIED' } });
      const msg = `⚠️ **Punished (disqualified)** in ${groupLabel(group)}:\n${regs.map((r) => `• **[${r.team.tag}]** ${r.team.name} (was Slot ${r.slotNo})`).join('\n')}`;
      if (ch) await ch.send({ embeds: [new EmbedBuilder().setColor(0xed4245).setDescription(msg)] });
      await idpAudit(interaction, 'IDP_PUNISH', `${group.tournament.name} ${groupLabel(group)}: disqualified ${regs.map((r) => r.team.tag).join(', ')}`);
      return interaction.editReply({ content: `✅ Disqualified **${regs.length}** team(s).`, embeds: [], components: [] });
    }
    if (kind === 'qualify') {
      await prisma.tournamentRegistration.updateMany({ where: { id: { in: pending.regIds } }, data: { qualified: true } });
      const msg = `✅ **Qualified** from ${groupLabel(group)}:\n${regs.map((r) => `• **[${r.team.tag}]** ${r.team.name} (Slot ${r.slotNo})`).join('\n')}`;
      if (ch) await ch.send({ embeds: [new EmbedBuilder().setColor(0x57f287).setDescription(msg)] });
      await idpAudit(interaction, 'IDP_QUALIFY', `${group.tournament.name} ${groupLabel(group)}: qualified ${regs.map((r) => r.team.tag).join(', ')}`);
      return interaction.editReply({ content: `✅ Marked **${regs.length}** team(s) qualified.`, embeds: [], components: [] });
    }
    // cancelslot
    await prisma.tournamentRegistration.updateMany({ where: { id: { in: pending.regIds } }, data: { status: 'REMOVED' } });
    const msg = `❌ **Slot cancelled** in ${groupLabel(group)}:\n${regs.map((r) => `• **[${r.team.tag}]** ${r.team.name} (was Slot ${r.slotNo})`).join('\n')}`;
    if (ch) await ch.send({ embeds: [new EmbedBuilder().setColor(0xf1c40f).setDescription(msg)] });
    await idpAudit(interaction, 'IDP_CANCELSLOT', `${group.tournament.name} ${groupLabel(group)}: cancelled slots of ${regs.map((r) => r.team.tag).join(', ')}`);
    return interaction.editReply({ content: `✅ Cancelled **${regs.length}** slot(s).`, embeds: [], components: [] });
  }

  if (id.startsWith('idp:punish:no:') || id.startsWith('idp:qualify:no:') || id.startsWith('idp:cancelslot:no:')) {
    pendingIdp.delete(id.split(':')[3]);
    return interaction.update({ content: 'Cancelled.', embeds: [], components: [] });
  }

  if (id.startsWith('idp:trole:pick:')) {
    const gid = id.split(':')[3];
    await interaction.deferUpdate();
    const group = await getGroup(gid);
    if (!group) return interaction.editReply({ content: 'Group not found.', embeds: [], components: [] });
    const userId = (interaction.values || [])[0];
    if (!userId) return interaction.editReply({ content: 'No user selected.', embeds: [], components: [] });
    const guild = interaction.guild;
    let role = guild.roles.cache.find((r) => r.name === 'IDP');
    if (!role) {
      role = await guild.roles.create({ name: 'IDP', reason: 'IDP role for tournament groups' });
    }
    // remove from all current holders, then assign to the new one
    for (const [, member] of role.members) {
      await member.roles.remove(role).catch(() => {});
    }
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return interaction.editReply({ embeds: [errorEmbed('User not found in this server.')] });
    await member.roles.add(role).catch(() => {});
    await prisma.idpGroup.update({ where: { id: group.id }, data: { idpRoleHolderId: userId } });
    const ch = await groupChannel(interaction.client, group);
    if (ch) {
      await ch.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0x5865f2)
            .setDescription(`🔄 **IDP Role** for ${groupLabel(group)} transferred to <@${userId}>.`),
        ],
      });
    }
    await idpAudit(interaction, 'IDP_ROLE', `${group.tournament.name} ${groupLabel(group)}: IDP role -> <@${userId}>`);
    return interaction.editReply({ content: `✅ IDP role transferred to <@${userId}>.`, embeds: [], components: [] });
  }
}

// ---------- modals ----------

async function handleModal(interaction) {
  const id = interaction.customId;

  if (id.startsWith('idp:ematch:modal:')) {
    const matchId = id.split(':')[3];
    await interaction.deferReply({ ephemeral: true });
    const match = await prisma.idpMatch.findUnique({ where: { id: matchId } });
    if (!match) return interaction.editReply({ embeds: [errorEmbed('Match not found.')] });
    const map = interaction.fields.getTextInputValue('m_map').trim() || 'Erangel';
    const idpAt = interaction.fields.getTextInputValue('m_idpat').trim() || null;
    const startAt = interaction.fields.getTextInputValue('m_startat').trim() || null;
    await prisma.idpMatch.update({ where: { id: match.id }, data: { map: map.slice(0, 32), idpAt, startAt } });
    await refreshPanel(interaction.client, match.idpGroupId);
    const group = await getGroup(match.idpGroupId);
    await idpAudit(interaction, 'IDP_EDIT', `${group?.tournament.name} ${group ? groupLabel(group) : ''}: Match ${match.matchNo} -> ${map}, IDP ${idpAt || 'TBD'}, Start ${startAt || 'TBD'}`);
    return interaction.editReply({ embeds: [successEmbed(`Match ${match.matchNo} updated — panel refreshed.`)] });
  }

  if (id.startsWith('idp:edate:modal:')) {
    const gid = id.split(':')[3];
    await interaction.deferReply({ ephemeral: true });
    const raw = interaction.fields.getTextInputValue('d_date').trim();
    let matchesDate = null;
    if (raw) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
      if (!m) return interaction.editReply({ embeds: [errorEmbed('Use `YYYY-MM-DD` (e.g. 2026-10-05), or leave empty to clear.')] });
      matchesDate = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 0, 0, 0));
      if (Number.isNaN(matchesDate.getTime())) return interaction.editReply({ embeds: [errorEmbed('That date is not valid.')] });
    }
    await prisma.idpGroup.update({ where: { id: gid }, data: { matchesDate } });
    await refreshPanel(interaction.client, gid);
    await idpAudit(interaction, 'IDP_EDIT', `Group ${gid}: matches date -> ${raw || 'cleared'}`);
    return interaction.editReply({ embeds: [successEmbed('Matches date updated — panel refreshed.')] });
  }

  if (id.startsWith('idp:remind:modal:')) {
    const gid = id.split(':')[3];
    await interaction.deferReply({ ephemeral: true });
    const group = await getGroup(gid);
    if (!group) return interaction.editReply({ embeds: [errorEmbed('Group not found.')] });
    const title = interaction.fields.getTextInputValue('r_title').trim();
    const message = interaction.fields.getTextInputValue('r_message').trim();
    const regs = await groupRegs(group);
    const mentions = [...new Set(regs.map((r) => r.team.owner?.discordId).filter(Boolean))];
    const ch = await groupChannel(interaction.client, group);
    if (!ch) return interaction.editReply({ embeds: [errorEmbed('Group channel not found.')] });
    await ch.send({
      content: mentions.map((mid) => `<@${mid}>`).join(' '),
      embeds: [new EmbedBuilder().setColor(0xf1c40f).setTitle(`🔔 ${title}`).setDescription(message)],
    });
    await idpAudit(interaction, 'IDP_REMIND', `${group.tournament.name} ${groupLabel(group)}: reminder "${title}" to ${mentions.length} owners`);
    return interaction.editReply({ embeds: [successEmbed(`Reminder sent to **${mentions.length}** team owner(s) in <#${group.channelId}>.`)] });
  }
}

module.exports = { handle, createIdpGroups, groupCount, idpPanelPayload, groupLabel };
