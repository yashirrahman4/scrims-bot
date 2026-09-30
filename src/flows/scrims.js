/**
 * scrimport-1 — Agent V: scrims verification + registration flows (bs: namespace).
 *
 * Handles: bs:verify, bs:verify:edit, bs:verify:modal (+ :p1/:p2/:p3 player
 * pages), bs:verify:submit, bs:verify:cancel, bs:oq:register, bs:oq:reminder,
 * bs:t3:register, bs:t3:reminder, bs:reg:group:<track> (select),
 * bs:reg:confirm:<groupId>, bs:reg:cancel, bs:rem:group:<track> (select).
 *
 * Owns the ScrimFormSession helpers — other agents import
 * { saveSession, getSession, deleteSession } from this module.
 */
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder, MessageFlags} = require('discord.js');
const { prisma } = require('../db');
const {
  getOrCreateUser,
  getOwnedTeam,
  errorEmbed,
  successEmbed,
  formatIST,
  isValidUid,
  isValidIgn,
  audit,
} = require('../utils');

// ---------- config ----------

const maxActiveOq = () => Math.max(1, parseInt(process.env.MAX_ACTIVE_OQ || '2', 10) || 2);
const maxActiveT3 = () => Math.max(1, parseInt(process.env.MAX_ACTIVE_T3 || '2', 10) || 2);
const VERIFY_TTL_MIN = 30;
const REG_TTL_MIN = 15;

