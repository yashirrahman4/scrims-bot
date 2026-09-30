// Agent A — scrims admin tools.
// Handles: /message_template, /bot_health, /export scrim, bs:admin:*, bs:tpl:*,
// bs:lobby:*. All staff actions are admin-gated via requireAdmin.
// Live lobby scheduler + lobby posting, message-template proxy exports.

const {
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  AttachmentBuilder,
} = require('discord.js');
const { prisma } = require('../db');
const { requireAdmin, errorEmbed, successEmbed, formatIST, audit, extractDiscordId, sendLogEmbed, safeReply } = require('../utils');
const tpl = require('../services/scrimmsgtemplate');
const { buildLobbyEmbed, FOOTER } = require('../scrimpanels');

const TEMPLATE_NAMES = tpl.TEMPLATE_NAMES;

function line(ok, label, detail = '') {
  return `${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`;
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(header, rows) {
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
}

function stamp() {
  return new Date().toISOString().slice(0, 10);
}

function textModal(customId, title, fields) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(title);
  for (const f of fields) {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(f.id)
          .setLabel(f.label)
          .setStyle(f.style || TextInputStyle.Short)
          .setRequired(f.required !== false)
          .setValue(f.value || '')
      )
    );
  }
  return modal;
}

// ---------------------------------------------------------------- chat input

async function handleChatInput(interaction) {
  const name = interaction.commandName;
  if (name === 'message_template') return handleMessageTemplateCmd(interaction);
  if (name === 'bot_health') return handleBotHealth(interaction);
  if (name === 'export' && interaction.options.getSubcommand() === 'scrim') return handleExportScrim(interaction);
  return;
}

async function handleMessageTemplateCmd(interaction) {
  if (!(await requireAdmin(interaction))) return;
  try {
    const sub = interaction.options.getSubcommand();
    if (sub === 'list') {
      await tpl.ensureDefaultTemplates();
      const rows = await prisma.messageTemplate.findMany({ orderBy: { name: 'asc' } });
      const embed = new EmbedBuilder()
        .setColor(0x3b82f6)
        .setTitle('📝 Scrims Message Templates')
        .setDescription(
          rows.length
            ? rows.map((r) => `\`${r.name}\` — updated ${formatIST(r.updatedAt)}`).join('\n')
            : 'No templates found.'
        )
        .setFooter({ text: FOOTER });
      // Deferred-safe: the router defers /message_template before we get here.
      return safeReply(interaction, { embeds: [embed], ephemeral: true });
    }
    // set
    const tname = interaction.options.getString('name', true);
    const content = interaction.options.getString('content', true);
    if (!TEMPLATE_NAMES.includes(tname)) {
      return safeReply(interaction, { embeds: [errorEmbed(`Unknown template \`${tname}\`.`)], ephemeral: true });
    }
    await tpl.setMessageTemplate(tname, content);
    await audit('TEMPLATE_SET', interaction.user.id, tname);
    return safeReply(interaction, { embeds: [successEmbed(`Template \`${tname}\` updated.`)] , ephemeral: true });
  } catch (err) {
    console.error('[scrimadmin] message_template failed:', err.message);
    const payload = { embeds: [errorEmbed('Failed to manage templates.')], ephemeral: true };
    return safeReply(interaction, payload);
  }
}

