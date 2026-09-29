/**
 * scrimport-1 tests: group lifecycle pure helpers (slotRangeOk,
 * startAtFromIdp) and graceful degradation of renderSlotList when the
 * DB is unreachable (no deep prisma mocking).
 * No Discord connection needed.
 */
const assert = require('node:assert/strict');
const groups = require('./src/flows/scrimgroups.js');

let passed = 0;
function ok(name, cond) {
  if (!cond) {
    console.error('FAIL:', name);
    process.exitCode = 1;
  } else {
    passed++;
    console.log('ok:', name);
  }
}

const { slotRangeOk, startAtFromIdp } = groups._test;

console.log('slotRangeOk:');
ok('slot 4 rejected (below range)', slotRangeOk(4) === false);
ok('slot 5 accepted (range start)', slotRangeOk(5) === true);
ok('slot 25 accepted (range end)', slotRangeOk(25) === true);
ok('slot 26 rejected (above range)', slotRangeOk(26) === false);
ok('slot 0 rejected', slotRangeOk(0) === false);
ok('mid-range slot 12 accepted', slotRangeOk(12) === true);

console.log('startAtFromIdp:');
ok('start = IDP + 6 min', (() => {
  const idp = new Date('2026-09-30T10:00:00Z');
  const start = startAtFromIdp(idp);
  return start.getTime() - idp.getTime() === 6 * 60 * 1000;
})());
ok('returns a Date', startAtFromIdp(new Date()) instanceof Date);

console.log('renderSlotList degradation:');
(async () => {
  // Without a reachable DB this must degrade gracefully, never throw.
  const out = await groups.renderSlotList('nonexistent-group-id');
  ok('returns a string without throwing', typeof out === 'string');
  ok('degradation message is user-friendly', /unavailable|could not load/i.test(out));
  ok('exports are intact', typeof groups.createScrimGroup === 'function' && typeof groups.handle === 'function');
  console.log(`\n${passed} scrimport group tests passed.`);
})().catch((e) => {
  console.error('FAIL: renderSlotList threw:', e.message);
  process.exitCode = 1;
});
