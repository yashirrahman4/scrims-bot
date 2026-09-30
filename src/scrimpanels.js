// Scrims panel builders (bs: namespace).
// NOTE: created by Agent A with only its own builders; Agent V/G/I APPEND theirs.
// (Integrator note: /setup-panel needs choices br_verify, br_oq, br_t3, br_admin, br_lobby.)

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { prisma } = require('./db');
const { formatIST } = require('./utils');

const FOOTER = process.env.SCRIMS_SERVER_NAME || 'BLACK RAVEN ESPORTS';
const SLOT_TOTAL = 21;

/** Admin control panel: team lookup, bans, team delete/restore, templates. */
function brAdminPanel() {
  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('🛡️ BLACK RAVEN ESPORTS — SCRIMS ADMIN')
    .setDescription('Staff tools for scrims operations.\nOnly admins can use these buttons.')
    .setFooter({ text: FOOTER });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('bs:admin:lookup').setLabel('Team Lookup').setStyle(ButtonStyle.Primary).setEmoji('🔍'),
    new ButtonBuilder().setCustomId('bs:admin:ban').setLabel('Ban').setStyle(ButtonStyle.Danger).setEmoji('⛔'),
    new ButtonBuilder().setCustomId('bs:admin:unban').setLabel('Unban').setStyle(ButtonStyle.Secondary).setEmoji('✅'),
    new ButtonBuilder().setCustomId('bs:admin:banlist').setLabel('Ban List').setStyle(ButtonStyle.Secondary).setEmoji('📋')
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('bs:admin:delteam').setLabel('Delete Team').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
    new ButtonBuilder().setCustomId('bs:admin:restoreteam').setLabel('Restore Team').setStyle(ButtonStyle.Success).setEmoji('♻️'),
    new ButtonBuilder().setCustomId('bs:tpl:list').setLabel('Templates').setStyle(ButtonStyle.Secondary).setEmoji('📝')
  );

  return { embeds: [embed], components: [row1, row2] };
}

function progressBar(filled, total) {
  const blocks = 10;
  const f = total ? Math.round((filled / total) * blocks) : 0;
  return '▰'.repeat(f) + '▱'.repeat(blocks - f);
}

