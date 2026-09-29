/**
 * Agent I — scrimport-1: SS-IDP OCR intake + timed reminders + slot lists.
 *
 * Handles ONLY bs:ssidp:* custom IDs (per the scrimport-1 custom-ID registry):
 *   bs:ssidp:start:<token>  button after OCR: verifies the requester, opens the
 *                           lobby-start-time modal
 *   bs:ssidp:modal:<token>  modal submit: validates lobby time, posts the IDP
 *
 * Also exports:
 *   handleIdpImageMessage(message) — called from the messageCreate hook by the
 *     integrator; downloads group-channel screenshots, runs OCR, and replies
 *     with an extracted-creds preview (+ button) or the /ss_idp manual hint.
 *   startIdpScheduler(client) — 60s interval: -30/-5 min IDP reminders,
 *     match-day ping, auto slot-list publish, result-SS reminders. All guarded.
 *   publishSlotList(client, groupId, { auto }) — slot-list publish helper.
 *   notifyVacancy(groupId, client) — DM SlotReminder subscribers when a slot
 *     frees (Agent G calls this after remove/cancel/change; integrator wires).
 *   postRoomIdp(groupId, creds, client?) — post Room ID/password to the group
 *     channel, pinging the GROUP's own role (source bug used a global role).
 *
 * All times parsed/stored as UTC, displayed in IST. No tournament changes.
 */

const crypto = require('crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
} = require('discord.js');
const { prisma } = require('../db');
const { requireAdmin, errorEmbed, successEmbed, formatIST, audit } = require('../utils');
const {
  extractRoomCredentials,
  parseRoomText,
  isDuplicateCreds,
  markCredsSeen,
} = require('../services/ssidp-ocr');

const FOOTER = 'BLACK RAVEN ESPORTS';
const SERVER_NAME = process.env.SCRIMS_SERVER_NAME || 'BLACK RAVEN ESPORTS';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Session helpers — contract import from Agent V's flows/scrims.js, with a
// direct DB fallback against the ScrimFormSession model so this module works
// regardless of agent landing order.
// ---------------------------------------------------------------------------

function scrimsSessionApi() {
  try {
    // eslint-disable-next-line global-require
    const s = require('./scrims');
    if (s && typeof s.saveSession === 'function' && typeof s.getSession === 'function'
      && typeof s.deleteSession === 'function') {
      return s;
    }
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') console.error('[scrimidp] scrims session import failed:', err.message);
  }
  const ttlMinutes = 15;
  return {
    async saveSession(userDiscordId, flowType, payload, ttl = ttlMinutes) {
      const expiresAt = new Date(Date.now() + ttl * 60000);
      await prisma.scrimFormSession.deleteMany({ where: { userDiscordId, flowType } });
      await prisma.scrimFormSession.create({
        data: { userDiscordId, flowType, payload: JSON.stringify(payload || {}), expiresAt },
      });
    },
    async getSession(userDiscordId, flowType) {
      const row = await prisma.scrimFormSession.findFirst({
        where: { userDiscordId, flowType },
        orderBy: { createdAt: 'desc' },
      });
      if (!row || row.expiresAt.getTime() < Date.now()) return null;
      try {
        return JSON.parse(row.payload || '{}');
      } catch {
        return null;
      }
    },
    async deleteSession(userDiscordId, flowType) {
      await prisma.scrimFormSession.deleteMany({ where: { userDiscordId, flowType } });
    },
  };
}

// ---------------------------------------------------------------------------
// Slot-list rendering — contract import from Agent G's flows/scrimgroups.js
// (renderSlotList), with a local fallback built from ScrimSlot + Team.
// ---------------------------------------------------------------------------

function scrimgroupsApi() {
  try {
    // eslint-disable-next-line global-require
    const g = require('./scrimgroups');
    if (g && typeof g.renderSlotList === 'function') return g;
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') console.error('[scrimidp] scrimgroups import failed:', err.message);
  }
  return null;
}

const TRACK_COLORS = { OQ: 0xffa500, T3: 0x3b82f6 };

