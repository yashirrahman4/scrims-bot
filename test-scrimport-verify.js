/**
 * scrimport-1 tests: verification + registration pure helpers
 * (lowestFreeSlot, registrationOpen, rosterFromTeam) and the DB-backed
 * ScrimFormSession round-trip (skipped cleanly when no DB is reachable).
 * No Discord connection needed.
 */
const assert = require('node:assert/strict');
const scrims = require('./src/flows/scrims.js');

let passed = 0;
let skipped = 0;
function ok(name, cond) {
  if (!cond) {
    console.error('FAIL:', name);
    process.exitCode = 1;
  } else {
    passed++;
    console.log('ok:', name);
  }
}
function skip(name, reason) {
  skipped++;
  console.log(`skip: ${name} (${reason})`);
}

const { lowestFreeSlot, registrationOpen, rosterFromTeam } = scrims._test;

console.log('lowestFreeSlot:');
ok('empty slot list -> slot 5', lowestFreeSlot([]) === 5);
ok('null input -> slot 5', lowestFreeSlot(null) === 5);
ok('first EMPTY after FILLED ones', lowestFreeSlot([
  { slotNo: 5, status: 'FILLED' },
  { slotNo: 6, status: 'EMPTY' },
]) === 6);
ok('REMOVED counts as taken (skipped)', lowestFreeSlot([
  { slotNo: 5, status: 'REMOVED' },
  { slotNo: 6, status: 'EMPTY' },
]) === 6);
ok('FILLED skipped, gap found', lowestFreeSlot([
  { slotNo: 5, status: 'FILLED' },
  { slotNo: 7, status: 'FILLED' },
]) === 6);
ok('range stays within 5-25', lowestFreeSlot(
  Array.from({ length: 21 }, (_, i) => ({ slotNo: 5 + i, status: 'FILLED' })).concat([{ slotNo: 26, status: 'EMPTY' }])
) === null);
ok('full 5-25 -> null', lowestFreeSlot(
  Array.from({ length: 21 }, (_, i) => ({ slotNo: 5 + i, status: 'FILLED' }))
) === null);

console.log('registrationOpen:');
const idpAt = (min) => new Date(Date.now() + min * 60000).toISOString();
const groupWithIdp = (min) => ({ matches: [{ matchNo: 1, idpAt: idpAt(min) }] });
ok('open when IDP is 20 min away', registrationOpen(groupWithIdp(20)) === true);
ok('open when IDP is exactly 15 min + 1s away', registrationOpen(groupWithIdp(15.02)) === true);
ok('closed when IDP is 14 min away', registrationOpen(groupWithIdp(14)) === false);
ok('closed when IDP is 5 min away', registrationOpen(groupWithIdp(5)) === false);
ok('closed when IDP already passed', registrationOpen(groupWithIdp(-30)) === false);
ok('open (degraded) when no idpAt present', registrationOpen({ matches: [{ matchNo: 1 }] }) === true);
ok('open when group has no matches', registrationOpen({ matches: [] }) === true);
ok('open on empty object (no crash)', registrationOpen({}) === true);

console.log('rosterFromTeam:');
const mk = (ign, role, uid) => ({ role, player: { ign, gameUid: uid, discordId: `d_${ign}` } });
ok('4 starters + SUB become players 1-5', (() => {
  const team = { members: [mk('A', 'P', '11'), mk('B', 'P', '22'), mk('C', 'P', '33'), mk('D', 'P', '44'), mk('E', 'SUB', '55')] };
  const r = rosterFromTeam(team);
  return r.length === 5 && r[4].ign === 'E' && r[4].number === 5 && r[0].uid === '11';
})());
ok('5th non-SUB becomes sub when no SUB role', (() => {
  const r = rosterFromTeam({ members: [mk('A', 'P', '1'), mk('B', 'P', '2'), mk('C', 'P', '3'), mk('D', 'P', '4'), mk('E', 'P', '5')] });
  return r.length === 5 && r[4].ign === 'E';
})());
ok('members without ign/uid are filtered out', (() => {
  const r = rosterFromTeam({ members: [mk('A', 'P', '1'), { role: 'P', player: { ign: null, gameUid: '2' } }] });
  return r.length === 1 && r[0].ign === 'A';
})());
ok('null team -> empty roster (no crash)', rosterFromTeam(null).length === 0);

console.log('session round-trip:');
(async () => {
  // DB-backed sessions: skip cleanly when the database is unreachable.
  try {
    const { prisma } = require('./src/db.js');
    await prisma.scrimFormSession.findFirst();
  } catch (e) {
    skip('saveSession/getSession/deleteSession round-trip', `DB unreachable (${String(e.message).split('\n')[0]})`);
    console.log(`\n${passed} scrimport verify tests passed, ${skipped} skipped.`);
    return;
  }
  const uid = `test_uid_${Date.now()}`;
  await scrims.saveSession(uid, 'bs_verify', { hello: 'world' }, 30);
  const got = await scrims.getSession(uid, 'bs_verify');
  ok('saved session reads back', !!got && got.hello === 'world');
  await scrims.deleteSession(uid, 'bs_verify');
  const gone = await scrims.getSession(uid, 'bs_verify');
  ok('deleted session reads back null', gone === null);
  console.log(`\n${passed} scrimport verify tests passed, ${skipped} skipped.`);
})().catch((e) => {
  console.error('FAIL: session round-trip threw:', e.message);
  process.exitCode = 1;
});