async function handleBotHealth(interaction) {
  if (!(await requireAdmin(interaction))) return;
  // Deferred-safe: the router defers /bot_health before we get here, so we
  // never defer twice (the old second deferReply threw and killed the run).
  const checks = [];
  const client = interaction.client;

  checks.push(line(!!client.readyAt, 'Discord connection', client.readyAt ? `ready since ${client.readyAt.toISOString()}` : 'client is not ready'));

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.push(line(true, 'Database connectivity (PostgreSQL)'));
  } catch (err) {
    checks.push(line(false, 'Database connectivity', err.message));
  }

  try {
    const [verifs, openGroups, activeBans, openRegs] = await Promise.all([
      prisma.scrimsVerification.count(),
      prisma.scrimGroup.count({ where: { status: 'OPEN' } }),
      prisma.scrimsBan.count({ where: { active: true } }),
      prisma.scrimRegistration.count({ where: { status: 'ACTIVE' } }),
    ]);
    checks.push(line(true, 'ScrimsVerification rows', `${verifs}`));
    checks.push(line(true, 'OPEN ScrimGroups', `${openGroups}`));
    checks.push(line(true, 'ACTIVE ScrimRegistrations', `${openRegs}`));
    checks.push(line(true, 'Active ScrimsBans', `${activeBans}`));
  } catch (err) {
    checks.push(line(false, 'Scrims table counts', err.message));
  }

  const ocrOk = (() => {
    try {
      require.resolve('../services/ssidp-ocr');
      return true;
    } catch {
      return false;
    }
  })();
  checks.push(line(ocrOk, 'OCR engine (ssidp-ocr)', ocrOk ? 'module present' : 'not installed yet'));

  const envVars = [
    'SCRIMS_VERIFY_CHANNEL_ID',
    'SCRIMS_OQ_RESULTS_CHANNEL_ID',
    'SCRIMS_T3_RESULTS_CHANNEL_ID',
    'SCRIMS_OQ_WARN_CHANNEL_ID',
    'SCRIMS_T3_WARN_CHANNEL_ID',
    'SCRIMS_BAN_LOG_CHANNEL_ID',
    'SCRIMS_OQ_CATEGORY_ID',
    'SCRIMS_T3_CATEGORY_ID',
    'SCRIMS_SERVER_NAME',
    'MAX_ACTIVE_OQ',
    'MAX_ACTIVE_T3',
    'SLOT_WASTE_MAX_WARNINGS',
    'SLOT_WASTE_BAN_DAYS',
    'SS_IDP_DUP_MINUTES',
  ];
  const missing = envVars.filter((v) => !process.env[v]);
  checks.push(line(missing.length === 0, 'Env config', missing.length ? `missing: ${missing.join(', ')}` : `${envVars.length}/${envVars.length} set`));

  const uptimeS = Math.floor(process.uptime());
  const uptimeStr = `${Math.floor(uptimeS / 3600)}h ${Math.floor((uptimeS % 3600) / 60)}m`;
  checks.push(line(true, 'Process uptime', uptimeStr));

  const failures = checks.filter((c) => c.startsWith('❌')).length;
  const embed = new EmbedBuilder()
    .setColor(failures ? 0xed4245 : 0x57f287)
    .setTitle('🩺 Bot Health — Scrims')
    .setDescription(`${checks.join('\n')}\n\n${failures ? `⚠️ ${failures} check(s) need attention.` : '✅ All automated checks passed.'}`)
    .setFooter({ text: FOOTER })
    .setTimestamp();
  return interaction.editReply({ embeds: [embed] });
}

