/**
 * scrimport-3 tests: regression coverage for the 2026-09-30 code audit fixes.
 *
 * Covers:
 *  - utils.safeReply (deferred-safe reply contract) and utils.numEnv (NaN-safe)
 *  - parseDateTimeIST rejecting impossible dates (2026-02-30)
 *  - scrimidp.unwrapSessionPayload (DB row vs bare payload shapes)
 *  - scrimgroups.shouldEscalateToBan (source parity: ban only when count EXCEEDS max)
 *  - template service async render: ss_idp + qualification templates interpolate
 *    single-brace vars with no literal placeholders left
 *  - router ss_idp manual validators (room_id / password / lobby_time)
 *  - migration SQL: idempotent FK guards + new ScrimGroup reminder columns
 *  - schema.prisma: new ScrimGroup reminder columns
 *  - boot: build tag + CLIENT_ID/GUILD_ID registration warning present
 *  - createScrimGroup: P2002 retry + Discord rollback present
 *  - cmds-i: dead execute removed, DM permission disabled
 *
 * No Discord connection or live DB needed (DB-backed paths degrade gracefully).
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
  } else {
    passed++;
    console.log('ok:', name);
  }
}

(async () => {
// ---------------------------------------------------------------- utils
console.log('utils.safeReply:');
const { safeReply, numEnv, parseDateTimeIST } = require('./src/utils.js');

{
  const via = [];
  const mk = (flags, fns) => ({ ...flags, ...fns });
  const p1 = mk({ deferred: true, replied: false }, { editReply: async (p) => via.push(['edit', p]) });
  await safeReply(p1, { content: 'x' });
  ok('deferred -> editReply', via.length === 1 && via[0][0] === 'edit');

  const p2 = mk({ deferred: false, replied: true }, { followUp: async (p) => via.push(['follow', p]) });
  await safeReply(p2, { content: 'x' });
  ok('replied -> followUp', via.length === 2 && via[1][0] === 'follow');

  const p3 = mk({ deferred: false, replied: false }, { reply: async (p) => via.push(['reply', p]) });
  await safeReply(p3, { content: 'x' });
  ok('fresh -> reply', via.length === 3 && via[2][0] === 'reply');

  const bad = { deferred: true, replied: false, editReply: async () => { throw new Error('boom'); } };
  const res = await safeReply(bad, { content: 'x' });
  ok('throwing interaction -> null, no throw', res === null);
}

console.log('utils.numEnv:');
{
  process.env.__TEST_NUM = 'abc';
  ok('non-numeric -> default', numEnv('__TEST_NUM', 7) === 7);
  process.env.__TEST_NUM = '';
  ok('empty -> default', numEnv('__TEST_NUM', 7) === 7);
  process.env.__TEST_NUM = '42';
  ok('valid -> parsed', numEnv('__TEST_NUM', 7) === 42);
  delete process.env.__TEST_NUM;
  ok('unset -> default', numEnv('__TEST_NUM', 7) === 7);
}

console.log('parseDateTimeIST:');
{
  ok('rejects 2026-02-30 (impossible date)', parseDateTimeIST('2026-02-30 18:00') === null);
  ok('rejects 2026-13-01 (bad month)', parseDateTimeIST('2026-13-01 18:00') === null);
  ok('accepts 2026-02-28 18:00', parseDateTimeIST('2026-02-28 18:00') instanceof Date);
  const early = parseDateTimeIST('2026-09-30 00:30');
  ok('accepts early-morning IST (UTC day rolls back)', early instanceof Date);
  ok('round-trips through formatIST', early && require('./src/utils.js').formatIST(early).slice(0, 16) === '2026-09-30 00:30');
}

// ---------------------------------------------------------------- scrimidp session unwrap
console.log('scrimidp.unwrapSessionPayload:');
{
  const { unwrapSessionPayload } = require('./src/flows/scrimidp.js')._test;
  const inner = { token: 't', groupId: 'g', roomId: '12345', password: 'abc' };
  const row = { id: 'row1', userDiscordId: 'u', payload: inner, expiresAt: new Date() };
  ok('DB row -> inner payload', unwrapSessionPayload(row) === inner);
  ok('bare payload -> as-is', unwrapSessionPayload(inner) === inner);
  ok('null -> null', unwrapSessionPayload(null) === null);
  ok('row without payload -> row', unwrapSessionPayload({ id: 'x' }).id === 'x');
}

// ---------------------------------------------------------------- escalation threshold
console.log('scrimgroups.shouldEscalateToBan:');
{
  const { shouldEscalateToBan } = require('./src/flows/scrimgroups.js')._test;
  ok('count 3 / max 3 -> no ban (source: exceeds only)', shouldEscalateToBan(3, 3) === false);
  ok('count 4 / max 3 -> ban', shouldEscalateToBan(4, 3) === true);
  ok('count 1 / max 3 -> no ban', shouldEscalateToBan(1, 3) === false);
  ok('custom max: 5/5 -> no ban, 6/5 -> ban', shouldEscalateToBan(5, 5) === false && shouldEscalateToBan(6, 5) === true);
}

// ---------------------------------------------------------------- template renders (async service, DB-degraded)
console.log('template service renders:');
{
  const tpl = require('./src/services/scrimmsgtemplate.js');
  const ssidp = await tpl.renderTemplate('ss_idp', {
    group_mention: '<@&111>',
    room_id: '98765',
    room_password: 'pass123',
    start_time: '18:00',
  });
  ok('ss_idp interpolates room_id', ssidp.includes('98765'));
  ok('ss_idp interpolates room_password', ssidp.includes('pass123'));
  ok('ss_idp leaves no literal {room_id}', !ssidp.includes('{room_id}'));
  ok('ss_idp leaves no literal {room_password}', !ssidp.includes('{room_password}'));
  ok('ss_idp leaves no literal {start_time}', !ssidp.includes('{start_time}'));
  ok('ss_idp leaves no literal {group_mention}', !ssidp.includes('{group_mention}'));

  const q = await tpl.renderTemplate('qualification_idp', {
    congrats_emoji: '🎉', owner_mention: '<@999>', trophy_emoji: '🏆',
    group_type: 'OQ', group_number: 3, slot_number: 7, team_name: 'Test Team', fire_emoji: '🔥',
  });
  ok('qualification_idp interpolates team_name', q.includes('Test Team'));
  ok('qualification_idp leaves no literal placeholders', !/\{[a-z_]+\}/.test(q));

  const qn = await tpl.renderTemplate('qualification_none_results', { group_type: 'T3', group_number: 2 });
  ok('qualification_none_results interpolates', qn.includes('T3') && qn.includes('2'));
  ok('qualification_none_results leaves no literal placeholders', !/\{[a-z_]+\}/.test(qn));
}

// ---------------------------------------------------------------- router validators
console.log('router ss_idp manual validators:');
{
  const { isValidRoomId, isValidRoomPassword, isValidLobbyTime } = require('./src/router.js')._test;
  ok('room_id 5 digits ok', isValidRoomId('12345') === true);
  ok('room_id 4 digits rejected', isValidRoomId('1234') === false);
  ok('room_id 16 digits rejected', isValidRoomId('1'.repeat(16)) === false);
  ok('room_id letters rejected', isValidRoomId('abcde') === false);
  ok('password 3 chars ok', isValidRoomPassword('a1b') === true);
  ok('password 2 chars rejected', isValidRoomPassword('a1') === false);
  ok('password symbols rejected', isValidRoomPassword('ab!') === false);
  ok('lobby_time HH:MM ok', isValidLobbyTime('18:30') === true);
  ok('lobby_time blank ok', isValidLobbyTime('') === true);
  ok('lobby_time 25:00 rejected', isValidLobbyTime('25:00') === false);
  ok('lobby_time garbage rejected', isValidLobbyTime('soon') === false);
}

// ---------------------------------------------------------------- migration + schema
console.log('migration + schema:');
{
  const sql = read('prisma/migrations/20260930000000_scrimport/migration.sql');
  ok('ScrimMatch FK guarded by pg_constraint IF NOT EXISTS',
    /DO \$\$[\s\S]*?pg_constraint[\s\S]*?ScrimMatch_groupId_fkey[\s\S]*?END \$\$;/.test(sql));
  ok('ScrimSlot FK guarded by pg_constraint IF NOT EXISTS',
    /DO \$\$[\s\S]*?pg_constraint[\s\S]*?ScrimSlot_groupId_fkey[\s\S]*?END \$\$;/.test(sql));
  ok('migration adds matchDayPingedAt', sql.includes('"matchDayPingedAt"'));
  ok('migration adds resultSsRemindedAt', sql.includes('"resultSsRemindedAt"'));
  const schema = read('prisma/schema.prisma');
  ok('schema ScrimGroup has matchDayPingedAt', /model ScrimGroup[\s\S]*?matchDayPingedAt DateTime\?/.test(schema));
  ok('schema ScrimGroup has resultSsRemindedAt', /model ScrimGroup[\s\S]*?resultSsRemindedAt DateTime\?/.test(schema));
  const selfheal = read('src/scrimselfheal.js');
  ok('selfheal adds matchDayPingedAt idempotently', selfheal.includes('ADD COLUMN IF NOT EXISTS "matchDayPingedAt"'));
  ok('selfheal adds resultSsRemindedAt idempotently', selfheal.includes('ADD COLUMN IF NOT EXISTS "resultSsRemindedAt"'));
}

// ---------------------------------------------------------------- wiring / boot / misc
console.log('wiring:');
{
  const index = read('src/index.js');
  ok('build tag bumped to scrimport-5', index.includes("2026-09-30.scrimport-5"));
  ok('boot warns when CLIENT_ID/GUILD_ID unset', /CLIENT_ID.*GUILD_ID.*not set/i.test(index));
  ok('boot self-registers commands', index.includes('applicationGuildCommands'));

  const groups = read('src/flows/scrimgroups.js');
  ok('createScrimGroup retries groupNo on P2002', /P2002/.test(groups));
  ok('createScrimGroup rolls back Discord channel', /channel\.delete\(\)/.test(groups));
  ok('createScrimGroup rolls back Discord role', /role\.delete\(\)/.test(groups));
  ok('group channel is read-only for group role', /deny:\s*\[PermissionFlagsBits\.SendMessages,\s*PermissionFlagsBits\.AttachFiles\]/.test(groups));
  const scrims = read('src/flows/scrims.js');
  ok('verify-cancel yes/no routed', scrims.includes("bs:verify:cancel:yes") && scrims.includes("bs:verify:cancel:no"));
  ok('registration uses SELECT FOR UPDATE lock', /FOR UPDATE/.test(scrims));
  ok('confirmation post uses env channel', scrims.includes('SCRIMS_OQ_CONFIRM_CHANNEL_ID'));

  const cmdsI = read('src/scrimcmds/cmds-i.js');
  ok('cmds-i dead execute removed', !/async execute\(/.test(cmdsI));
  ok('cmds-i sets DMPermission(false)', cmdsI.includes('setDMPermission(false)'));

  const router = read('src/router.js');
  ok('router defers before ss_idp manual handler', /deferReply[\s\S]*?handleSsIdpManual/.test(router));
  ok('ss_idp manual requires OPEN group', router.includes("status: 'OPEN'"));

  const admin = read('src/flows/scrimadmin.js');
  const stripComments = (s) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const healthFn = stripComments(admin.slice(admin.indexOf('async function handleBotHealth'), admin.indexOf('async function handleExportScrim')));
  ok('bot_health no longer double-defers', !/\.deferReply\(/.test(healthFn));
  const exportFn = stripComments(admin.slice(admin.indexOf('async function handleExportScrim'), admin.indexOf('async function handleButton')));
  ok('export scrim no longer double-defers', !/\.deferReply\(/.test(exportFn));
  ok('template list offers Edit buttons', admin.includes('bs:tpl:set:${tname}'));
  ok('lobby panel has Refresh button', admin.includes('bs:lobby:refresh'));
  ok('delete team frees slots (no deleteMany on ScrimSlot)', !/scrimSlot\.deleteMany/.test(admin));
  ok('banlist sweeps expired bans', admin.includes('expiresAt: { lt: new Date() }'));
}

console.log(`\n${passed} assertions passed.`);
})().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
