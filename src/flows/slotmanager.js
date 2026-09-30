/**
 * Slot Manager — a per-tournament channel (auto-created in the registration
 * channel's category) with ONE panel: team self-service buttons on top,
 * admin tools below (handlers enforce the admin gate).
 *
 * Row 1 (teams): Cancel My Slot · My Groups · Change Team Name
 * Row 2 (admin): Swap Groups · Cancel Slot · Transfer IDP Role
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
  EmbedBuilder, MessageFlags} = require('discord.js');
const { prisma } = require('../db');
const { requireAdmin, errorEmbed, successEmbed, audit, postAdminLog } = require('../utils');
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

/** Parse a "tag or slot number" reference: { slotNo } | { tag } | null. */
function parseSlotRef(raw) {
  const s = String(raw || '').trim().replace(/^#/, '');
  if (!s) return null;
  if (/^\d+$/.test(s)) return { slotNo: parseInt(s, 10) };
  return { tag: s };
}

/** Find an active registration by team tag or slot number. */
async function findActiveReg(tid, raw) {
  const ref = parseSlotRef(raw);
  if (!ref) return null;
  if (ref.slotNo != null) {
    return prisma.tournamentRegistration.findFirst({
      where: { tournamentId: tid, slotNo: ref.slotNo, status: { in: ACTIVE_REG } },
      include: { team: true },
    });
  }
  return prisma.tournamentRegistration.findFirst({
    where: { tournamentId: tid, status: { in: ACTIVE_REG }, team: { tag: { equals: ref.tag, mode: 'insensitive' } } },
    include: { team: true },
  });
}

/** In-flight group swaps: token -> { tid, firstRegId, secondRegId, expires }. */
const pendingSwap = new Map();
const crypto = require('crypto');
function stashPendingSwap(data) {
  for (const [k, v] of pendingSwap) if (v.expires < Date.now()) pendingSwap.delete(k);
  const token = crypto.randomBytes(8).toString('hex');
  pendingSwap.set(token, { ...data, expires: Date.now() + 10 * 60 * 1000 });
  return token;
}
function takePendingSwap(token) {
  const v = pendingSwap.get(token);
  pendingSwap.delete(token);
  if (!v || v.expires < Date.now()) return null;
  return v;
}

/** Move every Discord member of a team from one IDP group role to another. Never throws. */
async function moveTeamGroupRoles(guild, tid, teamId, fromGroupNo, toGroupNo) {
  try {
    const ids = await teamDiscordIds(teamId);
    const fromGrp = await prisma.idpGroup.findFirst({ where: { tournamentId: tid, groupNo: fromGroupNo } });
    const toGrp = await prisma.idpGroup.findFirst({ where: { tournamentId: tid, groupNo: toGroupNo } });
    for (const did of ids) {
      const m = await guild.members.fetch(did).catch(() => null);
      if (!m) continue;
      if (fromGrp?.roleId) {
        const r = await guild.roles.fetch(fromGrp.roleId).catch(() => null);
        if (r && m.roles.cache.has(r.id)) await m.roles.remove(r).catch(() => {});
      }
      if (toGrp?.roleId) {
        const r = await guild.roles.fetch(toGrp.roleId).catch(() => null);
        if (r && !m.roles.cache.has(r.id)) await m.roles.add(r).catch(() => {});
      }
    }
  } catch (e) {
    console.error('[slotmanager] moveTeamGroupRoles failed:', e.message);
  }
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

/** The single merged slot-manager panel: team self-service + admin tools. */
function slotManagerPanel(tid) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🎰 Tourney Slot Manager')
    .setDescription(
      'Manage your tournament slot right here — no need to ping the staff.\n\n' +
        '• Click **Cancel My Slot** below to cancel your slot.\n' +
        '• Click **My Groups** to get info about all your slots.\n' +
        '• Click **Change Team Name** if you want to update your team\'s name.\n\n' +
        '_Note that slot cancel is irreversible._\n\n' +
        '**🛠️ Admin tools** (staff only)\n' +
        '• **Swap Groups** — swap two teams\' slots (groups, roles, slot lists).\n' +
        '• **Cancel Slot** — cancel any team\'s slot.\n' +
        '• **Transfer IDP Role** — hand the IDP role to a new holder.'
    )
    .setFooter({ text: 'Your slot · your control' });
  const b = (action, label, style, emoji) =>
    new ButtonBuilder().setCustomId(`slot:${action}:${tid}`).setLabel(label).setStyle(style).setEmoji(emoji);
  const teamRow = new ActionRowBuilder().addComponents(
    b('cancelmy', 'Cancel My Slot', ButtonStyle.Danger, '❌'),
    b('mygroups', 'My Groups', ButtonStyle.Success, '👥'),
    b('changename', 'Change Team Name', ButtonStyle.Primary, '✏️')
  );
  const adminRow = new ActionRowBuilder().addComponents(
    b('swap', 'Swap Groups', ButtonStyle.Secondary, '🔀'),
    b('acancel', 'Cancel Slot', ButtonStyle.Danger, '❌'),
    b('transfer', 'Transfer IDP Role', ButtonStyle.Primary, '🔄')
  );
  return { embeds: [embed], components: [teamRow, adminRow] };
}

/** True when a channel message looks like one of the legacy slot-manager panels. */
function isLegacySlotPanel(msg, botId) {
  if (!msg || msg.author?.id !== botId) return false;
  const rows = msg.components || [];
  return rows.some((r) => (r.components || []).some((c) => String(c.customId || '').startsWith('slot:')));
}

/**
 * Create the #slot-manager channel in the registration channel's category
 * (if it doesn't exist yet) and make sure it holds exactly ONE panel.
 * Existing panels are edited in place; legacy two-panel setups are cleaned up.
 * Returns the channel.
 */
async function ensureSlotManager(client, guild, event) {
  const fresh = await prisma.tournament.findUnique({ where: { id: event.id } }).catch(() => null);
  const tourney = fresh || event;
  let ch = null;
  if (tourney.slotManagerChannelId) {
    ch = await guild.channels.fetch(tourney.slotManagerChannelId).catch(() => null);
    if (ch && !ch.isTextBased()) ch = null;
  }
  if (!ch) {
    const regCh = tourney.regChannelId ? await guild.channels.fetch(tourney.regChannelId).catch(() => null) : null;
    ch = await guild.channels.create({
      name: 'slot-manager',
      type: ChannelType.GuildText,
      parent: regCh?.parentId || null,
      reason: `Slot Manager for ${tourney.name}`,
    });
    await prisma.tournament.update({ where: { id: tourney.id }, data: { slotManagerChannelId: ch.id } }).catch(() => {});
  }
  const payload = slotManagerPanel(tourney.id);
  // Fast path: our tracked single panel — just refresh it.
  if (tourney.slotManagerPanelMsgId) {
    const msg = await ch.messages.fetch(tourney.slotManagerPanelMsgId).catch(() => null);
    if (msg) {
      await msg.edit(payload).catch(() => {});
      return ch;
    }
  }
  // Legacy path: delete the old two panels (team + admin), post one merged panel.
  try {
    const recent = await ch.messages.fetch({ limit: 30 }).catch(() => null);
    const botId = client.user?.id;
    if (recent && botId) {
      for (const msg of recent.values()) {
        if (isLegacySlotPanel(msg, botId) && msg.id !== tourney.slotManagerPanelMsgId) {
          await msg.delete().catch(() => {});
        }
      }
    }
  } catch (e) {
    console.error('[slotmanager] legacy panel cleanup failed:', e.message);
  }
  const posted = await ch.send(payload);
  await prisma.tournament
    .update({ where: { id: tourney.id }, data: { slotManagerChannelId: ch.id, slotManagerPanelMsgId: posted.id } })
    .catch(() => {});
  console.log(`[slotmanager] single panel posted for ${tourney.name}`);
  return ch;
}

/**
 * One-time startup sweep: tournaments whose channel predates the merged panel
 * get the legacy two-panel messages replaced with the single panel.
 */
async function reconcileLegacySlotPanels(client) {
  try {
    const legacy = await prisma.tournament.findMany({
      where: { slotManagerChannelId: { not: null }, slotManagerPanelMsgId: null },
      select: { id: true, name: true, slotManagerChannelId: true, regChannelId: true },
    });
    for (const t of legacy) {
      try {
        const guilds = [...client.guilds.cache.values()];
        for (const guild of guilds) {
          const ch = await guild.channels.fetch(t.slotManagerChannelId).catch(() => null);
          if (ch) {
            await ensureSlotManager(client, guild, t);
            break;
          }
        }
      } catch (e) {
        console.error('[slotmanager] legacy reconcile failed for', t.name, e.message);
      }
    }
  } catch (e) {
    console.error('[slotmanager] legacy reconcile sweep failed:', e.message);
  }
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
        await interaction.reply({ embeds: [errorEmbed('Something went wrong. Please try again.')], flags: MessageFlags.Ephemeral });
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
    if (!event) return interaction.reply({ embeds: [errorEmbed('Tournament not found.')], flags: MessageFlags.Ephemeral });
    const found = await myTeamReg(tid, interaction.user.id);
    if (!found) return interaction.reply({ embeds: [errorEmbed('You have no active slot in this tournament.')], flags: MessageFlags.Ephemeral });
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

  // ----- admin tools -----
  // Swap Groups (ADMIN ONLY): pick team 1, then team 2, confirm — their
  // group+slot numbers exchange, roles move, both slot lists re-post.
  if (action === 'swap' && parts.length === 3) {
    if (!(await requireAdmin(interaction))) return;
    const modal = new ModalBuilder().setCustomId(`slot:swap:first:${tid}`).setTitle('Swap Groups — Team 1');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('t_ref')
          .setLabel('First team — tag or slot number')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(32)
          .setPlaceholder('e.g. BRV or 12')
      )
    );
    return interaction.showModal(modal);
  }

  if (id.startsWith('slot:swap:yes:')) {
    if (!(await requireAdmin(interaction))) return;
    const token = id.split(':')[3];
    const pending = takePendingSwap(token);
    if (!pending?.secondRegId) {
      return interaction.reply({ embeds: [errorEmbed('This swap expired. Start again with Swap Groups.')], flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const regs = await prisma.tournamentRegistration.findMany({
      where: { id: { in: [pending.firstRegId, pending.secondRegId] } },
      include: { team: true, tournament: true },
    });
    const a = regs.find((r) => r.id === pending.firstRegId);
    const b = regs.find((r) => r.id === pending.secondRegId);
    if (!a || !b || !ACTIVE_REG.includes(a.status) || !ACTIVE_REG.includes(b.status)) {
      return interaction.editReply({ embeds: [errorEmbed('One of the teams no longer has an active slot. Swap aborted.')] });
    }
    const { postSlotList } = require('./idp');
    const gA = a.groupNo, sA = a.slotNo, gB = b.groupNo, sB = b.slotNo;
    await prisma.$transaction([
      prisma.tournamentRegistration.update({ where: { id: a.id }, data: { groupNo: gB, slotNo: sB } }),
      prisma.tournamentRegistration.update({ where: { id: b.id }, data: { groupNo: gA, slotNo: sA } }),
    ]);
    // Move Discord group roles along with each team.
    await moveTeamGroupRoles(interaction.guild, pending.tid, a.teamId, gA, gB);
    await moveTeamGroupRoles(interaction.guild, pending.tid, b.teamId, gB, gA);
    // Refresh both affected slot lists.
    try {
      const groups = await prisma.idpGroup.findMany({
        where: { tournamentId: pending.tid, groupNo: { in: [gA, gB] } },
        include: { tournament: true },
      });
      for (const g of groups) await postSlotList(interaction.client, interaction.guild, g);
    } catch (e) {
      console.error('[slotmanager] swap slot-list refresh failed:', e.message);
    }
    const event = a.tournament;
    await slotLog(
      interaction, event, 'GROUPS_SWAPPED',
      `**[${a.team.tag}] ${a.team.name}** (G${gA}/S${sA}) ⇄ **[${b.team.tag}] ${b.team.name}** (G${gB}/S${sB})`
    );
    await audit('GROUPS_SWAPPED', interaction.user.id, `${a.team.tag} (G${gA}/S${sA}) ⇄ ${b.team.tag} (G${gB}/S${sB})`);
    return interaction.editReply({
      embeds: [
        successEmbed(
          `Swapped:\n• **[${a.team.tag}] ${a.team.name}** → Group **${gB}**, Slot **${sB}**\n` +
            `• **[${b.team.tag}] ${b.team.name}** → Group **${gA}**, Slot **${sA}**\n` +
            `Roles moved and both slot lists re-posted.`
        ),
      ],
    });
  }

  if (id.startsWith('slot:swap:no:')) {
    if (!(await requireAdmin(interaction))) return;
    takePendingSwap(id.split(':')[3]);
    return interaction.update({ content: 'Swap cancelled.', embeds: [], components: [] });
  }

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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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

  // Swap step 1 -> ask for team 2. / Swap step 2 -> confirm screen.
  if (id.startsWith('slot:swap:first:')) {
    if (!(await requireAdmin(interaction))) return;
    const tid = id.split(':')[3];
    const raw = interaction.fields.getTextInputValue('t_ref');
    const first = await findActiveReg(tid, raw);
    if (!first) {
      return interaction.reply({ embeds: [errorEmbed(`No active slot found for "${raw}". Try the team tag or slot number.`)], flags: MessageFlags.Ephemeral });
    }
    const token = stashPendingSwap({ tid, firstRegId: first.id });
    const modal = new ModalBuilder().setCustomId(`slot:swap:second:${token}`).setTitle('Swap Groups — Team 2');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('t_ref')
          .setLabel('Second team — tag or slot number')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(32)
          .setPlaceholder('e.g. XYZ or 27')
      )
    );
    return interaction.showModal(modal);
  }

  if (id.startsWith('slot:swap:second:')) {
    if (!(await requireAdmin(interaction))) return;
    const token = id.split(':')[3];
    const pending = pendingSwap.get(token);
    if (!pending) {
      return interaction.reply({ embeds: [errorEmbed('This swap expired. Start again with Swap Groups.')], flags: MessageFlags.Ephemeral });
    }
    const raw = interaction.fields.getTextInputValue('t_ref');
    const second = await findActiveReg(pending.tid, raw);
    if (!second) {
      return interaction.reply({ embeds: [errorEmbed(`No active slot found for "${raw}". Try the team tag or slot number.`)], flags: MessageFlags.Ephemeral });
    }
    if (second.id === pending.firstRegId) {
      return interaction.reply({ embeds: [errorEmbed('Pick a different team — you selected the same team twice.')], flags: MessageFlags.Ephemeral });
    }
    const first = await prisma.tournamentRegistration.findUnique({
      where: { id: pending.firstRegId },
      include: { team: true },
    });
    if (!first || !ACTIVE_REG.includes(first.status)) {
      takePendingSwap(token);
      return interaction.reply({ embeds: [errorEmbed('The first team no longer has an active slot. Start over.')], flags: MessageFlags.Ephemeral });
    }
    pending.secondRegId = second.id;
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`slot:swap:yes:${token}`).setLabel('Yes, swap them').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`slot:swap:no:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    );
    const sameGroup = first.groupNo === second.groupNo;
    return interaction.reply({
      flags: MessageFlags.Ephemeral,
      embeds: [
        new EmbedBuilder()
          .setColor(0xfaa81a)
          .setTitle('🔀 Confirm Group Swap')
          .setDescription(
            `• **[${first.team.tag}] ${first.team.name}** — Group **${first.groupNo}**, Slot **${first.slotNo}**\n` +
              `• **[${second.team.tag}] ${second.team.name}** — Group **${second.groupNo}**, Slot **${second.slotNo}**\n\n` +
              `Their group + slot numbers will **exchange**, Discord group roles move with each team, ` +
              `and both group slot lists will be re-posted.` +
              (sameGroup ? '\n\n⚠️ Both teams are in the same group — only their **slot numbers** will exchange.' : '')
          ),
      ],
      components: [row],
    });
  }

  if (id.startsWith('slot:acancel:modal:')) {
    if (!(await requireAdmin(interaction))) return;
    const tid = id.split(':')[3];
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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

module.exports = { handle, ensureSlotManager, reconcileLegacySlotPanels, slotManagerPanel, myTeamReg, parseSlotRef, findActiveReg };
