/**
 * Scrim group lifecycle — Agent G (scrimport-1).
 *
 * Handles: bs:panel:* (staff group panel), bs:warn:modal:* / bs:remove:modal:*
 * / bs:qualify:modal:* (modal submits), bs:team:* (team self-service).
 *
 * Exports:
 *   handle(interaction)                       -> true when handled
 *   createScrimGroup(interaction, track, opts) -> shared by /create_group + /create_group_t3
 *   renderSlotList(groupId)                    -> string, reused by the reminders agent
 *   startCleanupScheduler(client)              -> deletes channel+role 3h after results
 *   _test = { slotRangeOk, startAtFromIdp }
 */
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { prisma } = require('../db');
const {
  requireAdmin,
  errorEmbed,
  successEmbed,
  audit,
  parseDateTimeIST,
  formatIST,
  getSettings,
} = require('../utils');
const { groupPanel, teamSelfServicePanel } = require('../scrimpanels');

// ---------- ScrimFormSession helpers (Agent V contract) ----------
// scrims.js is owned by a parallel agent; use its helpers when present,
// otherwise fall back to direct ScrimFormSession access with the same semantics.
let _sessionApi = null;
try {
  _sessionApi = require('./scrims');
} catch (e) {
  _sessionApi = null; // parallel agent hasn't landed yet — use local fallback
}
const _hasSessions = (m) => m && m.saveSession && m.getSession && m.deleteSession;

