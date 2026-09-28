const { Client, GatewayIntentBits, Partials, Events } = require('discord.js');
// Health endpoint for Render free web service (must bind $PORT or deploy fails)
const http = require('http');
const port = process.env.PORT || 3000;
http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); }).listen(port);
const config = require('./config');
const { prisma } = require('./db');
const { handleInteraction } = require('./router');

// Build tag — bump when shipping a fix so the console shows which code is live.
const BUILD = '2026-09-28.regmgr-1';
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
  ],
  partials: [Partials.Channel],
});

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, (interaction) => {
  handleInteraction(interaction).catch((err) => console.error('[interaction] unhandled:', err));
});

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

async function boot() {
  try {
    // Self-heal: apply additive schema changes idempotently. HeavenCloud has no
    // shell access for `prisma migrate deploy`, so the bot ensures its own
    // columns exist on startup. Matches prisma/migrations/*_reg_panel_fields.
    for (const [col, type] of [
      ['regStartsAt', 'TIMESTAMP(3)'],
      ['regChannelId', 'TEXT'],
      ['logChannelId', 'TEXT'],
      ['successRoleId', 'TEXT'],
      ['successMessage', 'TEXT'],
    ]) {
      await prisma.$executeRawUnsafe(`ALTER TABLE "Tournament" ADD COLUMN IF NOT EXISTS "${col}" ${type}`);
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