async function handleExportScrim(interaction) {
  if (!(await requireAdmin(interaction))) return;
  // Deferred-safe: the router defers /export scrim before we get here.
  try {
    const track = interaction.options.getString('track', true).toUpperCase();

    const verifications = await prisma.scrimsVerification.findMany({
      where: { status: 'verified' },
      orderBy: { createdAt: 'asc' },
    });

    const rows = [];
    for (const v of verifications) {
      let team = null;
      try {
        team = await prisma.team.findFirst({ where: { owner: { discordId: v.ownerDiscordId } } });
      } catch {
        team = null;
      }
      let regs = [];
      if (team) {
        regs = await prisma.scrimRegistration.findMany({
          where: { teamId: team.id, registrationType: track, status: 'ACTIVE' },
          orderBy: { createdAt: 'asc' },
        });
      }
      const groupIds = [...new Set(regs.map((r) => r.groupId))];
      const groups = groupIds.length
        ? await prisma.scrimGroup.findMany({ where: { id: { in: groupIds } } })
        : [];
      const gById = Object.fromEntries(groups.map((g) => [g.id, g]));
      const regStr = regs
        .map((r) => {
          const g = gById[r.groupId];
          return g ? `${g.groupType} G${g.groupNo} slot ${r.slotNo}` : `slot ${r.slotNo}`;
        })
        .join(' | ');

      rows.push([
        v.ownerDiscordId,
        v.teamName,
        v.ownerFullName || '',
        v.whatsappNumber || '',
        v.ownerEmail || '',
        v.city || '',
        team ? team.tag : '',
        regStr,
        formatIST(v.verifiedAt || v.createdAt),
      ]);
    }

    const header = [
      'Owner Discord ID',
      'Team Name',
      'Owner Name',
      'WhatsApp',
      'Email',
      'City',
      'Team Tag',
      `${track} Registrations`,
      'Verified At (IST)',
    ];
    // Source parity: Excel workbook (exceljs), like the source's exportService.
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(`${track} Scrims Export`);
    ws.columns = header.map((h) => ({ header: h, width: 22 }));
    ws.getRow(1).font = { bold: true };
    for (const row of rows) ws.addRow(row);
    const xlsx = await wb.xlsx.writeBuffer();
    const file = new AttachmentBuilder(Buffer.from(xlsx), {
      name: `scrims-${track.toLowerCase()}-export-${stamp()}.xlsx`,
    });
    await audit('EXPORT_SCRIMS', interaction.user.id, `${track}: ${rows.length} verified teams exported`);
    return interaction.editReply({
      content: `📄 **${rows.length}** verified team(s) — ${track} track — exported as Excel.`,
      files: [file],
    });
  } catch (err) {
    console.error('[scrimadmin] export scrim failed:', err.message);
    return interaction.editReply({ embeds: [errorEmbed('Export failed.')] });
  }
}

// ---------------------------------------------------------------- buttons

async function handleButton(interaction) {
  const id = interaction.customId;
  if (!(await requireAdmin(interaction))) return;
  try {
    if (id === 'bs:admin:lookup') {
      return interaction.showModal(
        textModal('bs:admin:lookup:modal', 'Team Lookup', [
          { id: 'query', label: 'Discord mention/ID or team name', style: TextInputStyle.Short },
        ])
      );
    }
    if (id === 'bs:admin:ban') {
      return interaction.showModal(
        textModal('bs:admin:ban:modal', 'Ban from Scrims', [
          { id: 'discord_id', label: 'Discord mention or ID' },
          { id: 'days', label: 'Ban days (0 = permanent)', value: '30' },
          { id: 'reason', label: 'Reason', style: TextInputStyle.Paragraph },
        ])
      );
    }
    if (id === 'bs:admin:unban') {
      return interaction.showModal(
        textModal('bs:admin:unban:modal', 'Unban from Scrims', [{ id: 'discord_id', label: 'Discord mention or ID' }])
      );
    }
    if (id === 'bs:admin:banlist') return handleBanList(interaction);
    if (id === 'bs:admin:delteam') {
      return interaction.showModal(
        textModal('bs:admin:delteam:modal', 'Delete Team (scrims data)', [
          { id: 'tag', label: 'Team tag (exact)' },
        ])
      );
    }
    if (id === 'bs:admin:restoreteam') return handleRestoreTeamMenu(interaction);
    if (id === 'bs:tpl:list') return handleTemplateList(interaction);
    if (id.startsWith('bs:tpl:set:')) {
      const tname = id.slice('bs:tpl:set:'.length);
      return showTemplateSetModal(interaction, tname);
    }
    if (id === 'bs:lobby:refresh') {
      const n = await refreshAllLobbyPanels(interaction.client);
      return interaction.reply({ embeds: [successEmbed(`Refreshed ${n} live lobby panel(s).`)], ephemeral: true });
    }
  } catch (err) {
    console.error('[scrimadmin] button failed:', err.message);
    const payload = { embeds: [errorEmbed('Action failed.')], ephemeral: true };
    if (interaction.replied || interaction.deferred) return interaction.followUp(payload);
    return interaction.reply(payload);
  }
}

// ---------------------------------------------------------------- modals