async function saveSession(userDiscordId, flowType, payload, ttlMinutes = 30) {
  try {
    if (_hasSessions(_sessionApi)) return _sessionApi.saveSession(userDiscordId, flowType, payload, ttlMinutes);
    await prisma.scrimFormSession.deleteMany({ where: { userDiscordId: String(userDiscordId), flowType } });
    return prisma.scrimFormSession.create({
      data: {
        userDiscordId: String(userDiscordId),
        flowType,
        payload: JSON.stringify(payload || {}),
        expiresAt: new Date(Date.now() + ttlMinutes * 60000),
      },
    });
  } catch (e) {
    console.error('[scrimgroups] saveSession failed:', e.message);
    return null;
  }
}
async function getSession(userDiscordId, flowType) {
  try {
    if (_hasSessions(_sessionApi)) return _sessionApi.getSession(userDiscordId, flowType);
    const s = await prisma.scrimFormSession.findFirst({
      where: { userDiscordId: String(userDiscordId), flowType, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    return s ? JSON.parse(s.payload || '{}') : null;
  } catch (e) {
    console.error('[scrimgroups] getSession failed:', e.message);
    return null;
  }
}
async function deleteSession(userDiscordId, flowType) {
  try {
    if (_hasSessions(_sessionApi)) return _sessionApi.deleteSession(userDiscordId, flowType);
    await prisma.scrimFormSession.deleteMany({ where: { userDiscordId: String(userDiscordId), flowType } });
  } catch (e) {
    console.error('[scrimgroups] deleteSession failed:', e.message);
  }
}

// ---------- Config ----------

const SLOT_MIN = 5;
const SLOT_MAX = 25; // 21 slots total, mirrored from source
const START_OFFSET_MIN = 6; // match start = IDP + 6 min (source parity)
const CANCEL_LOCK_MIN = 30; // self-service locked within 30 min of match-1 IDP
const CLEANUP_AFTER_MS = 3 * 3600 * 1000; // delete channel+role 3h after results
const MAX_WARNINGS = parseInt(process.env.SLOT_WASTE_MAX_WARNINGS || '3', 10) || 3;
const BAN_DAYS = parseInt(process.env.SLOT_WASTE_BAN_DAYS || '30', 10) || 30;

const categoryEnvFor = (track) =>
  track === 'T3' ? process.env.SCRIMS_T3_CATEGORY_ID : process.env.SCRIMS_OQ_CATEGORY_ID;
const resultsChannelFor = (track) =>
  track === 'T3' ? process.env.SCRIMS_T3_RESULTS_CHANNEL_ID : process.env.SCRIMS_OQ_RESULTS_CHANNEL_ID;
const warnChannelFor = (track) =>
  track === 'T3' ? process.env.SCRIMS_T3_WARN_CHANNEL_ID : process.env.SCRIMS_OQ_WARN_CHANNEL_ID;
const qualifiedRoleFor = (track) =>
  track === 'T3' ? process.env.SCRIMS_T3_QUALIFIED_ROLE_ID : process.env.SCRIMS_OQ_QUALIFIED_ROLE_ID;

// ---------- Pure helpers (exported for tests) ----------

const slotRangeOk = (n) => Number.isInteger(n) && n >= SLOT_MIN && n <= SLOT_MAX;
const startAtFromIdp = (idpDate) => new Date(idpDate.getTime() + START_OFFSET_MIN * 60000);

/** Lazy to avoid a require cycle (scrimidp imports renderSlotList from here). */
function notifyVacancySafe(groupId, client) {
  try {
    require('./scrimidp').notifyVacancy(groupId, client).catch(() => {});
  } catch {}
}

// ---------- Internal helpers ----------

async function ephemeralError(interaction, msg) {
  const payload = { embeds: [errorEmbed(msg)], ephemeral: true };
  if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
  else await interaction.reply(payload).catch(() => {});
}

async function getGroup(groupId) {
  return prisma.scrimGroup.findUnique({ where: { id: String(groupId) } });
}

/** Active scrim registration of the caller's owned team in this group. */
async function myScrimReg(groupId, discordId) {
  try {
    const team = await prisma.team.findFirst({
      where: { status: 'ACTIVE', owner: { discordId: String(discordId) } },
      include: { owner: true },
    });
    if (!team) return null;
    const reg = await prisma.scrimRegistration.findFirst({
      where: { teamId: team.id, groupId: String(groupId), status: 'ACTIVE' },
    });
    return reg ? { team, reg } : null;
  } catch (e) {
    console.error('[scrimgroups] myScrimReg failed:', e.message);
    return null;
  }
}

/** True when match-1 IDP is less than CANCEL_LOCK_MIN away (self-service locked). */
async function selfServiceLocked(groupId) {
  try {
    const m1 = await prisma.scrimMatch.findFirst({
      where: { groupId: String(groupId), matchNo: 1 },
    });
    if (!m1 || !m1.idpAt) return false;
    return Date.now() > m1.idpAt.getTime() - CANCEL_LOCK_MIN * 60000;
  } catch (e) {
    console.error('[scrimgroups] selfServiceLocked failed:', e.message);
    return true; // fail closed on lock check
  }
}

async function setGroupRole(interaction, discordId, roleId, add) {
  try {
    if (!roleId || !interaction.guild || !discordId) return false;
    const member = await interaction.guild.members.fetch(String(discordId)).catch(() => null);
    if (!member) return false;
    if (add) await member.roles.add(roleId).catch(() => {});
    else await member.roles.remove(roleId).catch(() => {});
    return true;
  } catch (e) {
    console.error('[scrimgroups] setGroupRole failed:', e.message);
    return false;
  }
}

async function postToChannel(client, guild, channelId, payload) {
  try {
    if (!channelId) return false;
    const ch = guild
      ? await guild.channels.fetch(String(channelId)).catch(() => null)
      : await client.channels.fetch(String(channelId)).catch(() => null);
    if (!ch || !ch.isTextBased()) return false;
    await ch.send(payload);
    return true;
  } catch (e) {
    console.error('[scrimgroups] postToChannel failed:', e.message);
    return false;
  }
}

/**
 * Numbered slot list (5..25) with team names or "— empty —".
 * Exported for the reminders agent (auto-publish).
 */
async function renderSlotList(groupId) {
  try {
    const group = await prisma.scrimGroup.findUnique({
      where: { id: String(groupId) },
      include: { slots: true },
    });
    if (!group) return 'Slot list unavailable (group not found).';
    const teamIds = group.slots.filter((s) => s.teamId).map((s) => s.teamId);
    const teams = teamIds.length
      ? await prisma.team.findMany({ where: { id: { in: teamIds } }, select: { id: true, name: true } })
      : [];
    const names = new Map(teams.map((t) => [t.id, t.name]));
    const lines = group.slots
      .sort((a, b) => a.slotNo - b.slotNo)
      .map((s) => `**${s.slotNo}.** ${s.teamId ? names.get(s.teamId) || 'Unknown team' : '— empty —'}`);
    const header = `**📋 ${group.groupType} Group ${group.groupNo} — Slot List${
      group.matchDate ? ` — ${formatIST(group.matchDate)}` : ''
    }**`;
    return `${header}\n${lines.join('\n')}`;
  } catch (e) {
    console.error('[scrimgroups] renderSlotList failed:', e.message);
    return 'Could not load the slot list right now.';
  }
}

/**
 * Create a scrim group: Discord role + private channel, DB records
 * (ScrimGroup + 21 ScrimSlots 5..25 + 2 ScrimMatches), management panel,
 * team self-service panel. Admin-only.
 */
async function createScrimGroup(interaction, track, { date, map1, map2, idp1, idp2 }) {
  try {
    if (!(await requireAdmin(interaction))) return;
    track = String(track || '').toUpperCase();
    if (!['OQ', 'T3'].includes(track)) {
      return ephemeralError(interaction, 'Invalid track. Use OQ or T3.');
    }
    const dateStr = String(date || '').trim();
    const idpAt1 = parseDateTimeIST(`${dateStr} ${String(idp1 || '').trim()}`);
    const idpAt2 = parseDateTimeIST(`${dateStr} ${String(idp2 || '').trim()}`);
    if (!idpAt1 || !idpAt2) {
      return ephemeralError(interaction, 'Invalid date/time. Use YYYY-MM-DD and HH:MM (24h, IST).');
    }
    if (idpAt2.getTime() <= idpAt1.getTime()) {
      return ephemeralError(interaction, 'Match 2 IDP must be after Match 1 IDP.');
    }
    const startAt1 = startAtFromIdp(idpAt1);
    const startAt2 = startAtFromIdp(idpAt2);

    const guild = interaction.guild;
    if (!guild) return ephemeralError(interaction, 'This command only works in a server.');

    const last = await prisma.scrimGroup.findFirst({
      where: { groupType: track },
      orderBy: { groupNo: 'desc' },
    });
    const groupNo = (last && last.groupNo ? last.groupNo : 0) + 1;

    // Discord role: "BR <track> G<no>"
    let role = null;
    try {
      role = await guild.roles.create({
        name: `BR ${track} G${groupNo}`,
        mentionable: true,
        reason: `Scrim group ${track} G${groupNo}`,
      });
    } catch (e) {
      console.error('[scrimgroups] role create failed:', e.message);
    }

    // Private channel: "br-<track>-g<no>" under the track category (if set)
    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    ];
    if (role) overwrites.push({ id: role.id, allow: [PermissionFlagsBits.ViewChannel] });
    try {
      const settings = await getSettings(guild.id).catch(() => null);
      for (const rid of (settings && settings.adminRoleIds) || []) {
        overwrites.push({ id: rid, allow: [PermissionFlagsBits.ViewChannel] });
      }
    } catch (e) {
      console.error('[scrimgroups] admin role overwrites failed:', e.message);
    }
    let channel = null;
    try {
      channel = await guild.channels.create({
        name: `br-${track.toLowerCase()}-g${groupNo}`,
        type: ChannelType.GuildText,
        parent: categoryEnvFor(track) || undefined,
        permissionOverwrites: overwrites,
        reason: `Scrim group ${track} G${groupNo}`,
      });
    } catch (e) {
      console.error('[scrimgroups] channel create failed:', e.message);
    }
    if (!channel) return ephemeralError(interaction, 'Could not create the group channel (permissions?).');

    // DB records
    let group = null;
    try {
      group = await prisma.scrimGroup.create({
        data: {
          groupNo,
          groupType: track,
          matchDate: idpAt1,
          channelId: channel.id,
          roleId: role ? role.id : null,
          categoryId: categoryEnvFor(track) || null,
          createdBy: interaction.user.id,
          status: 'OPEN',
          isOpen: true,
        },
      });
      await prisma.scrimSlot.createMany({
        data: Array.from({ length: SLOT_MAX - SLOT_MIN + 1 }, (_, i) => ({
          groupId: group.id,
          slotNo: SLOT_MIN + i,
          status: 'EMPTY',
        })),
      });
      await prisma.scrimMatch.create({
        data: { groupId: group.id, matchNo: 1, map: map1, idpAt: idpAt1, startAt: startAt1 },
      });
      await prisma.scrimMatch.create({
        data: { groupId: group.id, matchNo: 2, map: map2, idpAt: idpAt2, startAt: startAt2 },
      });
    } catch (e) {
      console.error('[scrimgroups] DB create failed:', e);
      await ephemeralError(interaction, 'Group channel was created but the database write failed. Please delete and retry.');
      return;
    }

    // Panels into the group channel
    try {
      const msg = await channel.send(groupPanel(group));
      const others = await prisma.scrimGroup.findMany({
        where: { groupType: track, status: 'OPEN', isOpen: true, id: { not: group.id } },
        orderBy: { groupNo: 'asc' },
        take: 25,
      });
      await channel.send(
        teamSelfServicePanel(
          group.id,
          others.map((o) => ({
            id: o.id,
            label: `${track} G${o.groupNo}`,
            description: o.matchDate ? o.matchDate.toISOString().slice(0, 10) : undefined,
          }))
        )
      );
      await prisma.scrimGroup.update({ where: { id: group.id }, data: { panelMsgId: msg.id } });
    } catch (e) {
      console.error('[scrimgroups] panel post failed:', e.message);
    }

    await audit('scrim_group_create', interaction.user.id, `${track} G${groupNo} created (channel ${channel.id})`);
    await interaction.reply({
      embeds: [
        successEmbed(
          `✅ Group created — **${track} G${groupNo}**\n<#${channel.id}>\n` +
            `🗺️ Match 1: ${map1} — IDP ${formatIST(idpAt1)} → start ${formatIST(startAt1)}\n` +
            `🗺️ Match 2: ${map2} — IDP ${formatIST(idpAt2)} → start ${formatIST(startAt2)}\n` +
            '21 slots (5–25) ready.'
        ),
      ],
      ephemeral: true,
    });
  } catch (e) {
    console.error('[scrimgroups] createScrimGroup failed:', e);
    await ephemeralError(interaction, 'Could not create the scrim group.');
  }
}

// ---------- Staff panel actions ----------

async function panelAction(interaction, action, groupId) {
  if (!(await requireAdmin(interaction))) return;
  const group = await getGroup(groupId);
  if (!group) return ephemeralError(interaction, 'Group not found.');

  if (action === 'remind') {
    try {
      const matches = await prisma.scrimMatch.findMany({
        where: { groupId: group.id },
        orderBy: { matchNo: 'asc' },
      });
      if (!matches.length) return ephemeralError(interaction, 'No matches on this group.');
      const now = Date.now();
      const next = matches.find((m) => m.idpAt && m.idpAt.getTime() > now) || matches[0];
      const embed = new EmbedBuilder()
        .setColor(0xf39c12)
        .setTitle(`🔔 Match Reminder — ${group.groupType} G${group.groupNo}`)
        .setDescription(
          `**Map:** ${next.map || 'TBD'}\n` +
            `**IDP time:** ${next.idpAt ? formatIST(next.idpAt) : 'TBD'}\n` +
            `**Match start:** ${next.startAt ? formatIST(next.startAt) : 'TBD'}\n\n` +
            'Be in the lobby on time. Slot waste = warning.'
        )
        .setFooter({ text: 'BLACK RAVEN ESPORTS' })
        .setTimestamp();
      const sent = await postToChannel(interaction.client, interaction.guild, group.channelId, {
        content: group.roleId ? `<@&${group.roleId}>` : undefined,
        embeds: [embed],
      });
      if (!sent) return ephemeralError(interaction, 'Could not post the reminder (channel missing?).');
      return interaction.reply({ embeds: [successEmbed('✅ Match reminder posted.')], ephemeral: true });
    } catch (e) {
      console.error('[scrimgroups] remind failed:', e);
      return ephemeralError(interaction, 'Could not post the reminder.');
    }
  }

  if (action === 'publish') {
    try {
      const sent = await postToChannel(interaction.client, interaction.guild, group.channelId, {
        content: group.roleId ? `<@&${group.roleId}> 📋 Slot list` : '📋 Slot list',
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setDescription(await renderSlotList(group.id))
            .setFooter({ text: 'BLACK RAVEN ESPORTS' })
            .setTimestamp(),
        ],
      });
      if (!sent) return ephemeralError(interaction, 'Could not publish the slot list.');
      return interaction.reply({ embeds: [successEmbed('✅ Slot list published.')], ephemeral: true });
    } catch (e) {
      console.error('[scrimgroups] publish failed:', e);
      return ephemeralError(interaction, 'Could not publish the slot list.');
    }
  }

  if (action === 'warn') {
    const modal = new ModalBuilder().setCustomId(`bs:warn:modal:${group.id}`).setTitle('Warn Team');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('w_slot')
          .setLabel('Slot number (5–25)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(2)
          .setPlaceholder('e.g. 12')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('w_reason')
          .setLabel('Warning reason')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(500)
          .setPlaceholder('e.g. Slot wasted — no show for match 1')
      )
    );
    return interaction.showModal(modal).catch(() => {});
  }

  if (action === 'remove') {
    const modal = new ModalBuilder().setCustomId(`bs:remove:modal:${group.id}`).setTitle('Remove Team');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('r_slot')
          .setLabel('Slot number (5–25)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(2)
          .setPlaceholder('e.g. 12')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('r_reason')
          .setLabel('Removal reason')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(500)
      )
    );
    return interaction.showModal(modal).catch(() => {});
  }

  if (action === 'qualify') {
    const modal = new ModalBuilder().setCustomId(`bs:qualify:modal:${group.id}`).setTitle('Publish Qualifier');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('q_slot')
          .setLabel('Winning slot number (0 = none)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(2)
          .setPlaceholder('e.g. 7 or 0')
      )
    );
    return interaction.showModal(modal).catch(() => {});
  }

  return ephemeralError(interaction, 'Unknown panel action.');
}