/** Format a Date as DD-MM-YYYY in IST. */
function fmtDateIST(date) {
  if (!date) return 'TBD';
  const ist = new Date(date.getTime() + 5.5 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(ist.getUTCDate())}-${p(ist.getUTCMonth() + 1)}-${ist.getUTCFullYear()}`;
}

/**
 * Live lobby occupancy embed for one panel type ("OQ" | "T3" | "ALL").
 * Lists OPEN groups as "G<n>: filled/21 — <date IST>".
 */
async function buildLobbyEmbed(panelType = 'ALL') {
  const type = ['OQ', 'T3'].includes(String(panelType).toUpperCase())
    ? String(panelType).toUpperCase()
    : 'ALL';
  const tracks = type === 'ALL' ? ['OQ', 'T3'] : [type];

  const sections = [];
  for (const track of tracks) {
    let lines = 'No open groups.';
    try {
      const groups = await prisma.scrimGroup.findMany({
        where: { groupType: track, status: 'OPEN', isOpen: true },
        include: { slots: true },
        orderBy: { groupNo: 'asc' },
      });
      if (groups.length) {
        lines = groups
          .map((g) => {
            const filled = g.slots.filter((s) => s.status === 'FILLED').length;
            const total = g.slots.length || SLOT_TOTAL;
            return `${progressBar(filled, total)} **${track} G${g.groupNo}** — ${filled}/${total} filled — ${fmtDateIST(g.matchDate)}`;
          })
          .join('\n');
      }
    } catch (err) {
      console.error('[lobby] buildLobbyEmbed failed:', err.message);
      lines = '⚠️ Could not load lobby data.';
    }
    sections.push(`**${track} LOBBIES**\n${lines}`);
  }

  const color = type === 'T3' ? 0x3b82f6 : type === 'OQ' ? 0xffa500 : 0x22c55e;
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`🔴 LIVE LOBBY — ${type}`)
    .setDescription(sections.join('\n\n━━━━━━━━━━━━\n\n'))
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

// ---------------------------------------------------------------------------
// Agent G (scrim group lifecycle) — APPENDED builders; never remove others' code.
// ---------------------------------------------------------------------------
const {
  ActionRowBuilder: _ActionRowBuilderG,
  ButtonBuilder: _ButtonBuilderG,
  ButtonStyle: _ButtonStyleG,
  StringSelectMenuBuilder: _StringSelectMenuBuilderG,
} = require('discord.js');

const BR_FOOTER_G = 'BLACK RAVEN ESPORTS';
const BR_COLOR_G = 0x9b111e; // deep raven red

/**
 * Group management panel (posted in the group's private channel).
 * 1 embed + 1 row of 5 staff buttons (Discord max 5 rows / 5 buttons per row).
 * @param {{ id: string, groupNo: number, groupType: string, matchDate: Date|null }} group
 */
function groupPanel(group) {
  const embed = new EmbedBuilder()
    .setColor(BR_COLOR_G)
    .setTitle(`🛡️ GROUP ${group.groupType}-${group.groupNo}`)
    .setDescription(
      [
        `**Track:** ${group.groupType}`,
        `**Group:** #${group.groupNo}`,
        `**Match date:** ${group.matchDate ? group.matchDate.toISOString().slice(0, 10) : '—'}`,
        '',
        'Staff controls for this scrim group:',
        '• **Match Reminder** — post the next-match reminder in this channel',
        '• **Publish Slots** — post the current slot list now',
        '• **Warn Team** — slot-waste warning to a team (auto-ban on max)',
        '• **Remove Team** — remove a team from a slot',
        '• **Qualify** — close the group and publish the qualifier',
      ].join('\n')
    )
    .setFooter({ text: BR_FOOTER_G })
    .setTimestamp();

  const row = new _ActionRowBuilderG().addComponents(
    new _ButtonBuilderG()
      .setCustomId(`bs:panel:remind:${group.id}`)
      .setLabel('Match Reminder')
      .setStyle(_ButtonStyleG.Primary),
    new _ButtonBuilderG()
      .setCustomId(`bs:panel:publish:${group.id}`)
      .setLabel('Publish Slots')
      .setStyle(_ButtonStyleG.Secondary),
    new _ButtonBuilderG()
      .setCustomId(`bs:panel:warn:${group.id}`)
      .setLabel('Warn Team')
      .setStyle(_ButtonStyleG.Secondary),
    new _ButtonBuilderG()
      .setCustomId(`bs:panel:remove:${group.id}`)
      .setLabel('Remove Team')
      .setStyle(_ButtonStyleG.Danger),
    new _ButtonBuilderG()
      .setCustomId(`bs:panel:qualify:${group.id}`)
      .setLabel('Qualify')
      .setStyle(_ButtonStyleG.Success)
  );

  return { embeds: [embed], components: [row] };
}

/**
 * Team self-service panel (posted in the group's private channel).
 * Row 1: Cancel My Slot (danger). Row 2: Change Group string-select.
 * @param {string} groupId
 * @param {Array<{ id: string, label: string, description?: string }>} targets
 *        other OPEN same-track groups the team may move to (may be empty)
 */