function fmtDateIST(date) {
  if (!date) return 'TBD';
  const ist = new Date(new Date(date).getTime() + 5.5 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(ist.getUTCDate())}-${p(ist.getUTCMonth() + 1)}-${ist.getUTCFullYear()}`;
}

// ---------- ScrimFormSession helpers (shared with other agents) ----------

async function saveSession(userDiscordId, flowType, payload, ttlMin = 30) {
  const expiresAt = new Date(Date.now() + Math.max(1, ttlMin) * 60000);
  await prisma.scrimFormSession.deleteMany({ where: { userDiscordId: String(userDiscordId), flowType } });
  return prisma.scrimFormSession.create({
    data: { userDiscordId: String(userDiscordId), flowType, payload: JSON.stringify(payload || {}), expiresAt },
  });
}

async function getSession(userDiscordId, flowType) {
  const s = await prisma.scrimFormSession.findFirst({
    where: { userDiscordId: String(userDiscordId), flowType },
    orderBy: { createdAt: 'desc' },
  });
  if (!s) return null;
  if (s.expiresAt && new Date(s.expiresAt) < new Date()) {
    await prisma.scrimFormSession.delete({ where: { id: s.id } }).catch(() => {});
    return null;
  }
  let payload = {};
  try {
    payload = JSON.parse(s.payload || '{}');
  } catch {
    payload = {};
  }
  return { ...s, payload };
}

async function deleteSession(userDiscordId, flowType) {
  await prisma.scrimFormSession.deleteMany({ where: { userDiscordId: String(userDiscordId), flowType } }).catch(() => {});
}

// ---------- pure helpers (exported for tests) ----------

/** Lowest free slot in 5..25, or null when the group is full. */
function lowestFreeSlot(slots) {
  const taken = new Set((slots || []).filter((s) => s.status !== 'EMPTY').map((s) => s.slotNo));
  for (let n = 5; n <= 25; n++) {
    if (!taken.has(n)) return n;
  }
  return null;
}

/** Registration closes 15 min before match-1 idpAt. True when still open. */
function registrationOpen(group, now = new Date()) {
  const matches = Array.isArray(group?.matches) ? group.matches : [];
  const m1 = matches.find((m) => m.matchNo === 1) || matches[0] || null;
  const idpAt = m1?.idpAt ? new Date(m1.idpAt) : null;
  if (!idpAt || Number.isNaN(idpAt.getTime())) return true;
  return new Date(now).getTime() < idpAt.getTime() - 15 * 60 * 1000;
}

/**
 * Build the 4+1 verification roster from the user's target-bot team.
 * First 4 non-SUB members (join order) are starters; the SUB member
 * (or 5th member) is player 5.
 */
function rosterFromTeam(team) {
  const members = (team?.members || []).filter((m) => m.player && m.player.ign && m.player.gameUid);
  const nonSub = members.filter((m) => m.role !== 'SUB');
  let sub = members.find((m) => m.role === 'SUB') || null;
  const starters = nonSub.slice(0, 4);
  if (!sub && nonSub.length > 4) sub = nonSub[4];
  const players = starters.map((m, i) => ({
    number: i + 1,
    ign: m.player.ign,
    uid: m.player.gameUid,
    discordId: m.player.discordId || null,
  }));
  if (sub) {
    players.push({ number: 5, ign: sub.player.ign, uid: sub.player.gameUid, discordId: sub.player.discordId || null });
  }
  return players;
}

// ---------- small discord helpers ----------

async function replyEph(interaction, payload) {
  const data = { ...payload, flags: MessageFlags.Ephemeral };
  try {
    if (interaction.deferred) return await interaction.editReply(data);
    if (interaction.replied) return await interaction.followUp(data);
    return await interaction.reply(data);
  } catch (err) {
    console.error('[scrims] reply failed:', err.message);
  }
}

const fail = (interaction, msg) => replyEph(interaction, { embeds: [errorEmbed(msg)] });

function safe(fn) {
  return async (interaction) => {
    try {
      await fn(interaction);
    } catch (err) {
      console.error('[scrims] handler error:', err);
      await fail(interaction, 'Something went wrong. Please try again.');
    }
  };
}

async function grantRoleSilent(guild, userId, roleId) {
  try {
    if (!guild || !roleId) return false;
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member || member.roles.cache.has(roleId)) return false;
    await member.roles.add(roleId);
    return true;
  } catch (err) {
    console.error('[scrims] grantRole failed:', err.message);
    return false;
  }
}

// ---------- verification embeds ----------

function playersBlock(players) {
  const get = (n) => (players || []).find((p) => Number(p.number) === n);
  const lines = [];
  for (let n = 1; n <= 4; n++) {
    const p = get(n);
    lines.push(`**PLAYER ${n}**${p?.discordId ? ` — <@${p.discordId}>` : ''}`);
    lines.push(`IGN :- ${p?.ign || 'Not saved'}`);
    lines.push(`UID :- ${p?.uid || 'Not saved'}`);
    lines.push('');
  }
  const p5 = get(5);
  lines.push('**SUBSTITUTE**');
  if (p5) {
    lines.push(`**PLAYER 5**${p5.discordId ? ` — <@${p5.discordId}>` : ''}`);
    lines.push(`IGN :- ${p5.ign || 'Not saved'}`);
    lines.push(`UID :- ${p5.uid || 'Not saved'}`);
  } else {
    lines.push('NO SUBSTITUTE SELECTED');
  }
  return lines.join('\n');
}

function reviewEmbed({ userId, basic, players, title }) {
  return new EmbedBuilder()
    .setColor(0x22c55e)
    .setTitle(title || `✅ Review — ${basic.teamName || 'Your Team'}`)
    .setDescription(
      [
        `👑 **OWNER**`,
        `<@${userId}>`,
        '',
        '━━━━━━━━━━━━',
        '',
        '🏆 **TEAM NAME**',
        basic.teamName || 'Not saved',
        '',
        '**OWNER FULL NAME**',
        basic.ownerFullName || 'Not saved',
        '',
        '**WHATSAPP NUMBER**',
        basic.whatsappNumber || 'Not saved',
        '',
        '**OWNER MAIL ADDRESS**',
        basic.ownerEmail || 'Not saved',
        '',
        '**CITY**',
        basic.city || 'Not saved',
        '',
        '━━━━━━━━━━━━',
        '',
        '🎮 **PLAYERS**',
        playersBlock(players),
      ].join('\n')
    )
    .setFooter({ text: process.env.SCRIMS_SERVER_NAME || process.env.SERVER_NAME || 'BLACK RAVEN ESPORTS' })
    .setTimestamp();
}

function reviewButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('bs:verify:submit').setLabel('Confirm & Submit').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('bs:verify:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    ),
  ];
}

// ---------- verification modals ----------

function textInput(id, label, { placeholder = '', required = true, maxLength = 100, value = '' } = {}) {
  const t = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(TextInputStyle.Short)
    .setRequired(required)
    .setMaxLength(maxLength);
  if (placeholder) t.setPlaceholder(placeholder);
  if (value) t.setValue(String(value).slice(0, maxLength));
  return new ActionRowBuilder().addComponents(t);
}

function basicModal(prefill = {}) {
  return new ModalBuilder()
    .setCustomId('bs:verify:modal')
    .setTitle('Scrims Verification — Team Details')
    .addComponents(
      textInput('team_name', 'TEAM NAME', { placeholder: 'e.g. BLACK RAVEN ESPORTS', value: prefill.teamName }),
      textInput('owner_full_name', 'OWNER FULL NAME', { placeholder: 'e.g. YASHIR RAHMAN', value: prefill.ownerFullName }),
      textInput('whatsapp_number', 'WHATSAPP NUMBER', { placeholder: 'e.g. 91373773XX', maxLength: 20, value: prefill.whatsappNumber }),
      textInput('owner_email', 'OWNER GMAIL ADDRESS', { placeholder: 'e.g. example@gmail.com', maxLength: 150, value: prefill.ownerEmail }),
      textInput('city', 'CITY', { placeholder: 'e.g. New Delhi', value: prefill.city })
    );
}

function playersModalPage(page, prefill = {}) {
  const g = (k) => prefill[k] || '';
  if (page === 1) {
    return new ModalBuilder()
      .setCustomId('bs:verify:modal:p1')
      .setTitle('Players Details — Page 1')
      .addComponents(
        textInput('p1_ign', 'PLAYER 1 IGN', { value: g('p1_ign') }),
        textInput('p1_uid', 'PLAYER 1 UID', { maxLength: 20, value: g('p1_uid') }),
        textInput('p2_ign', 'PLAYER 2 IGN', { value: g('p2_ign') }),
        textInput('p2_uid', 'PLAYER 2 UID', { maxLength: 20, value: g('p2_uid') })
      );
  }
  if (page === 2) {
    return new ModalBuilder()
      .setCustomId('bs:verify:modal:p2')
      .setTitle('Players Details — Page 2')
      .addComponents(
        textInput('p3_ign', 'PLAYER 3 IGN', { value: g('p3_ign') }),
        textInput('p3_uid', 'PLAYER 3 UID', { maxLength: 20, value: g('p3_uid') }),
        textInput('p4_ign', 'PLAYER 4 IGN', { value: g('p4_ign') }),
        textInput('p4_uid', 'PLAYER 4 UID', { maxLength: 20, value: g('p4_uid') })
      );
  }
  return new ModalBuilder()
    .setCustomId('bs:verify:modal:p3')
    .setTitle('Substitute Details (Optional)')
    .addComponents(
      textInput('p5_ign', 'PLAYER 5 IGN', { required: false, placeholder: 'Leave blank if no substitute', value: g('p5_ign') }),
      textInput('p5_uid', 'PLAYER 5 UID', { required: false, maxLength: 20, placeholder: 'Leave blank if no substitute', value: g('p5_uid') })
    );
}

// ---------- verification handlers ----------

async function loadVerification(userId) {
  return prisma.scrimsVerification.findUnique({ where: { ownerDiscordId: String(userId) } }).catch(() => null);
}

/**
 * Scrims verification is satisfied by ANY of:
 *  - a verified scrimsVerification row (the scrims verify panel), or
 *  - the SCRIMS_VERIFIED_ROLE_ID role, or
 *  - owning an ACTIVE team from the main team-verification system.
 * This is what connects the team verification data to OQ/T3 registration:
 * a team-verified owner never has to verify twice.
 */
function isVerifiedForScrims({ scrimsVerified, hasVerifiedRole, team }) {
  if (scrimsVerified || hasVerifiedRole) return true;
  return !!(team && team.status === 'ACTIVE');
}

/**
 * Derive a scrims profile from the user's verified team (name + roster) when
 * they don't have one yet. Keeps staff-facing screens that read
 * scrimsVerification accurate without asking the user to type everything
 * again. Never throws; returns the row or null.
 */
async function linkTeamVerification(discordId, guild) {
  try {
    const existing = await loadVerification(discordId);
    if (existing) return existing;
    const dbUser = await prisma.user.findUnique({ where: { discordId: String(discordId) } }).catch(() => null);
    if (!dbUser) return null;
    const team = await getOwnedTeam(dbUser.id).catch(() => null);
    if (!team || team.status !== 'ACTIVE') return null;
    const players = rosterFromTeam(team);
    const row = await prisma.scrimsVerification.create({
      data: {
        ownerDiscordId: String(discordId),
        teamName: team.name,
        playersJson: JSON.stringify(players),
        status: 'verified',
        verifiedAt: new Date(),
      },
    }).catch(() => null);
    if (row && guild) await grantRoleSilent(guild, String(discordId), process.env.SCRIMS_VERIFIED_ROLE_ID);
    return row;
  } catch (e) {
    console.error('[scrims] linkTeamVerification failed:', e.message);
    return null;
  }
}

function parsePlayersJson(row) {
  try {
    const v = JSON.parse(row?.playersJson || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

async function onVerify(interaction) {
  // Team-verification connection: an ACTIVE verified team counts — derive the
  // scrims profile from it instead of making the owner verify twice.
  const linked = await linkTeamVerification(interaction.user.id, interaction.guild);
  const row = linked || (await loadVerification(interaction.user.id));
  if (row && row.status === 'verified') {
    const players = parsePlayersJson(row);
    await replyEph(interaction, {
      embeds: [
        reviewEmbed({
          userId: interaction.user.id,
          basic: {
            teamName: row.teamName,
            ownerFullName: row.ownerFullName,
            whatsappNumber: row.whatsappNumber,
            ownerEmail: row.ownerEmail,
            city: row.city,
          },
          players,
          title: `✅ Already Verified — ${row.teamName || 'Your Team'}`,
        }),
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('bs:verify:edit').setLabel('Edit Registered Team').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('bs:verify:cancel').setLabel('Discard & Redo').setStyle(ButtonStyle.Danger)
        ),
      ],
    });
    return;
  }
  await interaction.showModal(basicModal());
}

async function onVerifyEdit(interaction) {
  const row = await loadVerification(interaction.user.id);
  const players = row ? parsePlayersJson(row) : [];
  const prefillPlayers = {};
  for (const p of players) {
    prefillPlayers[`p${p.number}_ign`] = p.ign || '';
    prefillPlayers[`p${p.number}_uid`] = p.uid || '';
  }
  await saveSession(
    interaction.user.id,
    'bs_verify',
    {
      basic: row
        ? {
            teamName: row.teamName || '',
            ownerFullName: row.ownerFullName || '',
            whatsappNumber: row.whatsappNumber || '',
            ownerEmail: row.ownerEmail || '',
            city: row.city || '',
          }
        : {},
      existingPlayers: players,
      prefillPlayers,
      editing: true,
    },
    VERIFY_TTL_MIN
  );
  await interaction.showModal(
    basicModal(
      row
        ? {
            teamName: row.teamName || '',
            ownerFullName: row.ownerFullName || '',
            whatsappNumber: row.whatsappNumber || '',
            ownerEmail: row.ownerEmail || '',
            city: row.city || '',
          }
        : {}
    )
  );
}

/** After the basic modal: try the user's target-bot team roster; else player modals. */
async function continueAfterBasic(interaction, session) {
  const payload = session?.payload || {};
  const basic = payload.basic || {};
  let players = [];
  try {
    const dbUser = await getOrCreateUser(interaction.user);
    const team = await getOwnedTeam(dbUser.id);
    players = rosterFromTeam(team);
  } catch (err) {
    console.error('[scrims] roster lookup failed:', err.message);
  }
  if (players.length >= 4) {
    await saveSession(interaction.user.id, 'bs_verify', { ...payload, basic, players }, VERIFY_TTL_MIN);
    await replyEph(interaction, {
      content: 'We found your team roster below. Confirm to submit, or cancel.',
      embeds: [reviewEmbed({ userId: interaction.user.id, basic, players })],
      components: reviewButtons(),
    });
    return;
  }
  // Manual player entry.
  await saveSession(interaction.user.id, 'bs_verify', { ...payload, basic, players: [], partial: {} }, VERIFY_TTL_MIN);
  await interaction.showModal(playersModalPage(1, payload.prefillPlayers || {}));
}

async function onVerifyModalSubmit(interaction) {
  const f = interaction.fields;
  const basic = {
    teamName: f.getTextInputValue('team_name').trim(),
    ownerFullName: f.getTextInputValue('owner_full_name').trim(),
    whatsappNumber: f.getTextInputValue('whatsapp_number').trim(),
    ownerEmail: f.getTextInputValue('owner_email').trim(),
    city: f.getTextInputValue('city').trim(),
  };
  if (!basic.teamName) return fail(interaction, 'Team name is required.');
  const session = await getSession(interaction.user.id, 'bs_verify');
  await continueAfterBasic(interaction, { payload: { ...(session?.payload || {}), basic } });
}

function readPlayerPair(f, n) {
  return { ign: (f.getTextInputValue(`p${n}_ign`) || '').trim(), uid: (f.getTextInputValue(`p${n}_uid`) || '').trim() };
}

function validatePlayers(pairs, requireAll = true) {
  const problems = [];
  pairs.forEach(({ ign, uid }, i) => {
    const n = i + 1;
    if (!requireAll && !ign && !uid) return; // optional slot left blank
    if (!isValidIgn(ign)) problems.push(`Player ${n}: IGN must be 3–16 chars (letters, numbers, space, _).`);
    if (!isValidUid(uid)) problems.push(`Player ${n}: UID must be 5–12 digits.`);
  });
  return problems;
}

async function onVerifyPlayersModalSubmit(interaction) {
  const userId = interaction.user.id;
  const page = interaction.customId.endsWith(':p1') ? 1 : interaction.customId.endsWith(':p2') ? 2 : 3;
  const session = await getSession(userId, 'bs_verify');
  if (!session) return fail(interaction, 'Your verification draft expired. Please start again from the panel.');

  const payload = session.payload || {};
  const partial = { ...(payload.partial || {}) };
  const f = interaction.fields;

  if (page === 1) {
    const pairs = [readPlayerPair(f, 1), readPlayerPair(f, 2)];
    const problems = validatePlayers(pairs, true);
    if (problems.length) return fail(interaction, problems.join('\n'));
    pairs.forEach((p, i) => {
      partial[`p${i + 1}_ign`] = p.ign;
      partial[`p${i + 1}_uid`] = p.uid;
    });
    await saveSession(userId, 'bs_verify', { ...payload, partial }, VERIFY_TTL_MIN);
    await interaction.showModal(playersModalPage(2, payload.prefillPlayers || {}));
    return;
  }
  if (page === 2) {
    const pairs = [readPlayerPair(f, 3), readPlayerPair(f, 4)];
    const problems = validatePlayers(pairs, true);
    if (problems.length) return fail(interaction, problems.join('\n'));
    pairs.forEach((p, i) => {
      partial[`p${i + 3}_ign`] = p.ign;
      partial[`p${i + 3}_uid`] = p.uid;
    });
    await saveSession(userId, 'bs_verify', { ...payload, partial }, VERIFY_TTL_MIN);
    await interaction.showModal(playersModalPage(3, payload.prefillPlayers || {}));
    return;
  }
  // page 3: optional substitute
  const sub = readPlayerPair(f, 5);
  const problems = validatePlayers([sub], false);
  if (problems.length) return fail(interaction, problems.join('\n'));

  const players = [1, 2, 3, 4].map((n) => ({
    number: n,
    ign: partial[`p${n}_ign`],
    uid: partial[`p${n}_uid`],
    discordId: null,
  }));
  if (sub.ign || sub.uid) players.push({ number: 5, ign: sub.ign, uid: sub.uid, discordId: null });

  await saveSession(userId, 'bs_verify', { ...payload, players, partial: {} }, VERIFY_TTL_MIN);
  await replyEph(interaction, {
    content: 'Review your details, then confirm to submit.',
    embeds: [reviewEmbed({ userId, basic: payload.basic || {}, players })],
    components: reviewButtons(),
  });
}

async function onVerifySubmit(interaction) {
  const userId = interaction.user.id;
  const session = await getSession(userId, 'bs_verify');
  if (!session?.payload?.basic?.teamName) {
    return fail(interaction, 'Your verification draft expired. Please start again from the panel.');
  }
  const { basic, players } = session.payload;
  if (!Array.isArray(players) || players.length < 4) {
    return fail(interaction, 'You need at least 4 players to verify. Please start again.');
  }

  const row = await prisma.scrimsVerification.upsert({
    where: { ownerDiscordId: String(userId) },
    update: {
      teamName: basic.teamName,
      ownerFullName: basic.ownerFullName || null,
      whatsappNumber: basic.whatsappNumber || null,
      ownerEmail: basic.ownerEmail || null,
      city: basic.city || null,
      playersJson: JSON.stringify(players),
      status: 'verified',
      verifiedAt: new Date(),
    },
    create: {
      ownerDiscordId: String(userId),
      teamName: basic.teamName,
      ownerFullName: basic.ownerFullName || null,
      whatsappNumber: basic.whatsappNumber || null,
      ownerEmail: basic.ownerEmail || null,
      city: basic.city || null,
      playersJson: JSON.stringify(players),
      status: 'verified',
      verifiedAt: new Date(),
    },
  });

  // Grant the verified role (skip quietly when unset).
  await grantRoleSilent(interaction.guild, userId, process.env.SCRIMS_VERIFIED_ROLE_ID);

  // Post the verification embed to the verify channel (skip quietly when unset).
  try {
    const channelId = process.env.SCRIMS_VERIFY_CHANNEL_ID;
    if (channelId && interaction.client) {
      const ch = await interaction.client.channels.fetch(channelId).catch(() => null);
      if (ch && ch.isTextBased()) {
        const msg = await ch.send({
          embeds: [reviewEmbed({ userId, basic, players, title: `✅ Scrims Verification Submitted — ${basic.teamName}` })],
        });
        await prisma.scrimsVerification.update({ where: { id: row.id }, data: { messageId: msg.id } }).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[scrims] verify-channel post failed:', err.message);
  }

  await audit('SCRIMS_VERIFY', userId, `team=${basic.teamName} players=${players.length}`);
  await deleteSession(userId, 'bs_verify');

  await replyEph(interaction, {
    embeds: [
      successEmbed(
        `**${basic.teamName}** is now **Scrims Verified** ✅\nThis profile is reused for both **OQ** and **T3** — no need to verify again.`
      ),
    ],
  });
}

async function onVerifyCancel(interaction) {
  const userId = interaction.user.id;
  const session = await getSession(userId, 'bs_verify');
  if (session) {
    await deleteSession(userId, 'bs_verify');
    await audit('SCRIMS_VERIFY_CANCEL', userId, 'draft discarded');
    await replyEph(interaction, {
      embeds: [successEmbed('Discarded. Press **Register Team** on the panel to start over.')],
    });
    return;
  }
  // No draft in progress — discarding the SAVED profile is destructive, so confirm.
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('bs:verify:cancel:yes').setLabel('Yes, discard it').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('bs:verify:cancel:no').setLabel('Keep it').setStyle(ButtonStyle.Secondary)
  );
  await replyEph(interaction, {
    embeds: [
      new EmbedBuilder()
        .setColor(0xf39c12)
        .setTitle('⚠️ Discard saved verification profile?')
        .setDescription('This permanently deletes your saved verification profile. You will need to verify again before registering.'),
    ],
    components: [row],
  });
}

async function onVerifyCancelYes(interaction) {
  const userId = interaction.user.id;
  await prisma.scrimsVerification.delete({ where: { ownerDiscordId: String(userId) } }).catch(() => {});
  await audit('SCRIMS_VERIFY_CANCEL', userId, 'saved profile discarded (confirmed)');
  await replyEph(interaction, {
    embeds: [successEmbed('Discarded. Press **Register Team** on the panel to start over.')],
    components: [],
  });
}

async function onVerifyCancelNo(interaction) {
  await replyEph(interaction, {
    embeds: [successEmbed('Kept your saved verification profile.')],
    components: [],
  });
}

// ---------- registration ----------

/** Shared guards. Returns { team } or { problem }. */
async function guardCheck(interaction, track) {
  const userId = interaction.user.id;

  // (c) owns a team — checked first, because an ACTIVE verified team also
  // satisfies the scrims-verification requirement (no double verification).
  let team = null;
  try {
    const dbUser = await getOrCreateUser(interaction.user);
    team = await getOwnedTeam(dbUser.id);
  } catch {}
  if (!team) {
    return { problem: 'You need a registered team to join scrims. Register a team from the team panel first.' };
  }
  // A suspended team is found but must stay blocked — say so plainly instead
  // of blaming scrims verification.
  if (team.status === 'SUSPENDED') {
    return { problem: 'Your team is currently **suspended**. Contact staff to reactivate it before registering for scrims.' };
  }

  // (a) verified: scrims row, verified role, or ACTIVE team from team verification.
  let scrimsVerified = false;
  try {
    const v = await prisma.scrimsVerification.findUnique({ where: { ownerDiscordId: String(userId) } });
    scrimsVerified = !!(v && v.status === 'verified');
  } catch {}
  const roleId = process.env.SCRIMS_VERIFIED_ROLE_ID;
  const hasVerifiedRole = !!(roleId && interaction.member?.roles?.cache?.has(roleId));
  if (!isVerifiedForScrims({ scrimsVerified, hasVerifiedRole, team })) {
    return { problem: 'Please complete **Scrims Verification** first — use the verification panel, then come back here.' };
  }

  // (b) active ban
  try {
    const ban = await prisma.scrimsBan.findFirst({ where: { discordId: String(userId), active: true } });
    if (ban && (!ban.expiresAt || new Date(ban.expiresAt) > new Date())) {
      return { problem: `You are banned from scrims${ban.reason ? `: ${ban.reason}` : '.'} Contact staff.` };
    }
  } catch {}

  // (d) T3 role (only when configured)
  if (track === 'T3') {
    const t3Role = process.env.SCRIMS_T3_ROLE_ID;
    if (t3Role && !interaction.member?.roles?.cache?.has(t3Role)) {
      return { problem: 'T3 registration requires the T3 role. Ask staff if you should have it.' };
    }
  }

  // (e) active registration cap per team+track
  const max = track === 'T3' ? maxActiveT3() : maxActiveOq();
  let count = 0;
  try {
    count = await prisma.scrimRegistration.count({
      where: { teamId: team.id, registrationType: track, status: 'ACTIVE' },
    });
  } catch {}
  if (count >= max) {
    return { problem: `Your team already has ${max} active ${track} registration${max > 1 ? 's' : ''} (max allowed).` };
  }

  return { team };
}

async function openGroupsFor(track) {
  let groups = [];
  try {
    groups = await prisma.scrimGroup.findMany({
      where: { groupType: track, status: 'OPEN', isOpen: true },
      include: { slots: true, matches: { orderBy: { matchNo: 'asc' } } },
      orderBy: { groupNo: 'asc' },
    });
  } catch (err) {
    console.error('[scrims] openGroupsFor failed:', err.message);
    return [];
  }
  return groups.filter((g) => registrationOpen(g));
}

function groupOption(g) {
  const filled = (g.slots || []).filter((s) => s.status === 'FILLED').length;
  const matches = g.matches || [];
  const m1 = matches.find((m) => m.matchNo === 1) || matches[0];
  return {
    label: `Group ${g.groupNo} — ${filled}/21 — ${fmtDateIST(g.matchDate || m1?.idpAt)}`.slice(0, 100),
    value: g.id,
    description: m1?.idpAt ? `IDP ${formatIST(m1.idpAt)}`.slice(0, 100) : 'IDP time TBD',
  };
}

function trackColor(track) {
  return track === 'T3' ? 0x3b82f6 : 0xffa500;
}

async function onTrackRegister(interaction, track) {
  const g = await guardCheck(interaction, track);
  if (g.problem) return fail(interaction, g.problem);

  const groups = await openGroupsFor(track);
  if (!groups.length) {
    return fail(interaction, `No open ${track} groups right now. Check back later.`);
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`bs:reg:group:${track}`)
    .setPlaceholder('Choose a group…')
    .addOptions(groups.slice(0, 25).map(groupOption));

  await replyEph(interaction, {
    embeds: [
      new EmbedBuilder()
        .setColor(trackColor(track))
        .setTitle(`${track} Registration — Pick a Group`)
        .setDescription(
          `**Team:** ${g.team.name}\nRegistration closes 15 minutes before match 1 IDP.\nPick a group from the dropdown below.`
        ),
    ],
    components: [new ActionRowBuilder().addComponents(select)],
  });
}

async function onRegGroupSelect(interaction, track) {
  const groupId = interaction.values?.[0];
  if (!groupId) return fail(interaction, 'No group selected.');

  const g = await guardCheck(interaction, track);
  if (g.problem) return fail(interaction, g.problem);
  const team = g.team;

  const group = await prisma.scrimGroup
    .findUnique({ where: { id: groupId }, include: { slots: true, matches: { orderBy: { matchNo: 'asc' } } } })
    .catch(() => null);
  if (!group || group.groupType !== track || group.status !== 'OPEN' || !group.isOpen) {
    return fail(interaction, 'That group is no longer open.');
  }
  if (!registrationOpen(group)) {
    return fail(interaction, 'Registration closed for this group (15 minutes before IDP).');
  }
  const dup = await prisma.scrimRegistration
    .findFirst({ where: { teamId: team.id, groupId, status: 'ACTIVE' } })
    .catch(() => null);
  if (dup) return fail(interaction, `Your team is already registered in Group ${group.groupNo} (slot #${dup.slotNo}).`);

  const slotNo = lowestFreeSlot(group.slots);
  if (!slotNo) return fail(interaction, 'This group just filled up — pick another group.');

  await saveSession(interaction.user.id, 'bs_reg', { teamId: team.id, groupId, slotNo, track }, REG_TTL_MIN);

  await replyEph(interaction, {
    embeds: [
      new EmbedBuilder()
        .setColor(trackColor(track))
        .setTitle(`${track} Registration — Confirm`)
        .setDescription(
          [
            `**Team:** ${team.name}`,
            `**Group:** Group ${group.groupNo}`,
            `**Slot:** #${slotNo}`,
            '',
            'Confirm to lock this slot. You cannot undo this yourself — contact staff if you need changes.',
          ].join('\n')
        ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`bs:reg:confirm:${groupId}`).setLabel('Confirm Registration').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('bs:reg:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
      ),
    ],
  });
}

const REG_ERRORS = {
  GROUP_CLOSED: 'That group is no longer open.',
  REG_CLOSED: 'Registration closed for this group (15 minutes before IDP).',
  NOT_VERIFIED: 'Please complete **Scrims Verification** first.',
  TEAM_SUSPENDED: 'Your team is currently **suspended**. Contact staff to reactivate it.',
  BANNED: 'You are banned from scrims. Contact staff.',
  NO_TEAM: 'You no longer own a team.',
  NO_T3_ROLE: 'T3 registration requires the T3 role.',
  CAP: 'Your team reached the max active registrations for this track.',
  DUP: 'Your team is already registered in this group.',
  FULL: 'This group just filled up — pick another group.',
};

async function onRegConfirm(interaction) {
  const userId = interaction.user.id;
  const groupId = interaction.customId.split(':').slice(3).join(':');
  if (!groupId) return fail(interaction, 'Invalid group.');

  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      const group = await tx.scrimGroup.findUnique({
        where: { id: groupId },
        include: { slots: true, matches: { orderBy: { matchNo: 'asc' } } },
      });
      if (!group || group.groupType == null || group.status !== 'OPEN' || !group.isOpen) throw new Error('GROUP_CLOSED');
      if (!registrationOpen(group)) throw new Error('REG_CLOSED');

      const ban = await tx.scrimsBan.findFirst({ where: { discordId: String(userId), active: true } });
      if (ban && (!ban.expiresAt || new Date(ban.expiresAt) > new Date())) throw new Error('BANNED');

      const v = await tx.scrimsVerification.findUnique({ where: { ownerDiscordId: String(userId) } });
      const scrimsVerified = !!(v && v.status === 'verified');

      const dbUser = await tx.user.findUnique({ where: { discordId: String(userId) } });
      const team = dbUser
        ? await tx.team.findFirst({
            where: { ownerId: dbUser.id, status: { in: ['ACTIVE', 'SUSPENDED'] } },
          })
        : null;
      if (!team) throw new Error('NO_TEAM');
      if (team.status === 'SUSPENDED') throw new Error('TEAM_SUSPENDED');
      // Team-verification connection: an ACTIVE team from the main team
      // verification satisfies the scrims-verification requirement.
      if (!isVerifiedForScrims({ scrimsVerified, hasVerifiedRole: false, team })) throw new Error('NOT_VERIFIED');

      const track = group.groupType;
      const t3Role = process.env.SCRIMS_T3_ROLE_ID;
      if (track === 'T3' && t3Role && !interaction.member?.roles?.cache?.has(t3Role)) throw new Error('NO_T3_ROLE');

      const max = track === 'T3' ? maxActiveT3() : maxActiveOq();
      const count = await tx.scrimRegistration.count({
        where: { teamId: team.id, registrationType: track, status: 'ACTIVE' },
      });
      if (count >= max) throw new Error('CAP');

      const dup = await tx.scrimRegistration.findFirst({ where: { teamId: team.id, groupId, status: 'ACTIVE' } });
      if (dup) throw new Error('DUP');

      // Row-lock the group's slots so concurrent confirms serialize: the
      // second transaction blocks here until the first commits, then sees the
      // taken slot (and the committed confirmation serial). Postgres-only.
      await tx.$queryRaw`SELECT "id" FROM "ScrimSlot" WHERE "groupId" = ${groupId} FOR UPDATE`;
      const lockedSlots = await tx.scrimSlot.findMany({ where: { groupId } });
      const free = lowestFreeSlot(lockedSlots);
      if (!free) throw new Error('FULL');

      await tx.scrimSlot.update({
        where: { groupId_slotNo: { groupId, slotNo: free } },
        data: { status: 'FILLED', teamId: team.id },
      });

      const reg = await tx.scrimRegistration.create({
        data: {
          teamId: team.id,
          groupId,
          slotNo: free,
          registrationType: track,
          status: 'ACTIVE',
          registeredBy: String(userId),
        },
      });

      const serial = (await tx.scrimConfirmationPost.count({ where: { groupId } })) + 1;
      const post = await tx.scrimConfirmationPost.create({
        data: { groupId, teamId: team.id, slotNo: free, serial },
      });

      return { group, team, slotNo: free, track, serial, regId: reg.id, postId: post.id };
    });
  } catch (err) {
    const msg = REG_ERRORS[err.message] || 'Registration failed. Please try again.';
    return fail(interaction, msg);
  }

  // Post-transaction: group role + audit + cleanup.
  if (result.group.roleId) {
    const ok = await grantRoleSilent(interaction.guild, userId, result.group.roleId);
    if (!ok) console.error(`[scrims] could not grant group role ${result.group.roleId} to ${userId}`);
  }
  await audit(
    'SCRIMS_REG',
    userId,
    `${result.track} team=${result.team.name} group=${result.group.groupNo} slot=${result.slotNo}`
  );

  // Connect the team-verification data: derive the scrims profile from the
  // verified team when the owner registered via their team (no double entry).
  await linkTeamVerification(userId, interaction.guild);

  // Numbered confirmation post (source parity): post to the track's
  // confirmation channel when configured, and record the messageId.
  // Degrades silently when the channel var is unset.
  const confirmChannelId = result.track === 'T3'
    ? process.env.SCRIMS_T3_CONFIRM_CHANNEL_ID
    : process.env.SCRIMS_OQ_CONFIRM_CHANNEL_ID;
  if (confirmChannelId) {
    try {
      const ch = await interaction.client.channels.fetch(String(confirmChannelId)).catch(() => null);
      if (ch && ch.isTextBased()) {
        const msg = await ch.send({
          embeds: [
            new EmbedBuilder()
              .setColor(trackColor(result.track))
              .setTitle(`#${result.serial} ✅ ${result.team.name} — registered`)
              .setDescription(
                `**Track:** ${result.track}\n**Group:** Group ${result.group.groupNo}\n**Slot:** #${result.slotNo}`
              )
              .setFooter({ text: process.env.SCRIMS_SERVER_NAME || process.env.SERVER_NAME || 'BLACK RAVEN ESPORTS' })
              .setTimestamp(),
          ],
        });
        await prisma.scrimConfirmationPost
          .update({ where: { id: result.postId }, data: { messageId: msg.id } })
          .catch(() => {});
      }
    } catch (err) {
      console.error('[scrims] confirmation post failed:', err.message);
    }
  }

  await deleteSession(userId, 'bs_reg');

  await replyEph(interaction, {
    embeds: [
      new EmbedBuilder()
        .setColor(trackColor(result.track))
        .setTitle(`✅ Registered — ${result.track} Group ${result.group.groupNo}`)
        .setDescription(
          [
            `**Team:** ${result.team.name}`,
            `**Group:** Group ${result.group.groupNo}`,
            `**Slot:** #${result.slotNo}`,
            '',
            'Room ID/password will be shared in your group channel before the match. Good luck! 🍀',
          ].join('\n')
        )
        .setFooter({ text: process.env.SCRIMS_SERVER_NAME || process.env.SERVER_NAME || 'BLACK RAVEN ESPORTS' })
        .setTimestamp(),
    ],
  });
}