// ---------- Modal submits ----------

async function warnModalSubmit(interaction, groupId) {
  if (!(await requireAdmin(interaction))) return;
  try {
    const group = await getGroup(groupId);
    if (!group) return ephemeralError(interaction, 'Group not found.');
    const slotNo = parseInt(interaction.fields.getTextInputValue('w_slot'), 10);
    const reason = String(interaction.fields.getTextInputValue('w_reason') || '').trim();
    if (!slotRangeOk(slotNo)) return ephemeralError(interaction, 'Slot number must be between 5 and 25.');
    if (!reason) return ephemeralError(interaction, 'A reason is required.');

    const slot = await prisma.scrimSlot.findFirst({ where: { groupId: group.id, slotNo } });
    if (!slot || !slot.teamId) return ephemeralError(interaction, `Slot ${slotNo} is empty.`);
    const team = await prisma.team.findUnique({
      where: { id: slot.teamId },
      include: { owner: true },
    });
    const teamName = team ? team.name : slot.teamId;
    const ownerDiscordId = team && team.owner ? team.owner.discordId : null;

    const prev = await prisma.slotWarningCount.findUnique({ where: { teamId: slot.teamId } });
    const warningNo = (prev ? prev.count : 0) + 1;

    await prisma.slotWarningLog.create({
      data: {
        teamId: slot.teamId,
        groupId: group.id,
        slotNo,
        ownerDiscordId,
        staffId: interaction.user.id,
        warningNo,
        reason,
        action: 'WARNED',
      },
    });
    await prisma.slotWarningCount.upsert({
      where: { teamId: slot.teamId },
      create: { teamId: slot.teamId, count: 1 },
      update: { count: { increment: 1 } },
    });

    let autoBanned = false;
    if (warningNo >= MAX_WARNINGS) {
      autoBanned = true;
      const expiresAt = new Date(Date.now() + BAN_DAYS * 86400000);
      if (ownerDiscordId) {
        await prisma.scrimsBan.create({
          data: {
            discordId: ownerDiscordId,
            teamId: slot.teamId,
            reason: `Slot waste — ${warningNo} warnings in scrims (${reason})`,
            expiresAt,
            bannedBy: interaction.user.id,
            active: true,
          },
        });
      }
      await prisma.slotWarningLog.create({
        data: {
          teamId: slot.teamId,
          groupId: group.id,
          slotNo,
          ownerDiscordId,
          staffId: interaction.user.id,
          warningNo,
          reason: `Auto-ban: reached ${MAX_WARNINGS} slot-waste warnings`,
          action: 'AUTO_BANNED',
        },
      });
    }

    await audit(
      'scrim_warn',
      interaction.user.id,
      `${teamName} warned in ${group.groupType} G${group.groupNo} slot ${slotNo} (${warningNo}/${MAX_WARNINGS})${autoBanned ? ' — AUTO BANNED' : ''}: ${reason}`
    );

    const embed = new EmbedBuilder()
      .setColor(autoBanned ? 0xe74c3c : 0xf39c12)
      .setTitle(autoBanned ? '⛔ Team auto-banned (slot waste)' : '⚠️ Slot-waste warning')
      .setDescription(
        `**Team:** ${teamName}\n` +
          `**Group:** ${group.groupType} G${group.groupNo} — slot ${slotNo}\n` +
          `**Warning:** ${warningNo}/${MAX_WARNINGS}\n` +
          `**Reason:** ${reason}` +
          (autoBanned ? `\n**Ban:** ${BAN_DAYS} days (expires ${formatIST(new Date(Date.now() + BAN_DAYS * 86400000))})` : '')
      )
      .setFooter({ text: 'BLACK RAVEN ESPORTS' })
      .setTimestamp();
    await postToChannel(interaction.client, interaction.guild, warnChannelFor(group.groupType), { embeds: [embed] });

    return interaction.reply({
      embeds: [successEmbed(autoBanned
        ? `⛔ **${teamName}** reached ${warningNo}/${MAX_WARNINGS} warnings — auto-banned for ${BAN_DAYS} days.`
        : `⚠️ Warning ${warningNo}/${MAX_WARNINGS} recorded for **${teamName}** (slot ${slotNo}).`)],
      ephemeral: true,
    });
  } catch (e) {
    console.error('[scrimgroups] warn submit failed:', e);
    return ephemeralError(interaction, 'Could not record the warning.');
  }
}