function teamSelfServicePanel(groupId, targets = []) {
  const cancelRow = new _ActionRowBuilderG().addComponents(
    new _ButtonBuilderG()
      .setCustomId(`bs:team:cancel:${groupId}`)
      .setLabel('Cancel My Slot')
      .setStyle(_ButtonStyleG.Danger)
  );

  const options = targets.length
    ? targets.slice(0, 25).map((t) => ({
        label: String(t.label).slice(0, 100),
        value: String(t.id).slice(0, 100),
        description: t.description ? String(t.description).slice(0, 100) : undefined,
      }))
    : [{ label: 'No other open groups right now', value: 'none', description: 'Pick later if a slot frees up' }];

  const selectRow = new _ActionRowBuilderG().addComponents(
    new _StringSelectMenuBuilderG()
      .setCustomId(`bs:team:change:${groupId}`)
      .setPlaceholder('🔁 Change Group — pick a target group')
      .addOptions(options)
  );

  return { components: [cancelRow, selectRow] };
}

// --- Agent G exports merged into the shared module exports (append-only) ---
module.exports.groupPanel = groupPanel;
module.exports.teamSelfServicePanel = teamSelfServicePanel;

/* ===================== AGENT V — verification + registration panels ================
 * Agent V builders. Other agents APPEND below; do not edit above.
 */
const { ActionRowBuilder: V_AR, ButtonBuilder: V_BB, ButtonStyle: V_BS, EmbedBuilder: V_EB } = require('discord.js');

