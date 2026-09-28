// Functional tests for the IDP flow + export helpers. Run: node test-idp-export.js
const assert = require('assert');
const { groupCount, idpPanelPayload, groupLabel } = require('./src/flows/idp.js');
const { toCsv, csvCell } = require('./src/flows/export.js');

let n = 0;
function ok(label, cond) {
  n++;
  assert(cond, `FAILED: ${label}`);
  console.log(`  ok - ${label}`);
}

// --- groupCount ---
ok('1024 slots / 16 per group = 64 groups', groupCount(1024, 16) === 64);
ok('600 slots / 20 per group = 30 groups', groupCount(600, 20) === 30);
ok('25 slots / 20 per group = 2 groups (ceil)', groupCount(25, 20) === 2);
ok('20 slots / 20 per group = 1 group', groupCount(20, 20) === 1);
ok('1 slot = 1 group (never zero)', groupCount(1, 20) === 1);
ok('null per-group falls back to 20', groupCount(100, null) === 5);
ok('zero per-group falls back to 20', groupCount(100, 0) === 5);

// --- groupLabel ---
ok('groupLabel G1-D1', groupLabel({ groupNo: 1 }) === 'G1-D1');
ok('groupLabel G12-D1', groupLabel({ groupNo: 12 }) === 'G12-D1');

// --- idpPanelPayload ---
const fakeGroup = {
  id: 'g1',
  groupNo: 3,
  locked: true,
  matchesDate: null,
  tournament: { name: 'Ravens Championship', teamsPerGroup: 16 },
  matches: [
    { matchNo: 1, map: 'Erangel', idpAt: '12:45 PM', startAt: '12:55 PM' },
    { matchNo: 2, map: 'Miramar', idpAt: null, startAt: null },
  ],
};
const payload = idpPanelPayload(fakeGroup);
ok('payload has embeds', Array.isArray(payload.embeds) && payload.embeds.length === 1);
const desc = payload.embeds[0].data.description;
ok('title mentions G3-D1', payload.embeds[0].data.title.includes('G3-D1'));
ok('shows total slots 16', desc.includes('**Total Slots:** 16'));
ok('shows match 1 Erangel with times', desc.includes('**Match 1 - Erangel**') && desc.includes('12:45 PM') && desc.includes('12:55 PM'));
ok('shows match 2 Miramar with TBD', desc.includes('**Match 2 - Miramar**') && desc.includes('TBD'));
ok('footer says locked', payload.embeds[0].data.footer.text.includes('locked'));
ok('two button rows', payload.components.length === 2);
const labels = payload.components.flatMap((r) => r.components.map((b) => b.data.label));
for (const want of ['Edit', 'Send Slot List', 'Punish Teams', 'Qualify Teams', 'Send Reminders', 'Unlock Group', 'Cancel Slot', 'Transfer IDP Role']) {
  ok(`button "${want}" present`, labels.includes(want));
}
const ids = payload.components.flatMap((r) => r.components.map((b) => b.data.custom_id));
ok('all button ids scoped to group', ids.every((x) => x === `idp:${x.split(':')[1]}:g1`));
ok('unlock button present when locked', ids.includes('idp:unlock:g1'));
const unlockedPayload = idpPanelPayload({ ...fakeGroup, locked: false });
ok('lock button present when unlocked', unlockedPayload.components[1].components[0].data.custom_id === 'idp:lock:g1');

// --- CSV helpers ---
ok('csvCell quotes commas', csvCell('a,b') === '"a,b"');
ok('csvCell escapes quotes', csvCell('say "hi"') === '"say ""hi"""');
ok('csvCell passes plain', csvCell('abc') === 'abc');
ok('csvCell null -> empty', csvCell(null) === '');
const csv = toCsv(['A', 'B'], [['x', 'y,z'], ['p"q', 5]]);
ok('toCsv has BOM', csv.charCodeAt(0) === 0xfeff);
ok('toCsv quotes fields', csv.includes('y,z'.replace('y,z', '"y,z"')) && csv.includes('"p""q",5'));

console.log(`\n${n} functional tests passed`);