async function removeModalSubmit(interaction, groupId) {
  if (!(await requireAdmin(interaction))) return;
  try {
    const group = await getGroup(groupId);
    if (!group) return ephemeralError(interaction, 'Group not found.');
    const slotNo = parseInt(interaction.fields.getTextInputValue('r_slot'), 10);
    const reason = String(interaction.fields.getTextInputValue('r_reason') || '').trim();
    if (!slotRangeOk(slotNo)) return ephemeralError(interaction, 'Slot number must be between 5 and 25.');
    if (!reason) return ephemeralError(interaction, 'A reason is required.');

    const reg = await prisma.scrimRegistration.findFirst({
      where: { groupId: group.id, slotNo, status: 'ACTIVE' },
    });
    if (!reg) return ephemeralError(interaction, `No active team on slot ${slotNo}.`);
    const team = await prisma.team.findUnique({
      where: { id: reg.teamId },
      include: { owner: true },
    });

    await prisma.$transaction([
      prisma.scrimSlot.updateMany({
        where: { groupId: group.id, slotNo },
        data: { status: 'EMPTY', teamId: null },
      }),
      prisma.scrimRegistration.update({
        where: { id: reg.id },
        data: { status: 'REMOVED' },
      }),
    ]);

    if (team && team.owner) {
      await setGroupRole(interaction, team.owner.discordId, group.roleId, false);
    }
    await audit(
      'scrim_remove',
      interaction.user.id,
      `${team ? team.name : reg.teamId} removed from ${group.groupType} G${group.groupNo} slot ${slotNo}: ${reason}`
    );
    notifyVacancySafe(group.id, interaction.client);
    return interaction.reply({
      embeds: [successEmbed(`🗑️ **${team ? team.name : reg.teamId}** removed from slot ${slotNo}.`)],
      ephemeral: true,
    });
  } catch (e) {
    console.error('[scrimgroups] remove submit failed:', e);
    return ephemeralError(interaction, 'Could not remove the team.');
  }
}