async function renderSlotListLocal(group) {
  const slots = await prisma.scrimSlot.findMany({
    where: { groupId: group.id },
    orderBy: { slotNo: 'asc' },
  });
  const teamIds = [...new Set(slots.map((s) => s.teamId).filter(Boolean))];
  const teams = teamIds.length
    ? await prisma.team.findMany({ where: { id: { in: teamIds } } })
    : [];
  const byId = new Map(teams.map((t) => [t.id, t]));
  const lines = slots.map((s) => {
    const team = s.teamId ? byId.get(s.teamId) : null;
    const label = s.status === 'FILLED' && team ? `**${team.name}**` : '—';
    return `\`Slot ${s.slotNo}\` ${label}`;
  });
  const dateStr = group.matchDate ? formatIST(group.matchDate).slice(0, 10) : 'TBD';
  return new EmbedBuilder()
    .setColor(TRACK_COLORS[group.groupType] ?? 0xffa500)
    .setTitle(`📋 ${group.groupType} Group ${group.groupNo} — Slot List`)
    .setDescription(lines.length ? lines.join('\n') : 'No slots yet.')
    .addFields({ name: 'Match Date', value: dateStr, inline: true })
    .setFooter({ text: FOOTER });
}

/**
 * Publish the slot list to the group's channel.
 * @param {import('discord.js').Client} client
 * @param {string} groupId
 * @param {{auto?:boolean}} opts
 * @returns {Promise<Message|null>} the sent message, or null on failure.
 */