async function handleModal(interaction) {
  const id = interaction.customId;
  if (!(await requireAdmin(interaction))) return;
  try {
    if (id === 'bs:admin:lookup:modal') return handleLookupModal(interaction);
    if (id === 'bs:admin:ban:modal') return handleBanModal(interaction);
    if (id === 'bs:admin:unban:modal') return handleUnbanModal(interaction);
    if (id === 'bs:admin:delteam:modal') return handleDeleteTeamModal(interaction);
    if (id.startsWith('bs:tpl:set:modal:')) {
      const tname = id.slice('bs:tpl:set:modal:'.length);
      return handleTemplateSetModal(interaction, tname);
    }
  } catch (err) {
    console.error('[scrimadmin] modal failed:', err.message);
    const payload = { embeds: [errorEmbed('Action failed.')], ephemeral: true };
    if (interaction.replied || interaction.deferred) return interaction.followUp(payload);
    return interaction.reply(payload);
  }
}

/** Count players in a verification playersJson; '?' when corrupt. */
function safePlayerCount(playersJson) {
  try {
    const arr = JSON.parse(playersJson || '[]');
    return Array.isArray(arr) ? arr.length : '?';
  } catch {
    return '?';
  }
}

async function handleLookupModal(interaction) {
  const query = interaction.fields.getTextInputValue('query').trim();
  const did = extractDiscordId(query);
  if (did === false) {
    return interaction.reply({ embeds: [errorEmbed('Invalid Discord ID or team name.')], ephemeral: true });
  }
  const ver = did
    ? await prisma.scrimsVerification.findUnique({ where: { ownerDiscordId: did } })
    : await prisma.scrimsVerification.findFirst({
        where: { teamName: { contains: query, mode: 'insensitive' } },
      });
  if (!ver) {
    return interaction.reply({ embeds: [errorEmbed('No verification record found.')], ephemeral: true });
  }

  const team = await prisma.team
    .findFirst({ where: { owner: { discordId: ver.ownerDiscordId } } })
    .catch(() => null);

  let regLines = '—';
  let warnLines = '—';
  if (team) {
    const regs = await prisma.scrimRegistration.findMany({
      where: { teamId: team.id },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    const groupIds = [...new Set(regs.map((r) => r.groupId))];
    const groups = groupIds.length
      ? await prisma.scrimGroup.findMany({ where: { id: { in: groupIds } } })
      : [];
    const gById = Object.fromEntries(groups.map((g) => [g.id, g]));
    regLines = regs.length
      ? regs
          .map((r) => {
            const g = gById[r.groupId];
            const lbl = g ? `${g.groupType} G${g.groupNo}` : 'group?';
            return `${lbl} slot ${r.slotNo} — ${r.status}`;
          })
          .join('\n')
      : 'No registrations.';
    const warn = await prisma.slotWarningCount.findUnique({ where: { teamId: team.id } }).catch(() => null);
    warnLines = warn ? `${warn.count} warning(s)` : '0 warnings';
  }

  const bans = await prisma.scrimsBan.findMany({ where: { discordId: ver.ownerDiscordId, active: true } });
  const banLines = bans.length
    ? bans.map((b) => `⛔ expires ${b.expiresAt ? formatIST(b.expiresAt) : 'PERMANENT'} — ${b.reason || 'no reason'}`).join('\n')
    : 'Not banned.';

  const embed = new EmbedBuilder()
    .setColor(0x3b82f6)
    .setTitle(`🔍 Team Lookup — ${ver.teamName}`)
    .addFields(
      {
        name: 'Verification',
        value: `Owner: <@${ver.ownerDiscordId}> (${ver.ownerDiscordId})\nStatus: ${ver.status}\nVerified: ${formatIST(ver.verifiedAt || ver.createdAt)}\nPlayers: ${safePlayerCount(ver.playersJson)}`,
      },
      {
        name: 'Target Team',
        value: team ? `**${team.name}** [\`${team.tag}\`] — Team ID \`${team.teamId}\`` : 'No linked target team.',
      },
      { name: 'Registrations (latest 10)', value: regLines.slice(0, 1000) },
      { name: 'Slot warnings', value: warnLines },
      { name: 'Ban status', value: banLines.slice(0, 1000) }
    )
    .setFooter({ text: FOOTER });
  return interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleBanModal(interaction) {
  const discordInput = interaction.fields.getTextInputValue('discord_id').trim();
  const daysRaw = interaction.fields.getTextInputValue('days').trim();
  const reason = interaction.fields.getTextInputValue('reason').trim();
  const discordId = extractDiscordId(discordInput);
  if (!discordId) {
    return interaction.reply({ embeds: [errorEmbed('Invalid Discord ID.')], ephemeral: true });
  }
  const days = parseInt(daysRaw, 10);
  const expiresAt = Number.isFinite(days) && days > 0 ? new Date(Date.now() + days * 86400000) : null;

  await prisma.scrimsBan.updateMany({ where: { discordId, active: true }, data: { active: false } });
  await prisma.scrimsBan.create({
    data: { discordId, reason: reason || null, expiresAt, bannedBy: interaction.user.id, active: true },
  });

  const logChannel = process.env.SCRIMS_BAN_LOG_CHANNEL_ID;
  if (logChannel) {
    await sendLogEmbed(
      interaction.client,
      interaction.guildId,
      logChannel,
      new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('⛔ Scrims Ban')
        .setDescription(
          `**User:** <@${discordId}> (${discordId})\n**By:** <@${interaction.user.id}>\n**Duration:** ${expiresAt ? `${days} day(s)` : 'PERMANENT'}\n**Reason:** ${reason || '—'}`
        )
        .setTimestamp()
    );
  }
  await audit('SCRIMS_BAN', interaction.user.id, `${discordId} ${expiresAt ? days + 'd' : 'permanent'} — ${reason || 'no reason'}`);
  return interaction.reply({
    embeds: [successEmbed(`<@${discordId}> banned ${expiresAt ? `for ${days} day(s)` : 'permanently'}.`)],
    ephemeral: true,
  });
}

async function handleUnbanModal(interaction) {
  const discordInput = interaction.fields.getTextInputValue('discord_id').trim();
  const discordId = extractDiscordId(discordInput);
  if (!discordId) {
    return interaction.reply({ embeds: [errorEmbed('Invalid Discord ID.')], ephemeral: true });
  }
  const res = await prisma.scrimsBan.updateMany({ where: { discordId, active: true }, data: { active: false } });
  await audit('SCRIMS_UNBAN', interaction.user.id, `${discordId} — ${res.count} ban(s) lifted`);
  return interaction.reply({
    embeds: [successEmbed(res.count ? `<@${discordId}> unbanned (${res.count}).` : `<@${discordId}> had no active bans.`)],
    ephemeral: true,
  });
}

async function handleBanList(interaction) {
  // Sweep expired bans first so stale rows don't show as active.
  await prisma.scrimsBan.updateMany({
    where: { active: true, expiresAt: { lt: new Date() } },
    data: { active: false },
  }).catch(() => {});
  const bans = await prisma.scrimsBan.findMany({
    where: { active: true, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    orderBy: [{ expiresAt: 'asc' }],
    take: 25,
  });
  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('📋 Active Scrims Bans')
    .setDescription(
      bans.length
        ? bans
            .map(
              (b) =>
                `<@${b.discordId}> (${b.discordId}) — expires ${b.expiresAt ? formatIST(b.expiresAt) : 'PERMANENT'}\nReason: ${b.reason || '—'} · by <@${b.bannedBy}>`
            )
            .join('\n\n')
        : 'No active bans.'
    )
    .setFooter({ text: FOOTER });
  return interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleDeleteTeamModal(interaction) {
  const tag = interaction.fields.getTextInputValue('tag').trim().toUpperCase();
  const team = await prisma.team
    .findFirst({ where: { tag }, include: { owner: true } })
    .catch(() => null);
  if (!team) {
    return interaction.reply({ embeds: [errorEmbed(`Team with tag \`${tag}\` not found.`)], ephemeral: true });
  }
  const ownerDiscordId = team.owner?.discordId || null;

  const ver = ownerDiscordId
    ? await prisma.scrimsVerification.findUnique({ where: { ownerDiscordId } }).catch(() => null)
    : null;
  const registrations = await prisma.scrimRegistration.findMany({ where: { teamId: team.id } });
  const slots = await prisma.scrimSlot.findMany({ where: { teamId: team.id } });
  const warningCount = await prisma.slotWarningCount.findUnique({ where: { teamId: team.id } }).catch(() => null);
  const warningLog = await prisma.slotWarningLog.findMany({ where: { teamId: team.id } }).catch(() => []);

  const backupJson = JSON.stringify({
    verification: ver,
    teamDbId: team.id,
    teamTag: team.tag,
    teamName: team.name,
    ownerDiscordId,
    registrations,
    slots,
    warningCount,
    warningLog,
    deletedAt: new Date().toISOString(),
    deletedBy: interaction.user.id,
  });

  await prisma.deletedTeamBackup.create({
    data: { ownerDiscordId: ownerDiscordId || 'unknown', teamName: team.name, backupJson },
  });

  // Delete the team's Scrim* rows only — the target Team itself is NOT touched.
  // Slots are FREED (teamId cleared, status EMPTY), not deleted, so groups
  // keep their 21 slots; restore re-fills the freed rows from the backup.
  const freedGroupIds = [...new Set(slots.map((s) => s.groupId))];
  await prisma.scrimRegistration.deleteMany({ where: { teamId: team.id } });
  await prisma.scrimSlot.updateMany({
    where: { teamId: team.id },
    data: { teamId: null, status: 'EMPTY' },
  });
  await prisma.slotWarningCount.deleteMany({ where: { teamId: team.id } });
  await prisma.slotWarningLog.deleteMany({ where: { teamId: team.id } });
  if (ownerDiscordId) {
    await prisma.scrimsVerification.deleteMany({ where: { ownerDiscordId } }).catch(() => {});
  }
  // The freed slots may have vacancy subscribers.
  for (const gid of freedGroupIds) {
    try {
      require('./scrimidp').notifyVacancy(gid, interaction.client).catch(() => {});
    } catch {}
  }

  await audit('SCRIMS_DELTEAM', interaction.user.id, `${team.name} [${team.tag}] — ${registrations.length} regs, ${slots.length} slots backed up`);
  return interaction.reply({
    embeds: [successEmbed(`**${team.name}** [\`${team.tag}\`] scrims data deleted and backed up (${registrations.length} registrations, ${slots.length} slots). Target Team row untouched.`)],
    ephemeral: true,
  });
}

async function handleRestoreTeamMenu(interaction) {
  const backups = await prisma.deletedTeamBackup.findMany({
    where: { restored: false },
    orderBy: { createdAt: 'desc' },
    take: 25,
  });
  if (!backups.length) {
    return interaction.reply({ embeds: [errorEmbed('No unrestored team backups found.')], ephemeral: true });
  }
  const select = new StringSelectMenuBuilder()
    .setCustomId('bs:admin:restoreteam:select')
    .setPlaceholder('Select a deleted team backup to restore')
    .addOptions(
      backups.map((b) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(b.teamName.slice(0, 100))
          .setValue(b.id)
          .setDescription(`Deleted ${formatIST(b.createdAt)}`.slice(0, 100))
      )
    );
  return interaction.reply({
    content: '♻️ **Restore a deleted team** — pick a backup:',
    components: [new ActionRowBuilder().addComponents(select)],
    ephemeral: true,
  });
}

async function handleRestoreSelect(interaction) {
  if (!(await requireAdmin(interaction))) return;
  try {
    const backupId = interaction.values[0];
    const backup = await prisma.deletedTeamBackup.findUnique({ where: { id: backupId } });
    if (!backup || backup.restored) {
      return interaction.reply({ embeds: [errorEmbed('Backup not found or already restored.')], ephemeral: true });
    }
    const data = JSON.parse(backup.backupJson);
    const teamId = data.teamDbId;

    if (data.verification && data.ownerDiscordId && data.ownerDiscordId !== 'unknown') {
      const exists = await prisma.scrimsVerification.findUnique({ where: { ownerDiscordId: data.ownerDiscordId } }).catch(() => null);
      if (!exists) {
        const v = data.verification;
        await prisma.scrimsVerification.create({
          data: {
            ownerDiscordId: v.ownerDiscordId,
            teamName: v.teamName,
            ownerFullName: v.ownerFullName,
            whatsappNumber: v.whatsappNumber,
            ownerEmail: v.ownerEmail,
            city: v.city,
            playersJson: v.playersJson,
            messageId: v.messageId,
            status: v.status || 'verified',
            verifiedAt: v.verifiedAt ? new Date(v.verifiedAt) : null,
          },
        }).catch(() => null);
      }
    }

    if (Array.isArray(data.registrations) && data.registrations.length) {
      const regs = data.registrations.map((r) => ({
        teamId,
        groupId: r.groupId,
        slotNo: r.slotNo,
        registrationType: r.registrationType,
        status: r.status,
        registeredBy: r.registeredBy,
      }));
      await prisma.scrimRegistration.createMany({ data: regs, skipDuplicates: true }).catch(() => null);
    }

    if (Array.isArray(data.slots) && data.slots.length) {
      for (const s of data.slots) {
        try {
          const existing = await prisma.scrimSlot.findUnique({
            where: { groupId_slotNo: { groupId: s.groupId, slotNo: s.slotNo } },
          });
          if (!existing) {
            await prisma.scrimSlot.create({ data: { groupId: s.groupId, slotNo: s.slotNo, teamId, status: 'FILLED' } });
          } else if (existing.status === 'EMPTY') {
            await prisma.scrimSlot.update({ where: { id: existing.id }, data: { teamId, status: 'FILLED' } });
          }
        } catch (err) {
          console.error('[scrimadmin] restore slot failed:', err.message);
        }
      }
    }

    if (data.warningCount) {
      await prisma.slotWarningCount.upsert({
        where: { teamId },
        update: { count: data.warningCount.count },
        create: { teamId, count: data.warningCount.count },
      }).catch(() => null);
    }

    await prisma.deletedTeamBackup.update({ where: { id: backup.id }, data: { restored: true } });
    await audit('SCRIMS_RESTORETEAM', interaction.user.id, `${data.teamName} [${data.teamTag}] restored`);
    return interaction.reply({
      embeds: [successEmbed(`**${data.teamName}** [\`${data.teamTag}\`] restored (${data.registrations?.length || 0} registrations, ${data.slots?.length || 0} slots).`)],
      ephemeral: true,
    });
  } catch (err) {
    console.error('[scrimadmin] restore select failed:', err.message);
    return interaction.reply({ embeds: [errorEmbed('Restore failed.')], ephemeral: true });
  }
}

async function handleTemplateList(interaction) {
  await tpl.ensureDefaultTemplates();
  const rows = await prisma.messageTemplate.findMany({ orderBy: { name: 'asc' } });
  const embed = new EmbedBuilder()
    .setColor(0x3b82f6)
    .setTitle('📝 Scrims Message Templates')
    .setDescription(
      rows.length
        ? rows.map((r) => `\`${r.name}\` — updated ${formatIST(r.updatedAt)}`).join('\n')
        : 'No templates found.'
    )
    .setFooter({ text: FOOTER });
  // Per-template Edit buttons (bs:tpl:set:<name>), so the list is actionable.
  const editRow = new ActionRowBuilder().addComponents(
    TEMPLATE_NAMES.slice(0, 5).map((tname) =>
      new ButtonBuilder()
        .setCustomId(`bs:tpl:set:${tname}`)
        .setLabel(`Edit ${tname}`)
        .setStyle(ButtonStyle.Primary)
    )
  );
  return interaction.reply({ embeds: [embed], components: [editRow], ephemeral: true });
}

async function showTemplateSetModal(interaction, tname) {
  if (!TEMPLATE_NAMES.includes(tname)) {
    return interaction.reply({ embeds: [errorEmbed(`Unknown template \`${tname}\`.`)], ephemeral: true });
  }
  const current = (await tpl.getMessageTemplate(tname)) || '';
  return interaction.showModal(
    textModal(`bs:tpl:set:modal:${tname}`, `Edit ${tname}`, [
      { id: 'content', label: 'Template content ({{placeholders}})', style: TextInputStyle.Paragraph, value: current.slice(0, 4000) },
    ])
  );
}

async function handleTemplateSetModal(interaction, tname) {
  if (!TEMPLATE_NAMES.includes(tname)) {
    return interaction.reply({ embeds: [errorEmbed(`Unknown template \`${tname}\`.`)], ephemeral: true });
  }
  const content = interaction.fields.getTextInputValue('content');
  await tpl.setMessageTemplate(tname, content);
  await audit('TEMPLATE_SET', interaction.user.id, tname);
  return interaction.reply({ embeds: [successEmbed(`Template \`${tname}\` updated.`)], ephemeral: true });
}

// ---------------------------------------------------------------- lobby

/** Refresh every active live lobby panel in place; deactivates dead ones. Returns refresh count. */
async function refreshAllLobbyPanels(client) {
  let refreshed = 0;
  let panels = [];
  try {
    panels = await prisma.liveLobbyPanel.findMany({ where: { active: true } });
  } catch (err) {
    console.error('[lobby] fetch panels failed:', err.message);
    return 0;
  }
  for (const panel of panels) {
    try {
      const embed = await buildLobbyEmbed(panel.panelType);
      const channel = await client.channels.fetch(panel.channelId).catch(() => null);
      const msg = channel ? await channel.messages.fetch(panel.messageId).catch(() => null) : null;
      if (!msg) {
        await prisma.liveLobbyPanel.update({ where: { id: panel.id }, data: { active: false } }).catch(() => null);
        continue;
      }
      await msg.edit({ embeds: [embed] });
      refreshed++;
    } catch (err) {
      console.error('[lobby] refresh failed for panel', panel.id, err.message);
    }
  }
  return refreshed;
}

function startLobbyScheduler(client) {
  setInterval(() => {
    refreshAllLobbyPanels(client).catch((err) => console.error('[lobby] scheduler failed:', err.message));
  }, 120000);
  console.log('[lobby] scheduler started (120s)');
}

/** Post a new live lobby panel in the interaction's channel. panelType: "OQ"|"T3"|"ALL". */
async function postLobbyPanel(interaction, panelType = 'ALL') {
  const type = ['OQ', 'T3'].includes(String(panelType).toUpperCase())
    ? String(panelType).toUpperCase()
    : 'ALL';
  const embed = await buildLobbyEmbed(type);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('bs:lobby:refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary).setEmoji('🔄')
  );
  const msg = await interaction.channel.send({ embeds: [embed], components: [row] });
  await prisma.liveLobbyPanel.create({
    data: {
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      messageId: msg.id,
      panelType: type,
      active: true,
      createdBy: interaction.user.id,
    },
  });
  return msg;
}

// ---------------------------------------------------------------- router

async function handle(interaction) {
  try {
    if (interaction.isChatInputCommand()) return handleChatInput(interaction);
    const id = interaction.customId || '';

    if (interaction.isModalSubmit()) return handleModal(interaction);

    if (interaction.isStringSelectMenu()) {
      if (id === 'bs:admin:restoreteam:select') return handleRestoreSelect(interaction);
      return;
    }

    if (!id.startsWith('bs:')) return;
    if (
      id.startsWith('bs:admin:') ||
      id.startsWith('bs:tpl:') ||
      id === 'bs:lobby:refresh'
    ) {
      return handleButton(interaction);
    }
  } catch (err) {
    console.error('[scrimadmin] handle failed:', err.message);
    try {
      const payload = { embeds: [errorEmbed('Something went wrong.')], ephemeral: true };
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
      else await interaction.reply(payload);
    } catch {
      // ignore
    }
  }
}

module.exports = {
  handle,
  startLobbyScheduler,
  postLobbyPanel,
  refreshAllLobbyPanels,
  ensureDefaultTemplates: tpl.ensureDefaultTemplates,
  getMessageTemplate: tpl.getMessageTemplate,
  renderTemplate: tpl.renderTemplate,
  _test: { render: tpl._test.render },
};