async function qualifyModalSubmit(interaction, groupId) {
  if (!(await requireAdmin(interaction))) return;
  try {
    const group = await getGroup(groupId);
    if (!group) return ephemeralError(interaction, 'Group not found.');
    if (group.status !== 'OPEN') return ephemeralError(interaction, 'This group is already closed.');

    const raw = String(interaction.fields.getTextInputValue('q_slot') || '').trim();
    const winSlot = parseInt(raw, 10);
    if (raw !== '0' && !slotRangeOk(winSlot)) {
      return ephemeralError(interaction, 'Enter a winning slot number (5–25) or 0 for none.');
    }

    let winner = null;
    if (winSlot !== 0) {
      const slot = await prisma.scrimSlot.findFirst({ where: { groupId: group.id, slotNo: winSlot } });
      if (!slot || !slot.teamId) return ephemeralError(interaction, `Slot ${winSlot} is empty.`);
      winner = await prisma.team.findUnique({ where: { id: slot.teamId }, include: { owner: true } });
    }

    await prisma.$transaction([
      prisma.scrimGroup.update({
        where: { id: group.id },
        data: { status: 'CLOSED', isOpen: false, resultPublishedAt: new Date() },
      }),
      prisma.scrimRegistration.updateMany({
        where: { groupId: group.id, status: 'ACTIVE' },
        data: { status: 'COMPLETED' },
      }),
    ]);

    if (winner) {
      const qRoleId = qualifiedRoleFor(group.groupType);
      if (qRoleId && winner.owner) {
        await setGroupRole(interaction, winner.owner.discordId, qRoleId, true);
      }
    }

    // Lock the group channel for the group role (read-only after results).
    try {
      const ch = await interaction.guild.channels.fetch(group.channelId).catch(() => null);
      if (ch && group.roleId) {
        await ch.permissionOverwrites.edit(group.roleId, { SendMessages: false }).catch(() => {});
      }
    } catch (e) {
      console.error('[scrimgroups] channel lock failed:', e.message);
    }

    const announce = winner
      ? `🏆 ${group.groupType} Group ${group.groupNo} — **${winner.name}** qualifies`
      : `🏆 ${group.groupType} Group ${group.groupNo} — no qualifier this time`;
    await postToChannel(interaction.client, interaction.guild, resultsChannelFor(group.groupType), {
      embeds: [
        new EmbedBuilder()
          .setColor(0xf1c40f)
          .setTitle(announce)
          .setFooter({ text: 'BLACK RAVEN ESPORTS' })
          .setTimestamp(),
      ],
    });

    await audit(
      'scrim_qualify',
      interaction.user.id,
      `${group.groupType} G${group.groupNo} closed; qualifier: ${winner ? winner.name : 'none'}`
    );
    return interaction.reply({ embeds: [successEmbed(`${announce}. Group locked.` )], ephemeral: true });
  } catch (e) {
    console.error('[scrimgroups] qualify submit failed:', e);
    return ephemeralError(interaction, 'Could not publish the qualifier.');
  }
}