async function onRegCancel(interaction) {
  await deleteSession(interaction.user.id, 'bs_reg');
  await replyEph(interaction, { embeds: [successEmbed('Registration cancelled. No slot was taken.')] });
}

// ---------- reminders ----------

async function onReminder(interaction, track) {
  const groups = await openGroupsFor(track);
  if (!groups.length) {
    return fail(interaction, `No open ${track} groups right now — nothing to subscribe to.`);
  }
  const select = new StringSelectMenuBuilder()
    .setCustomId(`bs:rem:group:${track}`)
    .setPlaceholder('🔔 Notify me on vacancy — pick a group')
    .addOptions(groups.slice(0, 25).map(groupOption));
  await replyEph(interaction, {
    embeds: [
      new EmbedBuilder()
        .setColor(trackColor(track))
        .setTitle(`🔔 ${track} Slot Reminder`)
        .setDescription("Pick a group below and we'll DM you if a slot opens up."),
    ],
    components: [new ActionRowBuilder().addComponents(select)],
  });
}

async function onRemGroupSelect(interaction, track) {
  const groupId = interaction.values?.[0];
  if (!groupId) return fail(interaction, 'No group selected.');
  const group = await prisma.scrimGroup.findUnique({ where: { id: groupId } }).catch(() => null);
  if (!group || group.groupType !== track || group.status !== 'OPEN' || !group.isOpen) {
    return fail(interaction, 'That group is no longer open.');
  }
  try {
    await prisma.slotReminder.upsert({
      where: { userDiscordId_groupId: { userDiscordId: String(interaction.user.id), groupId } },
      update: { notified: false },
      create: { userDiscordId: String(interaction.user.id), groupId, notified: false },
    });
  } catch (err) {
    console.error('[scrims] reminder upsert failed:', err.message);
    return fail(interaction, 'Could not save your reminder. Please try again.');
  }
  await audit('SCRIMS_REMINDER', interaction.user.id, `${track} group=${group.groupNo}`);
  await replyEph(interaction, {
    embeds: [successEmbed(`🔔 You'll be notified if a slot opens in **${track} Group ${group.groupNo}**.`)],
  });
}

