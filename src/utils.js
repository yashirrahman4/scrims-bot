const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { prisma } = require('./db');
const config = require('./config');

// ---------- Settings ----------

async function getSettings(guildId) {
  let settings = await prisma.guildSettings.findUnique({ where: { guildId } });
  if (!settings) {
    settings = await prisma.guildSettings.create({
      data: {
        guildId,
        maps: config.defaultMaps,
        teamSize: config.defaultTeamSize,
        maxSubs: config.defaultMaxSubs,
        teamIdPrefix: config.teamIdPrefix,
        adminRoleIds: [],
      },
    });
  }
  return settings;
}

// ---------- Permissions ----------

async function isAdmin(interaction) {
  const member = interaction.member;
  if (!member || !interaction.guild) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const settings = await getSettings(interaction.guildId);
  if (!settings.adminRoleIds.length) return false;
  return member.roles.cache.some((role) => settings.adminRoleIds.includes(role.id));
}

/** Replies with an error embed and returns false when the user is not an admin. */
async function requireAdmin(interaction) {
  if (!(await isAdmin(interaction))) {
    const reply = { embeds: [errorEmbed('Only admins can use this.')], ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.followUp(reply);
    else await interaction.reply(reply);
    return false;
  }
  return true;
}

// ---------- Validation ----------

/** BGMI UID: numeric, 5–12 digits. */
const isValidUid = (uid) => /^\d{5,12}$/.test((uid || '').trim());
/** In-game name: 3–16 chars, letters/numbers/spaces/underscore. */
const isValidIgn = (ign) => /^[A-Za-z0-9_ ]{3,16}$/.test((ign || '').trim());
/** Team tag: 2–6 alphanumeric chars, no spaces. */
const isValidTag = (tag) => /^[A-Za-z0-9]{2,6}$/.test((tag || '').trim());

/**
 * Extract a Discord user id from a mention (<@123>) or raw id.
 * Returns string id, null when empty, false when invalid format.
 */
function extractDiscordId(input) {
  const t = (input || '').trim();
  if (!t) return null;
  const m = t.match(/^<@!?(\d+)>$/);
  const id = m ? m[1] : t;
  return /^\d{17,20}$/.test(id) ? id : false;
}

/** Parse "YYYY-MM-DD HH:MM" as IST -> Date (UTC). Returns null when invalid. */
function parseDateTimeIST(input) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec((input || '').trim());
  if (!m) return null;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  const h = +m[4];
  const mi = +m[5];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d, h - 5, mi - 30)); // IST = UTC+5:30
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/** Format a Date as "YYYY-MM-DD HH:MM IST". */
function formatIST(date) {
  if (!date) return '—';
  const ist = new Date(date.getTime() + 5.5 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${ist.getUTCFullYear()}-${p(ist.getUTCMonth() + 1)}-${p(ist.getUTCDate())} ${p(ist.getUTCHours())}:${p(ist.getUTCMinutes())} IST`;
}

// ---------- Team ID ----------

function randomFrom(chars, len) {
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/** Generate a unique Team ID like BR_OQ-G10. */
async function generateTeamId(prefix) {
  const clean = ((prefix || 'BR').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'BR');
  for (let i = 0; i < 25; i++) {
    const id =
      `${clean}_${randomFrom('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 2)}-` +
      `${randomFrom('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 1)}${randomFrom('0123456789', 2)}`;
    const exists = await prisma.team.findUnique({ where: { teamId: id } });
    if (!exists) return id;
  }
  throw new Error('Failed to generate a unique Team ID');
}

// ---------- DB helpers ----------

async function getOrCreateUser(discordUser) {
  const username = discordUser.username ?? 'unknown';
  return prisma.user.upsert({
    where: { discordId: discordUser.id },
    update: { username },
    create: { discordId: discordUser.id, username },
  });
}

const teamInclude = {
  members: { include: { player: true }, orderBy: { joinedAt: 'asc' } },
  owner: true,
};

async function getOwnedTeam(dbUserId) {
  return prisma.team.findFirst({
    where: { ownerId: dbUserId, status: { in: ['ACTIVE', 'SUSPENDED'] } },
    include: teamInclude,
  });
}

/** Returns { team, relation } where relation is OWNER/PLAYER/SUB, for any team the user belongs to. */
async function getAnyTeamFor(discordId, dbUserId) {
  const owned = await getOwnedTeam(dbUserId);
  if (owned) return { team: owned, relation: 'OWNER' };
  const membership = await prisma.teamMember.findFirst({
    where: { player: { discordId }, team: { status: { in: ['ACTIVE', 'SUSPENDED'] } } },
    include: { team: { include: teamInclude } },
  });
  if (membership) return { team: membership.team, relation: membership.role };
  return { team: null, relation: null };
}

function starterCount(team) {
  return team.members.filter((m) => m.role === 'PLAYER').length;
}

// ---------- Embeds ----------

const errorEmbed = (msg) =>
  new EmbedBuilder().setColor(0xed4245).setDescription(`❌ ${msg}`);

const successEmbed = (msg) =>
  new EmbedBuilder().setColor(0x57f287).setDescription(`✅ ${msg}`);

function rosterLines(team) {
  const emoji = { OWNER: '👑', PLAYER: '🎮', SUB: '🔄' };
  return team.members.map(
    (m) =>
      `${emoji[m.role] || '•'} **${m.player.ign}** — UID \`${m.player.gameUid}\`` +
      (m.player.discordId ? ` — <@${m.player.discordId}>` : '')
  );
}

// ---------- Audit ----------

async function audit(action, userId, details) {
  try {
    await prisma.auditLog.create({
      data: { action, userId: String(userId), details: details ? String(details).slice(0, 2000) : null },
    });
  } catch (err) {
    console.error('[audit] failed:', err.message);
  }
}

module.exports = {
  getSettings,
  isAdmin,
  requireAdmin,
  isValidUid,
  isValidIgn,
  isValidTag,
  extractDiscordId,
  parseDateTimeIST,
  formatIST,
  generateTeamId,
  getOrCreateUser,
  getOwnedTeam,
  getAnyTeamFor,
  starterCount,
  teamInclude,
  errorEmbed,
  successEmbed,
  rosterLines,
  audit,
};