// ---------- Team self-service ----------

async function teamCancelButton(interaction, groupId) {
  try {
    const found = await myScrimReg(groupId, interaction.user.id);
    if (!found) return ephemeralError(interaction, 'You have no active slot in this group.');
    if (await selfServiceLocked(groupId)) {
      return ephemeralError(interaction, 'Cancellations are locked — match starts in under 30 minutes.');
    }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`bs:team:cancel:yes:${groupId}`)
        .setLabel('Yes, cancel my slot')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('bs:team:cancel:no')
        .setLabel('Keep my slot')
        .setStyle(ButtonStyle.Secondary)
    );
    return interaction.reply({
      content: `Cancel your slot (#${found.reg.slotNo}, **${found.team.name}**)? This frees the slot for another team.`,
      components: [row],
      ephemeral: true,
    });
  } catch (e) {
    console.error('[scrimgroups] cancel button failed:', e);
    return ephemeralError(interaction, 'Could not start the cancellation.');
  }
}

async function teamCancelYes(interaction, groupId) {
  try {
    const group = await getGroup(groupId);
    if (!group) return ephemeralError(interaction, 'Group not found.');
    const found = await myScrimReg(groupId, interaction.user.id);
    if (!found) return ephemeralError(interaction, 'You have no active slot in this group.');
    if (await selfServiceLocked(groupId)) {
      return interaction.update({ content: '⛔ Cancellations are locked — match starts in under 30 minutes.', components: [] }).catch(() => {});
    }
    await prisma.$transaction([
      prisma.scrimSlot.updateMany({
        where: { groupId: group.id, slotNo: found.reg.slotNo },
        data: { status: 'EMPTY', teamId: null },
      }),
      prisma.scrimRegistration.update({
        where: { id: found.reg.id },
        data: { status: 'CANCELLED' },
      }),
    ]);
    await setGroupRole(interaction, interaction.user.id, group.roleId, false);
    await audit('scrim_cancel_self', interaction.user.id, `${found.team.name} self-cancelled slot ${found.reg.slotNo} in ${group.groupType} G${group.groupNo}`);
    notifyVacancySafe(group.id, interaction.client);
    return interaction.update({
      content: `✅ Slot #${found.reg.slotNo} cancelled for **${found.team.name}**.`,
      components: [],
    }).catch(() => {});
  } catch (e) {
    console.error('[scrimgroups] cancel yes failed:', e);
    return ephemeralError(interaction, 'Could not cancel the slot.');
  }
}