// ---------- dispatch ----------

async function handle(interaction) {
  const id = interaction.customId || '';
  if (!id.startsWith('bs:')) return; // not ours — router decides

  if (id === 'bs:verify') return safe(onVerify)(interaction);
  if (id === 'bs:verify:edit') return safe(onVerifyEdit)(interaction);
  if (id === 'bs:verify:modal') return safe(onVerifyModalSubmit)(interaction);
  if (id.startsWith('bs:verify:modal:')) return safe(onVerifyPlayersModalSubmit)(interaction);
  if (id === 'bs:verify:submit') return safe(onVerifySubmit)(interaction);
  if (id === 'bs:verify:cancel') return safe(onVerifyCancel)(interaction);
  if (id === 'bs:verify:cancel:yes') return safe(onVerifyCancelYes)(interaction);
  if (id === 'bs:verify:cancel:no') return safe(onVerifyCancelNo)(interaction);

  if (id === 'bs:oq:register') return safe((i) => onTrackRegister(i, 'OQ'))(interaction);
  if (id === 'bs:t3:register') return safe((i) => onTrackRegister(i, 'T3'))(interaction);
  if (id === 'bs:oq:reminder') return safe((i) => onReminder(i, 'OQ'))(interaction);
  if (id === 'bs:t3:reminder') return safe((i) => onReminder(i, 'T3'))(interaction);

  if (id.startsWith('bs:reg:group:')) return safe((i) => onRegGroupSelect(i, id.split(':')[3]))(interaction);
  if (id.startsWith('bs:reg:confirm:')) return safe(onRegConfirm)(interaction);
  if (id === 'bs:reg:cancel') return safe(onRegCancel)(interaction);
  if (id.startsWith('bs:rem:group:')) return safe((i) => onRemGroupSelect(i, id.split(':')[3]))(interaction);

  // Unknown bs: sub-id — leave to the main bs: router (other flow modules).
}

module.exports = {
  handle,
  saveSession,
  getSession,
  deleteSession,
  _test: { lowestFreeSlot, registrationOpen, rosterFromTeam, isVerifiedForScrims, linkTeamVerification },
};
