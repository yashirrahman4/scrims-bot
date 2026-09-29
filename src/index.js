const { Client, GatewayIntentBits, Partials, Events } = require('discord.js');
// Health endpoint for Render free web service (must bind $PORT or deploy fails)
const http = require('http');
const port = process.env.PORT || 3000;
http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); }).listen(port);
const config = require('./config');
const { prisma } = require('./db');
const { handleInteraction } = require('./router');
// Black Raven scrims port
const scrimIdp = require('./flows/scrimidp');
const scrimGroups = require('./flows/scrimgroups');
const scrimAdmin = require('./flows/scrimadmin');

// Build tag — bump when shipping a fix so the console shows which code is live.
const BUILD = '2026-09-30.scrimport-1';
console.log(`🤖 scrims-bot ${BUILD} starting...`);

if (!config.token) {
  console.error('❌ Missing DISCORD_TOKEN in environment (.env).');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('❌ Missing DATABASE_URL in environment (.env). The bot cannot work without the database.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    // Needed for the BR scrims SS-IDP screenshot intake.
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  // One-time sweep: replace legacy two-panel slot-manager messages with the single panel.
  const { reconcileLegacySlotPanels } = require('./flows/slotmanager');
  reconcileLegacySlotPanels(c).catch((e) => console.error('[slotmanager] startup sweep failed:', e.message));
  // Black Raven scrims port: seed templates + start schedulers.
  scrimAdmin.ensureDefaultTemplates().catch((e) => console.error('[scrims] templates:', e.message));
  try { scrimGroups.startCleanupScheduler(c); } catch (e) { console.error('[scrims] cleanup scheduler:', e.message); }
  try { scrimIdp.startIdpScheduler(c); } catch (e) { console.error('[scrims] idp scheduler:', e.message); }
  try { scrimAdmin.startLobbyScheduler(c); } catch (e) { console.error('[scrims] lobby scheduler:', e.message); }
});

client.on(Events.InteractionCreate, (interaction) => {
  handleInteraction(interaction).catch((err) => console.error('[interaction] unhandled:', err));
});

// Black Raven scrims port: screenshot intake for SS-IDP OCR.
client.on(Events.MessageCreate, (message) => {
  scrimIdp.handleIdpImageMessage(message, client).catch((err) => console.error('[scrimidp] image hook:', err.message));
});

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

async function boot() {
  try {
    // Self-heal: apply additive schema changes idempotently. HeavenCloud has no
    // shell access for `prisma migrate deploy`, so the bot ensures its own
    // columns exist on startup. Matches prisma/migrations/*_reg_panel_fields.
    for (const [table, col, type] of [
      ['Tournament', 'regStartsAt', 'TIMESTAMP(3)'],
      ['Tournament', 'regChannelId', 'TEXT'],
      ['Tournament', 'logChannelId', 'TEXT'],
      ['Tournament', 'successRoleId', 'TEXT'],
      ['Tournament', 'successMessage', 'TEXT'],
      ['Tournament', 'pingRoleId', 'TEXT'],
      ['Tournament', 'posterUrl', 'TEXT'],
      ['User', 'dmOptOut', 'BOOLEAN NOT NULL DEFAULT false'],
      ['Tournament', 'tagsRequired', 'INTEGER NOT NULL DEFAULT 4'],
      ['Tournament', 'teamsPerGroup', 'INTEGER'],
      ['Tournament', 'idpCategoryId', 'TEXT'],
      ['Tournament', 'idpNamePattern', 'TEXT'],
      ['Tournament', 'slotManagerChannelId', 'TEXT'],
      ['Tournament', 'slotManagerPanelMsgId', 'TEXT'],
      ['IdpGroup', 'roleId', 'TEXT'],
      ['TournamentRegistration', 'taggedDiscordIds', `TEXT[] NOT NULL DEFAULT '{}'`],
      ['TournamentRegistration', 'qualified', 'BOOLEAN NOT NULL DEFAULT false'],
      ['GuildSettings', 'logTeamVerify', 'TEXT'],
      ['GuildSettings', 'logTourneyReg', 'TEXT'],
      ['GuildSettings', 'logScrimReg', 'TEXT'],
      ['GuildSettings', 'logAdminActivity', 'TEXT'],
    ]) {
      await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${col}" ${type}`);
    }
    // IdpGroup / IdpMatch tables (matches prisma/migrations/*_logs_idp_fields)
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "IdpGroup" (
      "id" TEXT NOT NULL, "tournamentId" TEXT NOT NULL, "groupNo" INTEGER NOT NULL,
      "channelId" TEXT NOT NULL, "categoryId" TEXT, "panelMsgId" TEXT,
      "locked" BOOLEAN NOT NULL DEFAULT true, "matchesDate" TIMESTAMP(3),
      "totalMatches" INTEGER NOT NULL DEFAULT 1, "idpRoleHolderId" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "IdpGroup_pkey" PRIMARY KEY ("id"))`);
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "IdpGroup_channelId_key" ON "IdpGroup"("channelId")`);
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "IdpGroup_tournamentId_groupNo_key" ON "IdpGroup"("tournamentId", "groupNo")`);
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "IdpMatch" (
      "id" TEXT NOT NULL, "idpGroupId" TEXT NOT NULL, "matchNo" INTEGER NOT NULL,
      "map" TEXT, "idpAt" TEXT, "startAt" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "IdpMatch_pkey" PRIMARY KEY ("id"))`);
    // Older DBs created "map" as NOT NULL — matches are designed to allow "not revealed yet".
    await prisma.$executeRawUnsafe(`ALTER TABLE "IdpMatch" ALTER COLUMN "map" DROP NOT NULL`);
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "IdpMatch_idpGroupId_matchNo_key" ON "IdpMatch"("idpGroupId", "matchNo")`);
    // Black Raven scrims port: new tables are purely additive; the bot ensures
    // them on startup the same way (HeavenCloud has no shell for migrate deploy).
    const { selfHealColumns, selfHealTables } = require('./scrimselfheal');
    for (const [table, col, type] of selfHealColumns) {
      await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${col}" ${type}`);
    }
    for (const sql of selfHealTables) {
      await prisma.$executeRawUnsafe(sql);
    }
    console.log('✅ Database schema up to date');
    await prisma.$queryRaw`SELECT 1`;
    console.log('✅ Database connected');
  } catch (err) {
    console.error('❌ Database connection failed:', err.message);
    console.error('   Check DATABASE_URL — it must be the pooled Neon connection string.');
    process.exit(1);
  }
  await client.login(config.token);
}

boot();