async function teamChangeSelect(interaction, groupId) {
  try {
    const toId = interaction.values && interaction.values[0];
    if (!toId || toId === 'none') {
      return ephemeralError(interaction, 'No other open groups right now — try again later.');
    }
    const group = await getGroup(groupId);
    const target = await prisma.scrimGroup.findFirst({
      where: { id: String(toId), status: 'OPEN', isOpen: true },
    });
    if (!group || !target) return ephemeralError(interaction, 'That group is no longer available.');
    if (group.id === target.id) return ephemeralError(interaction, 'You are already in that group.');
    const found = await myScrimReg(group.id, interaction.user.id);
    if (!found) return ephemeralError(interaction, 'You have no active slot in this group.');
    if ((await selfServiceLocked(group.id)) || (await selfServiceLocked(target.id))) {
      return ephemeralError(interaction, 'Group changes are locked — a match starts in under 30 minutes.');
    }
    const freeCount = await prisma.scrimSlot.count({ where: { groupId: target.id, status: 'EMPTY' } });
    if (!freeCount) return ephemeralError(interaction, `${target.groupType} G${target.groupNo} is full now.`);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`bs:team:change:yes:${group.id}:${target.id}`)
        .setLabel(`Move to ${target.groupType} G${target.groupNo}`)
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('bs:team:change:no')
        .setLabel('Stay here')
        .setStyle(ButtonStyle.Secondary)
    );
    return interaction.reply({
      content:
        `Move **${found.team.name}** from ${group.groupType} G${group.groupNo} (slot #${found.reg.slotNo}) ` +
        `to ${target.groupType} G${target.groupNo}? You'll take the lowest free slot there.`,
      components: [row],
      ephemeral: true,
    });
  } catch (e) {
    console.error('[scrimgroups] change select failed:', e);
    return ephemeralError(interaction, 'Could not start the group change.');
  }
}

async function teamChangeYes(interaction, fromId, toId) {
  try {
    const group = await getGroup(fromId);
    const target = await prisma.scrimGroup.findFirst({
      where: { id: String(toId), status: 'OPEN', isOpen: true },
    });
    if (!group || !target) return ephemeralError(interaction, 'A group is no longer available.');
    const found = await myScrimReg(group.id, interaction.user.id);
    if (!found) return ephemeralError(interaction, 'You have no active slot in this group.');
    if ((await selfServiceLocked(group.id)) || (await selfServiceLocked(target.id))) {
      return interaction.update({ content: '⛔ Group changes are locked — a match starts in under 30 minutes.', components: [] }).catch(() => {});
    }
    const free = await prisma.scrimSlot.findFirst({
      where: { groupId: target.id, status: 'EMPTY' },
      orderBy: { slotNo: 'asc' },
    });
    if (!free) {
      return interaction.update({ content: `⛔ ${target.groupType} G${target.groupNo} is full now.`, components: [] }).catch(() => {});
    }

    await prisma.$transaction([
      prisma.scrimSlot.updateMany({
        where: { groupId: group.id, slotNo: found.reg.slotNo },
        data: { status: 'EMPTY', teamId: null },
      }),
      prisma.scrimSlot.update({
        where: { id: free.id },
        data: { status: 'FILLED', teamId: found.team.id },
      }),
      prisma.scrimRegistration.update({
        where: { id: found.reg.id },
        data: { groupId: target.id, slotNo: free.slotNo },
      }),
    ]);

    await setGroupRole(interaction, interaction.user.id, group.roleId, false);
    await setGroupRole(interaction, interaction.user.id, target.roleId, true);

    await audit(
      'scrim_change_self',
      interaction.user.id,
      `${found.team.name} moved ${group.groupType} G${group.groupNo} (#${found.reg.slotNo}) → ${target.groupType} G${target.groupNo} (#${free.slotNo})`
    );
    notifyVacancySafe(group.id, interaction.client);
    return interaction.update({
      content: `✅ Moved to **${target.groupType} G${target.groupNo}** — slot #${free.slotNo}.`,
      components: [],
    }).catch(() => {});
  } catch (e) {
    console.error('[scrimgroups] change yes failed:', e);
    return ephemeralError(interaction, 'Could not complete the group change.');
  }
}

