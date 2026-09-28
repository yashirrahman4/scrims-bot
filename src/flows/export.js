const { AttachmentBuilder } = require('discord.js');
const { prisma } = require('../db');
const { formatIST, audit, errorEmbed } = require('../utils');

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(header, rows) {
  // BOM so Excel opens UTF-8 correctly
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
}

function playerColumns(n) {
  const cols = [];
  for (let i = 1; i <= n; i++) cols.push(`P${i} IGN`, `P${i} UID`, `P${i} Discord ID`, `P${i} Role`);
  return cols;
}

function playerCells(members, n) {
  const cells = [];
  for (let i = 0; i < n; i++) {
    const m = members[i];
    cells.push(m?.player.ign, m?.player.gameUid, m?.player.discordId, m?.role);
  }
  return cells;
}

function stamp() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * /export verified — every ACTIVE team with full roster, for Krafton India Esports submission.
 */
async function exportVerified(interaction) {
  const teams = await prisma.team.findMany({
    where: { status: 'ACTIVE' },
    include: { members: { include: { player: true }, orderBy: { joinedAt: 'asc' } }, owner: true },
    orderBy: { createdAt: 'asc' },
  });
  const maxPlayers = Math.max(1, ...teams.map((t) => t.members.length));
  const header = ['Team ID', 'Team Name', 'Team Tag', 'Owner Discord ID', 'Owner Username', 'Email', 'Phone', 'Region', ...playerColumns(maxPlayers)];
  const rows = teams.map((t) => [
    t.teamId,
    t.name,
    t.tag,
    t.owner.discordId,
    t.owner.username,
    t.email,
    t.phone,
    t.region,
    ...playerCells(t.members, maxPlayers),
  ]);
  const csv = toCsv(header, rows);
  const file = new AttachmentBuilder(Buffer.from(csv, 'utf8'), { name: `verified-teams-${stamp()}.csv` });
  await audit('EXPORT_VERIFIED', interaction.user.id, `${teams.length} teams exported`);
  return interaction.editReply({
    content: `📄 **${teams.length}** verified team(s) exported — ready for Krafton India Esports submission.`,
    files: [file],
  });
}

/**
 * /export tournament — full registration sheet for one tournament with roster details.
 */
async function exportTournament(interaction, name) {
  const event = await prisma.tournament.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
  if (!event) return interaction.editReply({ embeds: [errorEmbed(`Tournament "${name}" not found.`)] });
  const regs = await prisma.tournamentRegistration.findMany({
    where: { tournamentId: event.id, status: { not: 'REMOVED' } },
    include: {
      team: { include: { members: { include: { player: true }, orderBy: { joinedAt: 'asc' } }, owner: true } },
    },
    orderBy: { slotNo: 'asc' },
  });
  const maxPlayers = Math.max(1, ...regs.map((r) => r.team.members.length));
  const header = [
    'Slot No',
    'Group No',
    'Status',
    'Qualified',
    'Team ID',
    'Team Name',
    'Team Tag',
    'Owner Discord ID',
    'Owner Username',
    'Email',
    'Phone',
    'Registered At (IST)',
    'Tagged Discord IDs',
    ...playerColumns(maxPlayers),
  ];
  const rows = regs.map((r) => [
    r.slotNo,
    r.groupNo,
    r.status,
    r.qualified ? 'YES' : 'NO',
    r.team.teamId,
    r.team.name,
    r.team.tag,
    r.team.owner.discordId,
    r.team.owner.username,
    r.team.email,
    r.team.phone,
    formatIST(r.registeredAt),
    (r.taggedDiscordIds || []).join(' '),
    ...playerCells(r.team.members, maxPlayers),
  ]);
  const csv = toCsv(header, rows);
  const safe = event.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40) || 'tournament';
  const file = new AttachmentBuilder(Buffer.from(csv, 'utf8'), { name: `tournament-${safe}-${stamp()}.csv` });
  await audit('EXPORT_TOURNAMENT', interaction.user.id, `${event.name}: ${regs.length} registrations exported`);
  return interaction.editReply({
    content: `📄 **${regs.length}** registration(s) for **${event.name}** exported — ready for Krafton India Esports submission.`,
    files: [file],
  });
}

module.exports = { exportVerified, exportTournament, toCsv, csvCell };
