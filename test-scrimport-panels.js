/**
 * scrimport-1 tests: every scrims panel builder returns a valid payload,
 * respects Discord limits (<=5 action rows), and uses bs:-namespaced
 * customIds that match the custom-ID registry in .scrimport-plan.md
 * with no collisions into existing namespaces.
 * No Discord connection, no DB needed.
 */
const assert = require('node:assert/strict');
const panels = require('./src/scrimpanels.js');

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

// Registry from .scrimport-plan.md: exact fixed IDs + parameterized prefixes.
const REGISTRY_FIXED = new Set([
  'bs:verify', 'bs:verify:edit', 'bs:verify:modal', 'bs:verify:submit', 'bs:verify:cancel',
  'bs:oq:register', 'bs:oq:reminder', 'bs:t3:register', 'bs:t3:reminder',
  'bs:reg:cancel', 'bs:team:cancel:no', 'bs:team:change:no',
  'bs:admin:lookup', 'bs:admin:ban', 'bs:admin:unban', 'bs:admin:banlist',
  'bs:admin:delteam', 'bs:admin:restoreteam',
  'bs:lobby:refresh',
  'bs:tpl:list',
]);
const REGISTRY_PREFIXES = [
  'bs:reg:group:', 'bs:reg:confirm:',
  'bs:panel:remind:', 'bs:panel:publish:', 'bs:panel:warn:', 'bs:panel:remove:', 'bs:panel:qualify:',
  'bs:warn:modal:', 'bs:remove:modal:', 'bs:qualify:modal:',
  'bs:team:cancel:', 'bs:team:cancel:yes:', 'bs:team:change:', 'bs:team:change:yes:',
  'bs:ssidp:start:', 'bs:ssidp:modal:',
  'bs:tpl:set:',
];
// Existing namespaces that bs: must never collide with.
const FOREIGN_NAMESPACES = ['team:', 'scrim:', 'tournament:', 'event:', 'admin:', 'idp:', 'slot:', 'dm:'];

function matchesRegistry(id) {
  if (REGISTRY_FIXED.has(id)) return true;
  return REGISTRY_PREFIXES.some((p) => id.startsWith(p));
}

// Collect payloads from every exported builder (sync ones).
const fakeGroup = { id: 'grp_test1', groupType: 'OQ', groupNo: 3, matchDate: null };
const payloads = {
  brVerifyPanel: panels.brVerifyPanel(),
  brOqPanel: panels.brOqPanel(),
  brT3Panel: panels.brT3Panel(),
  groupPanel: panels.groupPanel(fakeGroup),
  teamSelfServicePanel: panels.teamSelfServicePanel('grp_test1', [
    { id: 'g2', label: 'Group 2' },
    { id: 'g3', label: 'Group 3' },
  ]),
  brAdminPanel: panels.brAdminPanel(),
};

const allIds = [];
console.log('panel structure:');
for (const [name, p] of Object.entries(payloads)) {
  ok(`${name}: returns payload object`, !!p && typeof p === 'object');
  const components = p.components || [];
  ok(`${name}: has components`, Array.isArray(components) && components.length > 0);
  ok(`${name}: <= 5 action rows (has ${components.length})`, components.length <= 5);
  for (const row of components) {
    const kids = row.components || [];
    ok(`${name}: row <= 5 components (has ${kids.length})`, kids.length <= 5);
  }
  const ids = components.flatMap((r) => (r.components || []).map((c) => c.data && (c.data.custom_id || c.data.customId)));
  ok(`${name}: all components have customIds`, ids.every(Boolean));
  for (const id of ids) {
    ok(`${name}: customId "${id}" starts with bs:`, id.startsWith('bs:'));
    ok(`${name}: customId "${id}" matches registry`, matchesRegistry(id));
    for (const ns of FOREIGN_NAMESPACES) {
      ok(`${name}: customId "${id}" does not collide with ${ns}`, !id.startsWith(ns));
    }
  }
  allIds.push(...ids);
}

console.log('registry/collision:');
ok('no duplicate customIds across panels', new Set(allIds).size === allIds.length);

// Parameterized IDs carry a non-empty parameter tail.
const paramIds = allIds.filter((id) => REGISTRY_PREFIXES.some((p) => id.startsWith(p)));
ok(`parameterized IDs carry group/token params (${paramIds.length} found)`,
  paramIds.length > 0 && paramIds.every((id) => {
    const p = REGISTRY_PREFIXES.find((x) => id.startsWith(x));
    return id.length > p.length;
  }));

// Spot checks against the exact registry entries for the fixed-ID panels.
ok('verify panel has bs:verify + bs:verify:edit',
  allIds.includes('bs:verify') && allIds.includes('bs:verify:edit'));
ok('OQ panel has bs:oq:register + bs:oq:reminder',
  allIds.includes('bs:oq:register') && allIds.includes('bs:oq:reminder'));
ok('T3 panel has bs:t3:register + bs:t3:reminder',
  allIds.includes('bs:t3:register') && allIds.includes('bs:t3:reminder'));
ok('group panel has all five management buttons',
  ['remind', 'publish', 'warn', 'remove', 'qualify'].every((k) => allIds.includes(`bs:panel:${k}:grp_test1`)));
ok('admin panel has lookup/ban/unban/banlist/delteam/restoreteam + templates',
  ['bs:admin:lookup', 'bs:admin:ban', 'bs:admin:unban', 'bs:admin:banlist',
   'bs:admin:delteam', 'bs:admin:restoreteam', 'bs:tpl:list'].every((id) => allIds.includes(id)));
ok('team self-service has cancel + change buttons',
  allIds.includes('bs:team:cancel:grp_test1') && allIds.includes('bs:team:change:grp_test1'));

console.log(`\n${passed} scrimport panel tests passed.`);