/** Green scrims verification panel. Buttons: bs:verify, bs:verify:edit */
function brVerifyPanel() {
  const embed = new V_EB()
    .setColor(0x22c55e)
    .setTitle('BLACK RAVEN ESPORTS — SCRIMS VERIFICATION')
    .setDescription(
      [
        'Complete your official **Scrims Verification** using the buttons below.',
        '',
        '**Available Actions**',
        '• Register your team',
        '• Edit your registered team',
        '',
        '**Important Notes**',
        '• One profile is reused by both **OQ** and **T3** — verify once.',
        '• Fill correct Gmail, WhatsApp number, IGN and UID.',
        '• Submit only after all player details are completed.',
      ].join('\n')
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();

  const row = new V_AR().addComponents(
    new V_BB().setCustomId('bs:verify').setLabel('Register Team').setStyle(V_BS.Success),
    new V_BB().setCustomId('bs:verify:edit').setLabel('Edit Registered Team').setStyle(V_BS.Primary)
  );

  return { embeds: [embed], components: [row] };
}

/** Orange OQ registration panel. Buttons: bs:oq:register, bs:oq:reminder */
function brOqPanel() {
  const embed = new V_EB()
    .setColor(0xffa500)
    .setTitle('BLACK RAVEN ESPORTS — OQ REGISTRATION')
    .setDescription(
      [
        'Welcome to the official **OQ Scrims Registration Panel**.',
        '',
        '**Choose an option below:**',
        '• Register your (already verified) team for OQ scrims',
        '• Set OQ slot reminder',
        '',
        '**Important Notes**',
        '• You must complete **Scrims Verification** first — team creation and roster edits only happen there.',
        '• Once verified, just pick a group and confirm. No re-entering players.',
        '• Management can remove fake or invalid registrations.',
      ].join('\n')
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();

  const row = new V_AR().addComponents(
    new V_BB().setCustomId('bs:oq:register').setLabel('OQ Registration').setStyle(V_BS.Success),
    new V_BB().setCustomId('bs:oq:reminder').setLabel('OQ Slot Reminder').setStyle(V_BS.Secondary)
  );

  return { embeds: [embed], components: [row] };
}

/** Blue T3 registration panel. Buttons: bs:t3:register, bs:t3:reminder */
function brT3Panel() {
  const embed = new V_EB()
    .setColor(0x3b82f6)
    .setTitle('BLACK RAVEN ESPORTS — T3 REGISTRATION')
    .setDescription(
      [
        'Welcome to the official **T3 Registration Panel**.',
        '',
        '**Choose an option below:**',
        '• Register for T3 using your Scrims-Verified team',
        '• Set T3 slot reminder',
        '',
        '**Important Notes**',
        '• You must have completed **Scrims Verification** first.',
        '• T3 uses the exact same verified roster as OQ.',
        '• A required T3 role is needed to register.',
        '• Management can remove fake or invalid registrations.',
      ].join('\n')
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();

  const row = new V_AR().addComponents(
    new V_BB().setCustomId('bs:t3:register').setLabel('T3 Registration').setStyle(V_BS.Primary),
    new V_BB().setCustomId('bs:t3:reminder').setLabel('T3 Slot Reminder').setStyle(V_BS.Secondary)
  );

  return { embeds: [embed], components: [row] };
}

// --- Agent V exports merged into the shared module exports (append-only) ---
module.exports.brVerifyPanel = brVerifyPanel;
module.exports.brOqPanel = brOqPanel;
module.exports.brT3Panel = brT3Panel;

// --- Agent A exports (append-only; re-applied after parallel agents' appends) ---
module.exports.brAdminPanel = brAdminPanel;
module.exports.buildLobbyEmbed = buildLobbyEmbed;
module.exports.FOOTER = FOOTER;
module.exports._testA = { progressBar, fmtDateIST };

// ---------------------------------------------------------------------------
// Scrims IDP schedule panel — mirrors the tournament IDP panel's detail
// display (Event / Matches Date / Total Slots / Total Matches / per-match
// map + IDP AT + START AT), with Edit and Lock/Unlock staff buttons.
// Posted in the group's private channel at creation; refreshed after edits.
// ---------------------------------------------------------------------------

/** Canonical title for a scrims IDP panel — also used to re-find it later. */
function scrimIdpPanelTitle(group) {
  return `🗂️ ${group.groupType} G${group.groupNo} · Match Schedule`;
}

function fmtIdpDateTime(dt) {
  if (!dt) return 'TBD';
  return formatIST(dt);
}

/**
 * @param {object} group { id, groupNo, groupType, matchDate }
 * @param {Array} matches [{ matchNo, map, idpAt, startAt }]
 * @param {boolean} locked
 */
function scrimIdpPanel(group, matches, locked) {
  const list = [...(matches || [])].sort((a, b) => a.matchNo - b.matchNo);
  const dateStr = group.matchDate ? formatIST(group.matchDate).split(' ')[0] : 'TBD';
  const embed = new EmbedBuilder()
    .setColor(0x9b111e) // raven red (scrims brand); layout mirrors the tournament IDP panel
    .setTitle(scrimIdpPanelTitle(group))
    .setDescription(
      `**🏆 Event:** Black Raven Scrims · ${group.groupType}\n` +
        `**📅 Matches Date:** ${dateStr}\n` +
        `**👥 Total Slots:** ${SLOT_TOTAL}\n` +
        `**🎮 Total Matches:** ${list.length}\n\n` +
        (list
          .map(
            (m) =>
              `**Match ${m.matchNo}** — 🗺️ ${m.map || '_Not revealed yet_'}\n` +
              `✨ IDP AT: \`${fmtIdpDateTime(m.idpAt)}\` · 🚀 START AT: \`${fmtIdpDateTime(m.startAt)}\``
          )
          .join('\n\n') || '_No matches scheduled yet — press Edit to fix this._')
    )
    .setFooter({ text: locked ? '🔒 Group locked — only staff can send messages' : '🔓 Group unlocked' })
    .setTimestamp();

  const lockBtn = locked
    ? new ButtonBuilder().setCustomId(`bs:panel:unlock:${group.id}`).setLabel('Unlock Group').setStyle(ButtonStyle.Secondary).setEmoji('🔓')
    : new ButtonBuilder().setCustomId(`bs:panel:lock:${group.id}`).setLabel('Lock Group').setStyle(ButtonStyle.Secondary).setEmoji('🔒');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`bs:panel:edit:${group.id}`).setLabel('Edit').setStyle(ButtonStyle.Primary).setEmoji('✏️'),
    lockBtn
  );

  return { embeds: [embed], components: [row] };
}

module.exports.scrimIdpPanel = scrimIdpPanel;
module.exports.scrimIdpPanelTitle = scrimIdpPanelTitle;
