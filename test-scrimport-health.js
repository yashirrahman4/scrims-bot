/**
 * scrimport-6 tests: health monitor (heartbeat + DB keepalive) and the
 * interaction watchdog.
 *
 * Covers:
 *  - withTimeout resolves fast promises and rejects slow ones (no hang)
 *  - dbPing returns false (never throws) when the DB is unreachable
 *  - startHealthMonitor starts, logs, and returns a working stopper
 *  - watchInteraction passes through resolution values and rejections,
 *    and never interferes with the wrapped promise
 *  - index.js wires the health monitor on ClientReady and the watchdog on
 *    every interaction
 *
 * No Discord connection needed. DB tests expect NO usable DATABASE_URL
 * (dbPing must fail fast-ish and return false, not throw).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0;
function ok(name, cond) {
  if (!cond) {
    console.error('FAIL:', name);
    process.exitCode = 1;
    return;
  }
  passed++;
}

(async () => {
  const health = require('./src/health');

  // withTimeout: fast promise wins
  const fast = await health.withTimeout(new Promise((r) => setTimeout(() => r('x'), 20)), 1000, 't');
  ok('withTimeout resolves fast promise', fast === 'x');

  // withTimeout: slow promise loses
  let timedOut = false;
  try {
    await health.withTimeout(new Promise(() => {}), 50, 'slowop');
  } catch (e) {
    timedOut = /timed out/.test(e.message);
  }
  ok('withTimeout rejects a never-settling promise', timedOut);

  // dbPing: no DATABASE_URL here -> must return false, not throw
  const t0 = Date.now();
  const ping = await health.dbPing();
  ok('dbPing returns false without a DB (never throws)', ping === false);
  ok('dbPing bounded by timeout', Date.now() - t0 < 30000);

  // startHealthMonitor: starts, logs, stopper works
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  let stop;
  try {
    stop = health.startHealthMonitor();
  } finally {
    console.log = origLog;
  }
  ok('startHealthMonitor returns a stopper', typeof stop === 'function');
  ok('startHealthMonitor logs startup', logs.some((l) => l.includes('[health] monitor started')));
  stop();
  ok('stopper clears intervals without throwing', true);

  // watchInteraction: passthrough of values
  const fakeFast = { isChatInputCommand: () => true, commandName: 'ping', user: { id: '1' } };
  const v = await health.watchInteraction(fakeFast, Promise.resolve(42));
  ok('watchInteraction passes through resolved value', v === 42);

  // watchInteraction: passthrough of rejections
  let rejected = false;
  try {
    await health.watchInteraction(fakeFast, Promise.reject(new Error('boom')));
  } catch (e) {
    rejected = e.message === 'boom';
  }
  ok('watchInteraction passes through rejection', rejected);

  // watchInteraction: works for button-style interactions (customId)
  const fakeBtn = { isChatInputCommand: () => false, customId: 'bs:panel:x', user: { id: '2' }, type: 3 };
  const bv = await health.watchInteraction(fakeBtn, Promise.resolve('ok'));
  ok('watchInteraction handles button interactions', bv === 'ok');

  // index.js wiring
  const idx = read('src/index.js');
  ok('index starts health monitor on ready', idx.includes("require('./health').startHealthMonitor()"));
  ok('index wraps interactions with watchdog', idx.includes('watchInteraction(interaction, handleInteraction(interaction))'));

  console.log(`\n${passed} passed`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
