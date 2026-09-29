const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  RoleSelectMenuBuilder,
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

/** Playable maps for the map picker. */
const MAPS = ['Erangel', 'Miramar', 'Rondo'];

/** Map artwork for panel thumbnails — official PUBG map overviews (Krafton CDN). */
const MAP_IMAGES = {
  Erangel: 'https://wstatic-prod.pubg.com/web/live/main_cde2eae/img/590dba7.webp',
  Miramar: 'https://wstatic-prod.pubg.com/web/live/main_cde2eae/img/24a088e.webp',
  Rondo: 'https://wstatic-prod.pubg.com/web/live/main_cde2eae/img/8dad1dc.webp',
};

/**
 * Parse an admin's naming input like "XYZ G1" or "XYZ R1 G1".
 * Returns { prefix, start } — "XYZ G1" -> { prefix: "XYZ G", start: 1 }.
 */
function parseNamePattern(input) {
  const t = (input || '').trim().slice(0, 60);
  const m = t.match(/^(.*?)(\d+)$/);
  if (m && m[1].trim()) return { prefix: m[1], start: parseInt(m[2], 10) };
  return { prefix: t ? t + ' ' : '', start: 1 };
}

/** Display name for the i-th group (i = 0-based): "XYZ G1" -> "XYZ G1", "XYZ G2", ... */
function groupDisplayName(pattern, i) {
  const { prefix, start } = parseNamePattern(pattern);
  const name = `${prefix}${start + i}`.trim();
  return name || `Group ${start + i}`;
}

/** Discord channel names must be lowercase slug-style: "XYZ R1 G1" -> "xyz-r1-g1". */
function groupChannelName(displayName) {
  return (
    displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 90) || 'group'
  );
}

/** All Discord IDs (owner + roster players) for the active teams of a group. */
async function groupMemberDiscordIds(group) {
  const regs = await prisma.tournamentRegistration.findMany({
    where: { tournamentId: group.tournamentId, groupNo: group.groupNo, status: { in: ACTIVE_REG } },
    include: { team: { include: { owner: true, members: { include: { player: true } } } } },
  });
  const ids = [];
  for (const r of regs) {
    if (r.team.owner?.discordId) ids.push(r.team.owner.discordId);
    for (const m of r.team.members || []) if (m.player?.discordId) ids.push(m.player.discordId);
  }
  return [...new Set(ids)];
}

/** Assign a role to Discord users, best-effort. Returns count assigned. Never throws. */
async function assignRoleToIds(guild, roleId, discordIds) {
  try {
    if (!roleId || !discordIds?.length) return 0;
    const role = await guild.roles.fetch(roleId).catch(() => null);
    if (!role) return 0;
    let n = 0;
    for (const did of [...new Set(discordIds)]) {
      const member = await guild.members.fetch(did).catch(() => null);
      if (member && !member.roles.cache.has(role.id)) {
        await member.roles.add(role).catch(() => {});
        n++;
      }
      await new Promise((r) => setTimeout(r, 120)); // ease off rate limits
    }
    return n;
  } catch (e) {
    console.error('[idp] assignRoleToIds failed:', e.message);
    return 0;
  }
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
  const tourName = group.tournament?.name || 'Tournament';
  const isScrim = group.tournament?.type === 'SCRIM';
  const matches = [...(group.matches || [])].sort((a, b) => a.matchNo - b.matchNo);
  const dateStr = group.matchesDate ? formatIST(group.matchesDate).split(' ')[0] : 'TBD';
  const revealed = matches.find((m) => m.map && MAP_IMAGES[m.map]);
  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle(`🗂️ ${label} · Match Schedule`)
    .setDescription(
      `**🏆 Event:** ${tourName}\n` +
        `**📅 Matches Date:** ${dateStr}\n` +
        `**👥 Total Slots:** ${group.tournament?.teamsPerGroup || '—'}\n` +
        `**🎮 Total Matches:** ${matches.length}\n\n` +
        (matches
          .map((m) => `**Match ${m.matchNo}** — 🗺️ ${m.map || '_Not revealed yet_'}\n✨ IDP AT: \`${m.idpAt || 'TBD'}\` · 🚀 START AT: \`${m.startAt || 'TBD'}\``)
          .join('\n\n') || '_No matches scheduled yet — press Edit to add one._')
    )
    .setFooter({ text: group.locked ? '🔒 Group locked — only staff can send messages' : '🔓 Group unlocked' })
    .setTimestamp();
  if (revealed) embed.setThumbnail(MAP_IMAGES[revealed.map]);
  const b = (action, btnLabel, style, emoji) =>
    new ButtonBuilder().setCustomId(`idp:${action}:${group.id}`).setLabel(btnLabel).setStyle(style).setEmoji(emoji);
  const lockBtn = group.locked
    ? b('unlock', 'Unlock Group', ButtonStyle.Secondary, '🔓')
    : b('lock', 'Lock Group', ButtonStyle.Secondary, '🔒');
  // Punish Teams is a scrims-only tool — tournaments don't get it.
  const row1Btns = [
    b('edit', 'Edit', ButtonStyle.Primary, '✏️'),
    b('slotlist', 'Send Slot List', ButtonStyle.Success, '📋'),
    ...(isScrim ? [b('punish', 'Punish Teams', ButtonStyle.Danger, '⚠️')] : []),
    b('qualify', 'Qualify Teams', ButtonStyle.Primary, '✅'),
    b('remind', 'Send Reminders', ButtonStyle.Secondary, '🔔'),
  ];
  const rows = [new ActionRowBuilder().addComponents(...row1Btns)];
  // Scrims fill row 1, so the lock toggle gets its own row there.
  if (isScrim) rows.push(new ActionRowBuilder().addComponents(lockBtn));
  else rows[0].addComponents(lockBtn);
  return { embeds: [embed], components: rows };
}

