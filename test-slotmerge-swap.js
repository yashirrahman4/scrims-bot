/**
 * slotmerge-1 tests: single merged slot-manager panel + admin-only two-team
 * group swap (parseSlotRef helper, customId routing, panel structure).
 * No Discord connection needed.
 */
const assert = require('node:assert/strict');
const slot = require('./src/flows/slotmanager');
const idp = require('./src/flows/idp');

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

// ---------- 1. parseSlotRef ----------
console.log('parseSlotRef:');
assert.deepEqual(slot.parseSlotRef('12'), { slotNo: 12 });
assert.deepEqual(slot.parseSlotRef('#12'), { slotNo: 12 });
assert.deepEqual(slot.parseSlotRef('  7 '), { slotNo: 7 });
assert.deepEqual(slot.parseSlotRef('BRV'), { tag: 'BRV' });
assert.deepEqual(slot.parseSlotRef('br_x1'), { tag: 'br_x1' });
assert.equal(slot.parseSlotRef(''), null);
assert.equal(slot.parseSlotRef('   '), null);
assert.equal(slot.parseSlotRef(null), null);
ok('parseSlotRef handles slots, tags, # prefix, blanks', true);

// ---------- 2. single panel structure ----------
console.log('single panel:');
const p = slot.slotManagerPanel('t9');
ok('single message payload (embeds + components)', p.embeds.length === 1 && p.components.length === 2);
const allCustomIds = p.components.flatMap((r) => r.components.map((c) => c.data.custom_id));
ok('no legacy teamPanelPayload/adminPanelPayload split — one customId family',
  allCustomIds.every((id) => id.startsWith('slot:') && id.endsWith(':t9')));
ok('swap button lives on the admin row only',
  p.components[1].components.some((c) => c.data.custom_id === 'slot:swap:t9') &&
    !p.components[0].components.some((c) => c.data.custom_id === 'slot:swap:t9'));
ok('total buttons = 6 (3 team + 3 admin)', allCustomIds.length === 6);
ok('no duplicate customIds', new Set(allCustomIds).size === 6);

// ---------- 3. swap flow customId routing sanity ----------
console.log('swap routing:');
ok('postSlotList is exported from idp flow', typeof idp.postSlotList === 'function');
ok('slotmanager exports reconcileLegacySlotPanels', typeof slot.reconcileLegacySlotPanels === 'function');
ok('slotmanager exports findActiveReg', typeof slot.findActiveReg === 'function');
ok('old exports teamPanelPayload/adminPanelPayload are gone',
  slot.teamPanelPayload === undefined && slot.adminPanelPayload === undefined);

console.log(`\n${passed} swap/panel tests passed.`);