async function publishSlotList(client, groupId, { auto = false } = {}) {
  try {
    const group = await prisma.scrimGroup.findUnique({ where: { id: groupId } });
    if (!group || !group.channelId || !client) return null;

    let embed = null;
    let textList = null;
    const api = scrimgroupsApi();
    if (api) {
      try {
        const rendered = await api.renderSlotList(groupId);
        if (rendered) {
          if (typeof rendered === 'string') textList = rendered;
          else embed = rendered;
        }
      } catch (err) {
        console.error('[scrimidp] renderSlotList (G) failed:', err.message);
      }
    }
    if (!embed && !textList) embed = await renderSlotListLocal(group);

    const channel = await client.channels.fetch(group.channelId).catch(() => null);
    if (!channel || typeof channel.send !== 'function') return null;

    const rolePing = group.roleId ? `<@&${group.roleId}>` : '';
    const content = [rolePing, auto ? '**📋 Auto Slot List**' : '**📋 Slot List**']
      .filter(Boolean)
      .join('\n') + (textList ? `\n${textList}` : '');
    const sent = await channel.send({
      content,
      ...(embed ? { embeds: [embed] } : {}),
      allowedMentions: { roles: group.roleId ? [String(group.roleId)] : [] },
    });
    if (auto) {
      await prisma.scrimGroup.update({
        where: { id: groupId },
        data: { slotListAutoPublishedAt: new Date() },
      });
    }
    await audit('bs:slotlist:publish', 'scheduler', `group=${group.groupType} G${group.groupNo} auto=${auto}`);
    return sent;
  } catch (err) {
    console.error('[scrimidp] publishSlotList failed:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// SS-IDP posting — pings the GROUP's own role (source used a global role; fixed).
// ---------------------------------------------------------------------------

const DEFAULT_IDP_TEMPLATE = [
  '**🎯 ROOM ID / PASSWORD**',
  '',
  '**ROOM ID:** {{room_id}}',
  '**PASSWORD:** {{password}}',
  '**LOBBY TIME:** {{lobby_time}}',
  '',
  '_Good luck, teams!_',
].join('\n');

async function getIdpTemplate() {
  try {
    const row = await prisma.messageTemplate.findUnique({ where: { name: 'ss_idp' } });
    if (row && row.content) return row.content;
  } catch (err) {
    console.error('[scrimidp] template read failed:', err.message);
  }
  return DEFAULT_IDP_TEMPLATE;
}

function renderIdpTemplate(tpl, vars) {
  return String(tpl).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

let schedulerClient = null;

/**
 * Post Room ID/password to the group's channel, pinging the group's own role.
 * @param {string} groupId ScrimGroup.id
 * @param {{roomId:string,password:string,lobbyTime?:string|null}} creds
 * @param {import('discord.js').Client} [client]
 * @returns {Promise<Message|null>}
 */
async function postRoomIdp(groupId, creds, client = null) {
  try {
    const c = client || schedulerClient;
    if (!c) {
      console.error('[scrimidp] postRoomIdp: no client available');
      return null;
    }
    const group = await prisma.scrimGroup.findUnique({ where: { id: groupId } });
    if (!group || !group.channelId) return null;
    const channel = await c.channels.fetch(group.channelId).catch(() => null);
    if (!channel || typeof channel.send !== 'function') return null;

    const tpl = await getIdpTemplate();
    const body = renderIdpTemplate(tpl, {
      room_id: creds.roomId,
      password: creds.password,
      lobby_time: creds.lobbyTime || 'Not provided',
      group: `${group.groupType} Group ${group.groupNo}`,
    });
    const rolePing = group.roleId ? `<@&${group.roleId}>` : '';
    const content = [rolePing, body].filter(Boolean).join('\n');
    const sent = await channel.send({
      content,
      allowedMentions: { roles: group.roleId ? [String(group.roleId)] : [] },
    });
    await audit('bs:ssidp:post', 'staff', `group=${group.groupType} G${group.groupNo} room posted`);
    return sent;
  } catch (err) {
    console.error('[scrimidp] postRoomIdp failed:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Interaction handling — ONLY bs:ssidp:*
// ---------------------------------------------------------------------------

function tokenOf(customId, prefix) {
  return String(customId || '').slice(prefix.length);
}

async function onStartButton(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const token = tokenOf(interaction.customId, 'bs:ssidp:start:');
  const api = scrimsSessionApi();
  let payload = null;
  try {
    payload = await api.getSession(interaction.user.id, `bs:ssidp:${token}`);
  } catch (err) {
    console.error('[scrimidp] session read failed:', err.message);
  }
  if (!payload || !payload.roomId || !payload.password || !payload.groupId) {
    await interaction.reply({
      embeds: [errorEmbed('This SS-IDP request expired. Please re-upload the screenshot or use `/ss_idp manual`.')],
      ephemeral: true,
    });
    return;
  }
  if (payload.userId && payload.userId !== interaction.user.id) {
    await interaction.reply({
      embeds: [errorEmbed('Only the staff member who uploaded the screenshot can continue this.')],
      ephemeral: true,
    });
    return;
  }
  const modal = new ModalBuilder()
    .setCustomId(`bs:ssidp:modal:${token}`)
    .setTitle('Lobby Start Time')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('lobby_time')
          .setLabel('Lobby start time (IST)')
          .setPlaceholder('HH:MM, e.g. 19:30')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(5)
      )
    );
  await interaction.showModal(modal);
}

const LOBBY_TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

async function onModalSubmit(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const token = tokenOf(interaction.customId, 'bs:ssidp:modal:');
  const api = scrimsSessionApi();
  let payload = null;
  try {
    payload = await api.getSession(interaction.user.id, `bs:ssidp:${token}`);
  } catch (err) {
    console.error('[scrimidp] session read failed:', err.message);
  }
  if (!payload || !payload.roomId || !payload.password || !payload.groupId) {
    const reply = { embeds: [errorEmbed('This SS-IDP request expired. Please re-upload the screenshot or use `/ss_idp manual`.')], ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(reply);
    else await interaction.reply(reply);
    return;
  }
  const lobbyTime = (interaction.fields.getTextInputValue('lobby_time') || '').trim();
  if (lobbyTime && !LOBBY_TIME_RE.test(lobbyTime)) {
    await interaction.reply({ embeds: [errorEmbed('Lobby time must be HH:MM (24h IST), or leave it blank.')], ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  let sent = null;
  try {
    sent = await postRoomIdp(payload.groupId, {
      roomId: payload.roomId,
      password: payload.password,
      lobbyTime: lobbyTime || null,
    }, interaction.client);
    await api.deleteSession(interaction.user.id, `bs:ssidp:${token}`);
  } catch (err) {
    console.error('[scrimidp] modal submit failed:', err.message);
  }
  if (sent) {
    await interaction.editReply({ embeds: [successEmbed('Room details posted to the group channel.')] });
  } else {
    await interaction.editReply({ embeds: [errorEmbed('Could not post the IDP. Check the group channel and try `/ss_idp manual`.')] });
  }
}

async function handle(interaction) {
  const id = interaction.customId || '';
  if (!id.startsWith('bs:ssidp:')) return;
  try {
    if (interaction.isButton() && id.startsWith('bs:ssidp:start:')) return onStartButton(interaction);
    if (interaction.isModalSubmit() && id.startsWith('bs:ssidp:modal:')) return onModalSubmit(interaction);
  } catch (err) {
    console.error('[scrimidp] handle error:', err.message);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ embeds: [errorEmbed('Something went wrong. Please try again.')], ephemeral: true });
      }
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Image intake — called from the messageCreate hook by the integrator.
// ---------------------------------------------------------------------------

function isImageAttachment(att) {
  const ct = String(att.contentType || '').toLowerCase();
  const name = String(att.name || att.url || '').toLowerCase();
  return ct.startsWith('image/') || /\.(png|jpe?g|webp|bmp)$/i.test(name);
}

/**
 * Handle a message that may be an SS-IDP screenshot in a group channel.
 * Never throws; ignores non-image messages and non-group channels.
 */
async function handleIdpImageMessage(message) {
  try {
    if (!message || !message.guild || message.author?.bot) return;
    const channelId = message.channelId || message.channel?.id;
    if (!channelId) return;
    const group = await prisma.scrimGroup.findUnique({ where: { channelId: String(channelId) } });
    if (!group || group.status !== 'OPEN' || !group.isOpen) return;
    const att = [...(message.attachments?.values?.() || [])].find(isImageAttachment);
    if (!att) return;
    if (att.size && att.size > MAX_IMAGE_BYTES) {
      await message.reply({ content: 'Screenshot is too large (max 8MB). Please compress it or use `/ss_idp manual`.' }).catch(() => null);
      return;
    }
    let buffer;
    try {
      const res = await fetch(att.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > MAX_IMAGE_BYTES) throw new Error('image exceeds 8MB');
    } catch (err) {
      console.error('[scrimidp] screenshot download failed:', err.message);
      return;
    }

    let creds = null;
    try {
      creds = await extractRoomCredentials(buffer);
    } catch (err) {
      console.error('[scrimidp] OCR error:', err.message);
    }
    if (!creds) {
      await message.reply({
        content: "I couldn't read the Room ID and password from this screenshot. Please send a clearer screenshot or use `/ss_idp manual`.",
      }).catch(() => null);
      return;
    }
    if (isDuplicateCreds(creds.roomId, creds.password)) {
      await message.reply({ content: 'These room details were already posted recently — skipping duplicate.' }).catch(() => null);
      return;
    }
    markCredsSeen(creds.roomId, creds.password);

    const token = crypto.randomBytes(8).toString('hex');
    const api = scrimsSessionApi();
    try {
      await api.saveSession(message.author.id, `bs:ssidp:${token}`, {
        roomId: creds.roomId,
        password: creds.password,
        groupId: group.id,
        groupType: group.groupType,
        groupNo: group.groupNo,
        userId: message.author.id,
      }, 15);
    } catch (err) {
      console.error('[scrimidp] session save failed:', err.message);
      await message.reply({ content: 'OCR read the room details, but I could not stage them. Please use `/ss_idp manual`.' }).catch(() => null);
      return;
    }

    const preview = new EmbedBuilder()
      .setColor(TRACK_COLORS[group.groupType] ?? 0xffa500)
      .setTitle(`🎯 Room Details Detected — ${group.groupType} Group ${group.groupNo}`)
      .setDescription(
        `**Room ID:** \`${creds.roomId}\`\n**Password:** \`${creds.password}\`\n\n` +
        'Tap **Enter Start Time** to publish the IDP to this group channel.'
      )
      .setFooter({ text: FOOTER })
      .setTimestamp();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`bs:ssidp:start:${token}`)
        .setLabel('Enter Start Time')
        .setStyle(ButtonStyle.Primary)
    );
    await message.reply({ embeds: [preview], components: [row] }).catch(() => null);
  } catch (err) {
    console.error('[scrimidp] handleIdpImageMessage error:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Scheduler: IDP reminders (-30/-5), match-day ping, auto slot-list publish,
// result-SS reminders. 60s interval, all guarded, never throws.
// ---------------------------------------------------------------------------

let schedulerStarted = false;
let schedulerRunning = false;
const matchDayPinged = new Set(); // `${groupId}:${YYYY-MM-DD}` — transient
const resultSsReminded = new Set(); // groupId — transient

function istNow(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const p = Object.fromEntries(parts.filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  return { dateStr: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}

async function postToGroupChannel(client, group, content, { embed = null } = {}) {
  if (!client || !group?.channelId) return null;
  const channel = await client.channels.fetch(group.channelId).catch(() => null);
  if (!channel || typeof channel.send !== 'function') return null;
  return channel.send({
    content,
    ...(embed ? { embeds: [embed] } : {}),
    allowedMentions: { roles: group.roleId ? [String(group.roleId)] : [] },
  });
}

const rolePing = (group) => (group.roleId ? `<@&${group.roleId}>\n` : '');

async function tickIdpReminders(client, group, matches, now) {
  const firstMinutes = Number(process.env.IDP_REMINDER_MINUTES_1 || 30);
  const secondMinutes = Number(process.env.IDP_REMINDER_MINUTES_2 || 5);
  for (const m of matches) {
    if (!m.idpAt) continue;
    const diffMin = (m.idpAt.getTime() - now.getTime()) / 60000;
    try {
      if (!m.idpReminder30SentAt && shouldSendReminder({ sentAt: null, diffMin, windowMin: firstMinutes, lowerBoundMin: secondMinutes })) {
        await postToGroupChannel(client, group, [
          rolePing(group).trim(),
          `⏰ **SCRIMS REMINDER 1/2**`,
          `**${group.groupType} Group ${group.groupNo} — Match ${m.matchNo}**`,
          `IDP time is in approximately **${Math.max(0, Math.ceil(diffMin))} minutes**.`,
          'Please be ready in the lobby and do not waste your slot.',
        ].filter(Boolean).join('\n'));
        await prisma.scrimMatch.update({ where: { id: m.id }, data: { idpReminder30SentAt: now } });
      } else if (!m.idpReminder5SentAt && diffMin <= secondMinutes && diffMin > -5) {
        await postToGroupChannel(client, group, [
          rolePing(group).trim(),
          `⏰ **SCRIMS REMINDER 2/2**`,
          `**${group.groupType} Group ${group.groupNo} — Match ${m.matchNo}**`,
          `IDP time is in approximately **${Math.max(0, Math.ceil(diffMin))} minutes**.`,
          'Get into the lobby NOW. Late entries risk losing their slot.',
        ].filter(Boolean).join('\n'));
        await prisma.scrimMatch.update({ where: { id: m.id }, data: { idpReminder5SentAt: now } });
      }
    } catch (err) {
      console.error(`[scrimidp] reminder failed group=${group.id} match=${m.matchNo}:`, err.message);
    }
  }
}

async function tickMatchDayPing(client, group, matches, now) {
  const ist = istNow(now);
  if (ist.hour !== 11 || ist.minute >= 5) return;
  const key = `${group.id}:${ist.dateStr}`;
  if (matchDayPinged.has(key)) return;
  const hasMatchToday = matches.some((m) => m.idpAt && istNow(m.idpAt).dateStr === ist.dateStr)
    || (group.matchDate && istNow(group.matchDate).dateStr === ist.dateStr);
  if (!hasMatchToday) return;
  try {
    await postToGroupChannel(client, group, [
      rolePing(group).trim(),
      '**Hey Teams,**',
      '',
      `- **Today** is your match day — **${group.groupType} Group ${group.groupNo}**.`,
      '- Please check the IDP timings shared above and be ready in the lobby on time.',
      '',
      '- Screenshots submission is compulsory within 30 minutes after completion of both matches.',
      '',
      '__**NO SS = NO POINTS**__',
      '',
      `Thanks & Regards,\n${SERVER_NAME}`,
    ].filter(Boolean).join('\n'));
    matchDayPinged.add(key);
  } catch (err) {
    console.error(`[scrimidp] match-day ping failed group=${group.id}:`, err.message);
  }
}

async function tickAutoSlotList(client, group, matches, now) {
  if (group.slotListAutoPublishedAt) return;
  const m1 = matches.find((m) => m.matchNo === 1);
  if (!m1 || !m1.idpAt) return;
  const diffMin = (m1.idpAt.getTime() - now.getTime()) / 60000;
  if (diffMin > 15 || diffMin <= -5) return;
  try {
    await publishSlotList(client, group.id, { auto: true });
  } catch (err) {
    console.error(`[scrimidp] auto slot-list failed group=${group.id}:`, err.message);
  }
}

function formatDeadlineIST(date) {
  const ist = new Date(date.getTime() + 5.5 * 3600 * 1000);
  let h = ist.getUTCHours();
  const m = String(ist.getUTCMinutes()).padStart(2, '0');
  const suffix = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${String(h).padStart(2, '0')}:${m} ${suffix}`;
}

async function tickResultSsReminder(client, group, matches) {
  if (resultSsReminded.has(group.id)) return;
  const m2 = matches.find((m) => m.matchNo === 2);
  if (!m2 || !m2.startAt) return;
  const sendAt = new Date(m2.startAt.getTime() + 5 * 60000);
  if (sendAt.getTime() > Date.now()) return;
  try {
    const channel = await client.channels.fetch(group.channelId).catch(() => null);
    if (!channel || typeof channel.send !== 'function') return;
    // Re-open the channel for result submissions, like the source.
    if (group.roleId) {
      await channel.permissionOverwrites
        .edit(group.roleId, { SendMessages: true, AttachFiles: true, ViewChannel: true, ReadMessageHistory: true })
        .catch((err) => console.error(`[scrimidp] reopen channel failed group=${group.id}:`, err.message));
    }
    const deadline = new Date(m2.startAt.getTime() + 60 * 60000);
    await postToGroupChannel(client, group, [
      rolePing(group).trim(),
      '**⚠️ RESULT SS REQUIRED**',
      '',
      '**📷 SUBMIT YOUR BOTH MATCHES RESULT SS**',
      '',
      `⏰ DEADLINE: **${formatDeadlineIST(deadline)} IST** (1 hour)`,
      '',
      '**Submit both match screenshots before the deadline — late submissions will not be accepted.**',
    ].filter(Boolean).join('\n'));
    resultSsReminded.add(group.id);
    await audit('bs:ssidp:resultss', 'scheduler', `group=${group.groupType} G${group.groupNo} reminder sent`);
  } catch (err) {
    console.error(`[scrimidp] result-SS reminder failed group=${group.id}:`, err.message);
  }
}

async function tickGroup(client, group, now) {
  const matches = await prisma.scrimMatch.findMany({ where: { groupId: group.id } });
  await tickIdpReminders(client, group, matches, now);
  await tickMatchDayPing(client, group, matches, now);
  await tickAutoSlotList(client, group, matches, now);
  await tickResultSsReminder(client, group, matches);
}

async function schedulerTick(client) {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    const now = new Date();
    const groups = await prisma.scrimGroup.findMany({
      where: { status: 'OPEN', isOpen: true, resultPublishedAt: null },
    });
    for (const group of groups) {
      try {
        await tickGroup(client, group, now);
      } catch (err) {
        console.error(`[scrimidp] tick group error ${group.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[scrimidp] scheduler tick error:', err.message);
  } finally {
    schedulerRunning = false;
  }
}

function startIdpScheduler(client) {
  if (schedulerStarted) return;
  schedulerStarted = true;
  schedulerClient = client;
  setTimeout(() => schedulerTick(client).catch((err) => console.error('[scrimidp] start tick error:', err.message)), 10000);
  setInterval(() => schedulerTick(client).catch((err) => console.error('[scrimidp] interval tick error:', err.message)), 60000);
}

// ---------------------------------------------------------------------------
// Slot vacancy DMs — called by Agent G's flows after remove/cancel/change
// frees a slot. The integrator wires the call; this module only exports it.
// ---------------------------------------------------------------------------

function vacancyEmbed(group, matches) {
  const m1 = matches.find((m) => m.matchNo === 1);
  const m2 = matches.find((m) => m.matchNo === 2);
  return new EmbedBuilder()
    .setColor(TRACK_COLORS[group.groupType] ?? 0xffa500)
    .setTitle('🎯 Slot Available')
    .setDescription(
      [
        `A slot is now available in **${group.groupType} Group ${group.groupNo}**.`,
        '',
        `**Date:** ${group.matchDate ? formatIST(group.matchDate).slice(0, 10) : 'TBD'}`,
        `**Match 1 IDP:** ${m1?.idpAt ? formatIST(m1.idpAt).slice(11) : 'TBD'}`,
        `**Match 2 IDP:** ${m2?.idpAt ? formatIST(m2.idpAt).slice(11) : 'TBD'}`,
        '',
        'Open the registration panel and register quickly before the slot is filled.',
      ].join('\n')
    )
    .setFooter({ text: SERVER_NAME })
    .setTimestamp();
}

/**
 * DM all un-notified SlotReminder subscribers for a group, then mark them
 * notified. Only fires when the group actually has a free slot.
 * @param {string} groupId ScrimGroup.id
 * @param {import('discord.js').Client} [client]
 * @returns {Promise<{notified:number}>}
 */
async function notifyVacancy(groupId, client = null) {
  try {
    const c = client || schedulerClient;
    if (!c) {
      console.error('[scrimidp] notifyVacancy: no client available');
      return { notified: 0 };
    }
    const group = await prisma.scrimGroup.findUnique({ where: { id: groupId } });
    if (!group || group.status !== 'OPEN' || !group.isOpen) return { notified: 0 };
    const free = await prisma.scrimSlot.count({ where: { groupId, status: 'EMPTY' } });
    if (!free) return { notified: 0 };
    const matches = await prisma.scrimMatch.findMany({ where: { groupId } });
    const pending = await prisma.slotReminder.findMany({ where: { groupId, notified: false } });
    let notified = 0;
    for (const r of pending) {
      try {
        const user = await c.users.fetch(r.userDiscordId).catch(() => null);
        if (!user) continue;
        await user.send({ embeds: [vacancyEmbed(group, matches)] });
        await prisma.slotReminder.update({ where: { id: r.id }, data: { notified: true } });
        notified++;
      } catch (err) {
        console.error(`[scrimidp] vacancy DM failed user=${r.userDiscordId}:`, err.message);
      }
    }
    if (notified) await audit('bs:vacancy:notify', 'scheduler', `group=${group.groupType} G${group.groupNo} notified=${notified}`);
    return { notified };
  } catch (err) {
    console.error('[scrimidp] notifyVacancy error:', err.message);
    return { notified: 0 };
  }
}

// ---------------------------------------------------------------------------
// Pure helpers for tests
// ---------------------------------------------------------------------------

function minutesUntil(date, now = new Date()) {
  return (new Date(date).getTime() - new Date(now).getTime()) / 60000;
}

/**
 * Mirror of the source's reminder window logic: fires when diffMin is inside
 * (lowerBoundMin, windowMin] and nothing was sent yet.
 */
function shouldSendReminder({ sentAt, diffMin, windowMin, lowerBoundMin = -Infinity }) {
  if (sentAt) return false;
  return diffMin <= windowMin && diffMin > lowerBoundMin;
}

module.exports = {
  handle,
  handleIdpImageMessage,
  startIdpScheduler,
  publishSlotList,
  postRoomIdp,
  notifyVacancy,
  _test: {
    parseRoomText,
    minutesUntil,
    shouldSendReminder,
    renderIdpTemplate,
    istNow,
    formatDeadlineIST,
  },
};
