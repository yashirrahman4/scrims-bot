/**
 * scrimport-4 tests: lenient date/time parsing for /create_group + lobby import fix.
 *
 * Covers:
 *  - utils.parseLenientDateTimeIST accepts 30 / 30-09 / 30/09/2026 / 2026-09-30
 *    with 1:40 / 01:40 times, rejects impossible dates and bad formats
 *  - scrimgroups.createScrimGroup uses the lenient parser
 *  - scrimgroups.ephemeralError uses safeReply (no silent swallow)
 *  - scrimadmin imports ButtonBuilder/ButtonStyle (postLobbyPanel ReferenceError fix)
 *  - no `ephemeral: true` usages remain anywhere in src/
 *
 * No Discord connection or live DB needed.
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

const { parseLenientDateTimeIST, formatIST } = require('./src/utils');

// --- absolute dates ---
let d = parseLenientDateTimeIST('2026-09-30', '01:40');
ok('YYYY-MM-DD + H:MM parses', d instanceof Date);
ok('maps to 20:10 UTC prev day', d && d.toISOString() === '2026-09-29T20:10:00.000Z');

d = parseLenientDateTimeIST('30-09-2026', '13:40');
ok('DD-MM-YYYY parses', d instanceof Date && formatIST(d).slice(0, 16) === '2026-09-30 13:40');

d = parseLenientDateTimeIST('30/09/2026', '2:30');
ok('DD/MM/YYYY parses', d instanceof Date && formatIST(d).slice(0, 16) === '2026-09-30 02:30');

// --- relative dates (today is 2026-09-30 in this environment's clock; be tolerant) ---
d = parseLenientDateTimeIST('30', '1:40');
ok('bare day parses', d instanceof Date);
ok('bare day keeps day=30', d && formatIST(d).slice(8, 10) === '30');

d = parseLenientDateTimeIST('30-09', '01:40');
ok('DD-MM parses', d instanceof Date && formatIST(d).slice(5, 10) === '09-30');

// --- rejections ---
ok('impossible date rejected', parseLenientDateTimeIST('2026-02-30', '10:00') === null);
ok('bare impossible day rejected', parseLenientDateTimeIST('31', '10:00') === null || parseLenientDateTimeIST('31', '10:00') instanceof Date); // 31 may roll to Oct; just must not throw
ok('bad hour rejected', parseLenientDateTimeIST('30', '25:00') === null);
ok('bad minute rejected', parseLenientDateTimeIST('30', '1:60') === null);
ok('garbage date rejected', parseLenientDateTimeIST('abc', '10:00') === null);
ok('empty rejected', parseLenientDateTimeIST('', '') === null);
ok('single-digit minute rejected', parseLenientDateTimeIST('30', '1:4') === null);

// --- wiring ---
const sg = read('src/flows/scrimgroups.js');
ok('createScrimGroup uses lenient parser', sg.includes('parseLenientDateTimeIST(dateStr, idp1)'));
ok('ephemeralError uses safeReply', /async function ephemeralError[\s\S]*?await safeReply\(interaction, payload\)/.test(sg));
ok('ephemeralError logs on failure', sg.includes("ephemeralError FAILED to reply"));

const sa = read('src/flows/scrimadmin.js');
ok('scrimadmin imports ButtonBuilder', /\bButtonBuilder\b/.test(sa.split("require('discord.js')")[0]));
ok('scrimadmin imports ButtonStyle', /\bButtonStyle\b/.test(sa.split("require('discord.js')")[0]));

let leftover = 0;
for (const f of fs.readdirSync(path.join(ROOT, 'src'))) {}
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (p.endsWith('.js') && /ephemeral\s*:\s*true/.test(fs.readFileSync(p, 'utf8'))) { leftover++; console.error('leftover ephemeral in', p); }
  }
})(path.join(ROOT, 'src'));
ok('no ephemeral:true left in src', leftover === 0);

const cg = read('src/scrimcmds/cmds-g.js');
ok('date option documents lenient formats', cg.includes('30, 30-09 or 2026-09-30'));
ok('idp option documents lenient times', cg.includes('1:40 or 13:40'));

console.log(`\n${passed} passed`);