/** Returns `<@&roleId>` for the group's role, ensuring the role is mentionable. Never throws. */
async function groupRolePing(guild, group) {
  try {
    if (!group?.roleId) return '';
    const role = await guild.roles.fetch(group.roleId).catch(() => null);
    if (!role) return '';
    if (!role.mentionable) await role.setMentionable(true).catch(() => {});
    return `<@&${role.id}>`;
  } catch {
    return '';
  }
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
 * Create the IDP category + group channels + roles + schedule panels for an event.
 * Resumes a partially-created set instead of failing when the category already exists.
 * namePattern (e.g. "XYZ G1") names the groups; on resume the stored pattern is reused.
 * Each group gets a Discord role (named like the group) assigned to its teams' members.
 */
async function createIdpGroups(client, guild, eventId, guildId, namePattern) {
  const event = await prisma.tournament.findUnique({ where: { id: eventId } });
  if (!event) throw new Error('Event not found.');
  const settings = await prisma.guildSettings.findUnique({ where: { guildId } });
  const perGroup = event.teamsPerGroup || settings?.groupSize || 20;
  const n = groupCount(event.teamLimit, perGroup);
  const pattern = namePattern || event.idpNamePattern || `${event.name} G1`;
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
    await prisma.tournament.update({
      where: { id: event.id },
      data: { idpCategoryId: category.id, idpNamePattern: pattern.slice(0, 60) },
    });
  }
  let created = 0;
  const failures = [];
  const panelFailures = [];
  // Self-heal: groups created earlier whose panel post failed get their panel now.
  const paneless = await prisma.idpGroup.findMany({ where: { tournamentId: event.id, panelMsgId: null } });
  for (const g of paneless) {
    try {
      const ch = await guild.channels.fetch(g.channelId).catch(() => null);
      if (!ch || !ch.isTextBased()) continue;
      const full = await getGroup(g.id);
      const msg = await ch.send(idpPanelPayload(full));
      await prisma.idpGroup.update({ where: { id: g.id }, data: { panelMsgId: msg.id } });
      console.log(`[idp] reposted missing panel for group ${g.groupNo}`);
    } catch (e) {
      console.error(`[idp] repost panel for group ${g.groupNo} failed:`, e.message);
    }
  }
  for (let g = 1; g <= n; g++) {
    if (have.has(g)) continue; // already exists from a previous run
    const displayName = groupDisplayName(pattern, g - 1);
    try {
      const ch = await guild.channels.create({
        name: groupChannelName(displayName),
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.SendMessages] }],
      });
      const role = await guild.roles.create({ name: displayName.slice(0, 100), mentionable: true, reason: `IDP group role for ${event.name}` }).catch(() => null);
      const grp = await prisma.idpGroup.create({
        data: {
          tournamentId: event.id,
          groupNo: g,
          channelId: ch.id,
          categoryId: category.id,
          roleId: role?.id || null,
          locked: true,
          matchesDate: event.date,
          totalMatches: 1,
        },
      });
      // Maps stay hidden until the admin reveals them via Edit.
      await prisma.idpMatch.create({ data: { idpGroupId: grp.id, matchNo: 1, map: null } });
      // Hand the group role to the teams already slotted in this group.
      const memberIds = await groupMemberDiscordIds({ ...grp, tournamentId: event.id, groupNo: g });
      const assigned = await assignRoleToIds(guild, grp.roleId, memberIds);
      // The schedule panel post is isolated — a panel failure must never fail the group itself.
      try {
        const full = await getGroup(grp.id);
        const msg = await ch.send(idpPanelPayload(full));
        await prisma.idpGroup.update({ where: { id: grp.id }, data: { panelMsgId: msg.id } });
      } catch (e) {
        console.error(`[idp] panel post failed for ${displayName}:`, e.message);
        panelFailures.push(displayName);
      }
      created++;
      console.log(`[idp] created ${displayName} (${assigned} members given the role)`);
      await new Promise((r) => setTimeout(r, 400)); // ease off channel-creation rate limits
    } catch (e) {
      console.error(`[idp] group ${g} (${displayName}) creation failed:`, e.message);
      failures.push(g);
    }
  }
  return { eventName: event.name, categoryName: category.name, pattern, groups: created, failures, panelFailures, resumed: have.size > 0 };
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
          label: `Match ${m.matchNo} — ${m.map || 'Not revealed yet'}`.slice(0, 100),
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
    const rolePing = await groupRolePing(interaction.guild, group);
    await ch.send({
      ...(rolePing ? { content: rolePing } : {}),
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

  if (action === 'qualify') {
    await interaction.deferReply({ ephemeral: true });
    const group = await getGroup(gid);
    if (!group) return interaction.editReply({ content: 'Group not found.', embeds: [], components: [] });
    const regs = await groupRegs(group);
    if (!regs.length) return interaction.editReply({ embeds: [errorEmbed('No active teams in this group.')] });
    const row = new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId(`idp:qrole:${gid}`)
        .setPlaceholder('Select the role for qualified teams')
        .setMinValues(1)
        .setMaxValues(1)
    );
    return interaction.editReply({
      content: `Which role should be given to the qualified teams of **${groupLabel(group)}**?`,
      components: [row],
    });
  }

  if (action === 'punish') {
    await interaction.deferReply({ ephemeral: true });
    const group = await getGroup(gid);
    if (!group) return interaction.editReply({ content: 'Group not found.', embeds: [], components: [] });
    const regs = await groupRegs(group);
    if (!regs.length) return interaction.editReply({ embeds: [errorEmbed('No active teams in this group.')] });
    const select = new StringSelectMenuBuilder()
      .setCustomId(`idp:punish:pick:${gid}`)
      .setPlaceholder('Select teams to punish (disqualify)')
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
      content: `Select teams to **punish (disqualify)** in **${groupLabel(group)}**:`,
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
}

// ---------- selects ----------

async function handleSelect(interaction) {
  const id = interaction.customId;

  if (id.startsWith('idp:ematch:')) {
    const gid = id.split(':')[2];
    await interaction.deferUpdate();
    const val = interaction.values[0];
    let matchId = val;
    if (val === 'ADD') {
      // One quick create before showing the editor — kept minimal so the ack window holds.
      const group = await getGroup(gid);
      if (!group) return interaction.editReply({ content: 'Group not found.', embeds: [], components: [] });
      const nextNo = group.matches.length ? Math.max(...group.matches.map((m) => m.matchNo)) + 1 : 1;
      const m = await prisma.idpMatch.create({ data: { idpGroupId: gid, matchNo: nextNo, map: null } });
      await prisma.idpGroup.update({ where: { id: gid }, data: { totalMatches: nextNo } });
      matchId = m.id;
    }
    const match = await prisma.idpMatch.findUnique({ where: { id: matchId } });
    if (!match) return interaction.editReply({ content: 'Match not found.', embeds: [], components: [] });
    // Match editor: map picker dropdown + times button, rendered on the same message.
    const mapSelect = new StringSelectMenuBuilder()
      .setCustomId(`idp:emap:${match.id}`)
      .setPlaceholder(`Map: ${match.map || 'Not revealed yet'}`)
      .addOptions([
        { label: 'Not revealed yet', value: 'NONE', description: 'Hide the map for now', emoji: '🗺️' },
        ...MAPS.map((mp) => ({ label: mp, value: mp, emoji: '🎮' })),
      ]);
    const row = new ActionRowBuilder().addComponents(mapSelect);
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`idp:etimes:${match.id}`).setLabel('Edit IDP / Start Times').setStyle(ButtonStyle.Secondary).setEmoji('⏰')
    );
    return interaction.editReply({
      content: `Editing **Match ${match.matchNo}** — pick the map, or edit times:`,
      embeds: [],
      components: [row, row2],
    });
  }

  if (id.startsWith('idp:emap:')) {
    const matchId = id.split(':')[2];
    await interaction.deferUpdate();
    const picked = (interaction.values || [])[0];
    const map = picked && picked !== 'NONE' ? picked : null;
    await prisma.idpMatch.update({ where: { id: matchId }, data: { map } });
    const match = await prisma.idpMatch.findUnique({ where: { id: matchId } });
    await refreshPanel(interaction.client, match.idpGroupId);
    const group = await getGroup(match.idpGroupId);
    await idpAudit(interaction, 'IDP_EDIT', `${group?.tournament.name} ${group ? groupLabel(group) : ''}: Match ${match.matchNo} map -> ${map || 'not revealed'}`);
    return interaction.editReply({
      content: `🗺️ Match **${match.matchNo}** map set to **${map || 'Not revealed yet'}** — panel refreshed.`,
      embeds: [],
      components: [],
    });
  }

  if (id.startsWith('idp:etimes:')) {
    const matchId = id.split(':')[2];
    const match = await prisma.idpMatch.findUnique({ where: { id: matchId } });
    if (!match) return interaction.reply({ embeds: [errorEmbed('Match not found.')], ephemeral: true });
    // showModal must be the first acknowledge — no defer allowed here.
    const modal = new ModalBuilder().setCustomId(`idp:ematch:modal:${match.id}`).setTitle(`Match ${match.matchNo} Times`);
    const mk = (cid, label, value, ph) =>
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId(cid).setLabel(label).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(32).setValue(value || '').setPlaceholder(ph)
      );
    modal.addComponents(mk('m_idpat', 'IDP AT (e.g. 12:45 PM)', match.idpAt, '12:45 PM'), mk('m_startat', 'START AT (e.g. 12:55 PM)', match.startAt, '12:55 PM'));
    return interaction.showModal(modal);
  }

  if (id.startsWith('idp:qrole:')) {
    const gid = id.split(':')[2];
    const roleId = (interaction.values || [])[0];
    if (!roleId) return interaction.reply({ content: 'No role selected.', ephemeral: true });
    await interaction.deferUpdate();
    const group = await getGroup(gid);
    if (!group) return interaction.editReply({ content: 'Group not found.', embeds: [], components: [] });
    const regs = await groupRegs(group);
    const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
    const select = new StringSelectMenuBuilder()
      .setCustomId(`idp:qualify:pick:${gid}:${roleId}`)
      .setPlaceholder('Select teams to qualify')
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
      content: `Qualified teams will get the **${role ? role.name : 'selected'}** role. Now select the teams to qualify in **${groupLabel(group)}**:`,
      components: [new ActionRowBuilder().addComponents(select)],
    });
  }

  if (id.startsWith('idp:qualify:pick:')) {
    const [, , gid, roleId] = id.split(':');
    await interaction.deferUpdate();
    const group = await getGroup(gid);
    if (!group) return interaction.editReply({ content: 'Group not found.', embeds: [], components: [] });
    const regIds = [...new Set(interaction.values || [])];
    const regs = await prisma.tournamentRegistration.findMany({
      where: { id: { in: regIds } },
      include: { team: true },
    });
    if (!regs.length) return interaction.editReply({ content: 'No teams selected.', embeds: [], components: [] });
    const token = stashPending({ kind: 'qualify', gid, roleId, regIds: regs.map((r) => r.id) });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`idp:qualify:yes:${token}`).setLabel('Confirm').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`idp:qualify:no:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    );
    return interaction.editReply({
      content: `Are you sure you want to **mark qualified** (role <@&${roleId}>):\n${regs.map((r) => `• **[${r.team.tag}]** ${r.team.name} (Slot ${r.slotNo})`).join('\n')}`,
      embeds: [],
      components: [row],
    });
  }

  if (id.startsWith('idp:punish:pick:')) {
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
    const token = stashPending({ kind: 'punish', gid, regIds: regs.map((r) => r.id) });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`idp:punish:yes:${token}`).setLabel('Confirm').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`idp:punish:no:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    );
    return interaction.editReply({
      content: `Are you sure you want to **punish (disqualify)**:\n${regs.map((r) => `• **[${r.team.tag}]** ${r.team.name} (Slot ${r.slotNo})`).join('\n')}`,
      embeds: [],
      components: [row],
    });
  }

  if (id.startsWith('idp:punish:yes:') || id.startsWith('idp:qualify:yes:')) {
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
    const regs = await prisma.tournamentRegistration.findMany({
      where: { id: { in: pending.regIds } },
      include: { team: { include: { owner: true, members: { include: { player: true } } } } },
    });
    const ch = await groupChannel(interaction.client, group);
    const rolePing = await groupRolePing(interaction.guild, group);
    if (kind === 'punish') {
      await prisma.tournamentRegistration.updateMany({ where: { id: { in: pending.regIds } }, data: { status: 'DISQUALIFIED' } });
      const msg = `⚠️ **Punished (disqualified)** in ${groupLabel(group)}:\n${regs.map((r) => `• **[${r.team.tag}]** ${r.team.name} (was Slot ${r.slotNo})`).join('\n')}`;
      if (ch) await ch.send({ ...(rolePing ? { content: rolePing } : {}), embeds: [new EmbedBuilder().setColor(0xed4245).setDescription(msg)] });
      await idpAudit(interaction, 'IDP_PUNISH', `${group.tournament.name} ${groupLabel(group)}: disqualified ${regs.map((r) => r.team.tag).join(', ')}`);
      return interaction.editReply({ content: `✅ Disqualified **${regs.length}** team(s).`, embeds: [], components: [] });
    }
    // qualify — mark qualified AND hand them the chosen role
    await prisma.tournamentRegistration.updateMany({ where: { id: { in: pending.regIds } }, data: { qualified: true } });
    const memberIds = [];
    for (const r of regs) {
      if (r.team.owner?.discordId) memberIds.push(r.team.owner.discordId);
      for (const m of r.team.members || []) if (m.player?.discordId) memberIds.push(m.player.discordId);
    }
    const role = pending.roleId ? await interaction.guild.roles.fetch(pending.roleId).catch(() => null) : null;
    const given = await assignRoleToIds(interaction.guild, pending.roleId, memberIds);
    const msg =
      `✅ **Qualified** from ${groupLabel(group)}` + (role ? ` — role **${role.name}** given to **${given}** member(s)` : '') + `:\n` +
      regs.map((r) => `• **[${r.team.tag}]** ${r.team.name} (Slot ${r.slotNo})`).join('\n');
    if (ch) await ch.send({ ...(rolePing ? { content: rolePing } : {}), embeds: [new EmbedBuilder().setColor(0x57f287).setDescription(msg)] });
    await idpAudit(interaction, 'IDP_QUALIFY', `${group.tournament.name} ${groupLabel(group)}: qualified ${regs.map((r) => r.team.tag).join(', ')}${role ? ` (+${role.name})` : ''}`);
    return interaction.editReply({ content: `✅ Marked **${regs.length}** team(s) qualified${role ? ` and gave **${role.name}** to **${given}** member(s)` : ''}.`, embeds: [], components: [] });
  }

  if (id.startsWith('idp:punish:no:') || id.startsWith('idp:qualify:no:')) {
    pendingIdp.delete(id.split(':')[3]);
    return interaction.update({ content: 'Cancelled.', embeds: [], components: [] });
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
    const idpAt = interaction.fields.getTextInputValue('m_idpat').trim() || null;
    const startAt = interaction.fields.getTextInputValue('m_startat').trim() || null;
    await prisma.idpMatch.update({ where: { id: match.id }, data: { idpAt, startAt } });
    await refreshPanel(interaction.client, match.idpGroupId);
    const group = await getGroup(match.idpGroupId);
    await idpAudit(interaction, 'IDP_EDIT', `${group?.tournament.name} ${group ? groupLabel(group) : ''}: Match ${match.matchNo} -> IDP ${idpAt || 'TBD'}, Start ${startAt || 'TBD'}`);
    return interaction.editReply({ embeds: [successEmbed(`Match ${match.matchNo} times updated — panel refreshed.`)] });
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
    const rolePing = await groupRolePing(interaction.guild, group);
    await ch.send({
      content: [rolePing, ...mentions.map((mid) => `<@${mid}>`)].filter(Boolean).join(' '),
      embeds: [new EmbedBuilder().setColor(0xf1c40f).setTitle(`🔔 ${title}`).setDescription(message)],
    });
    await idpAudit(interaction, 'IDP_REMIND', `${group.tournament.name} ${groupLabel(group)}: reminder "${title}" to ${mentions.length} owners`);
    return interaction.editReply({ embeds: [successEmbed(`Reminder sent to **${mentions.length}** team owner(s) in <#${group.channelId}>.`)] });
  }
}

module.exports = { handle, createIdpGroups, groupCount, idpPanelPayload, groupLabel, parseNamePattern, groupDisplayName, groupChannelName, assignRoleToIds, refreshPanel, groupRolePing, MAPS };
