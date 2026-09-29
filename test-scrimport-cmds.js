/**
 * scrimport-1 tests: slash-command builders from src/scrimcmds/*.
 * - every cmdBuilders entry is a valid slash-command (name + description)
 * - command names are unique across all four files
 * - cmds-v.js needs no commands (verification/registration are panel-driven)
 * - /export gets a "scrim" subcommand fragment (exportScrimSubcommand)
 * - /ss_idp has the manual subcommand with room_id/password options
 * No Discord connection, no DB needed.
 */
const assert = require('node:assert/strict');

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

const files = ['cmds-v', 'cmds-g', 'cmds-i', 'cmds-a'];
const all = [];
const names = [];
for (const f of files) {
  const mod = require(`./src/scrimcmds/${f}.js`);
  ok(`${f}: exports cmdBuilders array`, Array.isArray(mod.cmdBuilders));
  for (const b of mod.cmdBuilders) {
    const json = (b.data && typeof b.data.toJSON === 'function') ? b.data.toJSON() : (typeof b.toJSON === 'function' ? b.toJSON() : b);
    all.push({ file: f, json });
    names.push(json.name);
    ok(`${f}: command has a name`, typeof json.name === 'string' && json.name.length > 0);
    ok(`${f}/${json.name}: has description`, typeof json.description === 'string' && json.description.length > 0);
    ok(`${f}/${json.name}: name is lowercase slash-command style`, /^[a-z0-9_]{1,32}$/.test(json.name));
  }
}

console.log('uniqueness:');
ok('command names unique across all scrimcmds files', new Set(names).size === names.length);
console.log('  commands:', names.join(', ') || '(none)');

console.log('per-file expectations:');
const v = require('./src/scrimcmds/cmds-v.js');
ok('cmds-v: zero builders (panel-driven, per plan)', v.cmdBuilders.length === 0);
const gNames = all.filter((c) => c.file === 'cmds-g').map((c) => c.json.name);
ok('cmds-g: /create_group present', gNames.includes('create_group'));
ok('cmds-g: /create_group_t3 present', gNames.includes('create_group_t3'));
const a = require('./src/scrimcmds/cmds-a.js');
const aNames = all.filter((c) => c.file === 'cmds-a').map((c) => c.json.name);
ok('cmds-a: /message_template present', aNames.includes('message_template'));
ok('cmds-a: /bot_health present', aNames.includes('bot_health'));
ok('cmds-a: exportScrimSubcommand fragment present', !!a.exportScrimSubcommand);
ok('cmds-a: export fragment named "scrim"', a.exportScrimSubcommand.name === 'scrim');

console.log('ss_idp manual subcommand:');
const i = require('./src/scrimcmds/cmds-i.js');
ok('cmds-i: /ss_idp present', names.includes('ss_idp'));
const ssIdp = all.find((c) => c.json.name === 'ss_idp').json;
const manual = (ssIdp.options || []).find((o) => o.type === 1 && o.name === 'manual');
ok('/ss_idp has a manual subcommand', !!manual);
if (manual) {
  const optNames = (manual.options || []).map((o) => o.name);
  ok('/ss_idp manual has room_id + password options', optNames.includes('room_id') && optNames.includes('password'));
  ok('/ss_idp manual has group_no + track options', optNames.includes('group_no') && optNames.includes('track'));
}

console.log(`\n${passed} scrimport command tests passed.`);