// ---------- Router ----------

async function handle(interaction) {
  try {
    const id = interaction.customId || '';
    if (!id.startsWith('bs:')) return false;

    // Staff group panel buttons: bs:panel:<action>:<groupId>
    let m = id.match(/^bs:panel:(remind|publish|warn|remove|qualify):(.+)$/);
    if (m && interaction.isButton()) {
      await panelAction(interaction, m[1], m[2]);
      return true;
    }

    // Modal submits
    m = id.match(/^bs:warn:modal:(.+)$/);
    if (m && interaction.isModalSubmit()) {
      await warnModalSubmit(interaction, m[1]);
      return true;
    }
    m = id.match(/^bs:remove:modal:(.+)$/);
    if (m && interaction.isModalSubmit()) {
      await removeModalSubmit(interaction, m[1]);
      return true;
    }
    m = id.match(/^bs:qualify:modal:(.+)$/);
    if (m && interaction.isModalSubmit()) {
      await qualifyModalSubmit(interaction, m[1]);
      return true;
    }

    // Team self-service: cancel
    if (id === 'bs:team:cancel:no' && interaction.isButton()) {
      await interaction.update({ content: 'Kept your slot — no changes made.', components: [] }).catch(() => {});
      return true;
    }
    m = id.match(/^bs:team:cancel:yes:(.+)$/);
    if (m && interaction.isButton()) {
      await teamCancelYes(interaction, m[1]);
      return true;
    }
    m = id.match(/^bs:team:cancel:(.+)$/);
    if (m && interaction.isButton()) {
      await teamCancelButton(interaction, m[1]);
      return true;
    }

    // Team self-service: change group
    if (id === 'bs:team:change:no' && interaction.isButton()) {
      await interaction.update({ content: 'Move cancelled — no changes made.', components: [] }).catch(() => {});
      return true;
    }
    m = id.match(/^bs:team:change:yes:(.+):(.+)$/);
    if (m && interaction.isButton()) {
      await teamChangeYes(interaction, m[1], m[2]);
      return true;
    }
    m = id.match(/^bs:team:change:(.+)$/);
    if (m && interaction.isStringSelectMenu()) {
      await teamChangeSelect(interaction, m[1]);
      return true;
    }

    return false;
  } catch (e) {
    console.error('[scrimgroups] handle failed:', e);
    return true;
  }
}

// ---------- Cleanup scheduler: delete channel+role 3h after results ----------

let cleanupTimer = null;

function startCleanupScheduler(client) {
  if (cleanupTimer) return cleanupTimer;
  const tick = async () => {
    try {
      const cutoff = new Date(Date.now() - CLEANUP_AFTER_MS);
      const groups = await prisma.scrimGroup.findMany({
        where: { status: 'CLOSED', cleanedAt: null, resultPublishedAt: { lte: cutoff } },
        take: 10,
      });
      for (const g of groups) {
        try {
          const ch = await client.channels.fetch(g.channelId).catch(() => null);
          const guild = (ch && ch.guild) || client.guilds.cache.first() || null;
          if (ch) {
            await ch.delete('IDP group auto cleanup after 3 hours').catch((e) =>
              console.error('[scrims-cleanup] channel delete failed:', e.message)
            );
          }
          if (g.roleId && guild) {
            const role = await guild.roles.fetch(g.roleId).catch(() => null);
            if (role) {
              await role.delete('IDP group role auto cleanup after 3 hours').catch((e) =>
                console.error('[scrims-cleanup] role delete failed:', e.message)
              );
            }
          }
          await prisma.scrimGroup.update({
            where: { id: g.id },
            data: { status: 'DELETED', cleanedAt: new Date() },
          });
          await audit('scrim_group_cleanup', 'system', `${g.groupType} G${g.groupNo} channel+role deleted (3h after results)`);
          console.log(`[scrims-cleanup] ${g.groupType} G${g.groupNo} cleaned.`);
        } catch (e) {
          console.error('[scrims-cleanup] group failed:', g.id, e.message);
        }
      }
    } catch (e) {
      console.error('[scrims-cleanup] tick failed:', e.message);
    }
  };
  tick().catch(() => {});
  cleanupTimer = setInterval(tick, 60000);
  if (cleanupTimer.unref) cleanupTimer.unref();
  return cleanupTimer;
}

module.exports = {
  handle,
  createScrimGroup,
  renderSlotList,
  startCleanupScheduler,
  saveSession,
  getSession,
  deleteSession,
  _test: { slotRangeOk, startAtFromIdp },
};
