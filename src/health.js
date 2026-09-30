/**
 * Liveness heartbeat + database keepalive.
 *
 * Two failure modes this guards against:
 *  1. Wedged event loop — the pure `[health] alive` tick does zero async work.
 *     If these lines stop appearing in the console, the Node process itself is
 *     stuck (CPU-bound work / GC hell), not just the database.
 *  2. Stale database connections (Neon) — every interaction path hits Prisma.
 *     A half-open connection makes queries hang forever, which looks exactly
 *     like "bot is thinking" on every button and slash command. The keepalive
 *     pings with a hard timeout; on failure it disconnects the pool so the
 *     next query is forced onto a fresh connection, and logs loudly.
 *
 * Nothing here throws — a broken monitor must never break the bot.
 */
const { prisma } = require('./db');

const TICK_MS = 60000;
const PING_TIMEOUT_MS = 10000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    timeout,
  ]);
}

async function dbPing() {
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, PING_TIMEOUT_MS, 'db ping');
    return true;
  } catch (err) {
    console.error('[health] DB ping failed:', err.message);
    return false;
  }
}

function startHealthMonitor() {
  // 1. Pure heartbeat — proves the event loop is turning.
  const hb = setInterval(() => {
    console.log(`[health] alive ${new Date().toISOString()}`);
  }, TICK_MS);

  // 2. DB keepalive + auto-heal.
  const ka = setInterval(async () => {
    try {
      if (await dbPing()) return;
      console.error('[health] forcing Prisma reconnect (stale pool suspected)');
      try {
        await withTimeout(prisma.$disconnect(), PING_TIMEOUT_MS, 'disconnect');
      } catch (e) {
        console.error('[health] disconnect issue:', e.message);
      }
      const ok = await dbPing();
      console.log(`[health] DB re-ping ${ok ? 'OK — pool healed' : 'STILL FAILING — check DATABASE_URL / Neon project status'}`);
    } catch (e) {
      console.error('[health] keepalive error:', e.message);
    }
  }, TICK_MS);

  console.log('[health] monitor started (60s heartbeat + DB keepalive)');
  return () => { clearInterval(hb); clearInterval(ka); };
}

/**
 * Watchdog for stuck interactions. Logs (only) when handling exceeds the
 * budget, so a future "thinking forever" leaves a console trail naming the
 * exact command/button. Never interferes with the interaction itself.
 */
function watchInteraction(interaction, promise) {
  const label = typeof interaction.isChatInputCommand === 'function' && interaction.isChatInputCommand()
    ? `/${interaction.commandName}`
    : (interaction.customId || `type:${interaction.type}`);
  const timer = setTimeout(() => {
    console.error(`[watchdog] STUCK 30s+: ${label} by ${interaction.user && interaction.user.id} — handler has not settled`);
  }, 30000);
  return Promise.resolve(promise).finally(() => clearTimeout(timer));
}

module.exports = { startHealthMonitor, watchInteraction, withTimeout, dbPing };
