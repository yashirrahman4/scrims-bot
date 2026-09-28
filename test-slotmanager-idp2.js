// Tests for: IDP naming pattern, per-group roles, punish-only-for-scrims,
// map dropdown flow, not-revealed maps, slot manager panels.
// Run: node test-slotmanager-idp2.js
const assert = require('assert');

// ---- stub ./src/db.js before any flow requires it ----
const createdMatches = [];
const createdRoles = [];
const createdChannels = [];
const createdGroups = [];
function delegate(model) {
  return new Proxy(
    {},
    {
      get(_, op) {
        return async (args) => {
          if (model === 'idpMatch' && op === 'create') {
            createdMatches.push(args.data);
            return { id: 'm' + createdMatches.length, ...args.data };
          }
          if (model === 'idpGroup' && op === 'create') {
            const g = { id: 'g' + (createdGroups.length + 1), ...args.data };
            createdGroups.push(g);
            return g;
          }
          if (model === 'idpGroup' && op === 'findMany') return [];
          if (model === 'idpGroup' && op === 'update') return { id: args.where.id };
          if (model === 'idpGroup' && op === 'findUnique') {
            const g = createdGroups.find((x) => x.id === args.where.id);
            if (!g) return null;
            return {
              ...g,
              tournament: { name: 'Big Tourney', type: 'TOURNAMENT', teamsPerGroup: 20 },
              matches: createdMatches.filter((m) => m.idpGroupId === g.id).map((m, i) => ({ ...m, matchNo: i + 1 })),
            };
          }
          if (model === 'tournamentRegistration' && op === 'findMany') return [];
          if (model === 'tournament' && op === 'findUnique') {
            return {
              id: 'e1', name: 'Big Tourney', type: 'TOURNAMENT', teamLimit: 40,
              teamsPerGroup: 20, date: null, idpCategoryId: null, idpNamePattern: null,
            };
          }
          if (model === 'tournament' && op === 'update') return { id: 'e1' };
          if (model === 'guildSettings' && op === 'findUnique') return { groupSize: 20 };
          return null;
        };
      },
    }
  );
}
const prismaStub = new Proxy(
  {},
  {
    get(_, m) {
      if (m === '$executeRawUnsafe') return async () => {};
      return delegate(m);
    },
  }
);
require.cache[require.resolve('./src/db.js')] = {
  id: require.resolve('./src/db.js'),
  filename: require.resolve('./src/db.js'),
  loaded: true,
  exports: { prisma: prismaStub },
};

const idp = require('./src/flows/idp');
const slot = require('./src/flows/slotmanager');

let pass = 0;
const ok = (name, cond) => {
  assert(cond, name);
  pass++;
  console.log('  ✓', name);
};

// ---------- 1. naming pattern parsing ----------
console.log('naming pattern:');
ok('XYZ G1 -> prefix "XYZ G", start 1', JSON.stringify(idp.parseNamePattern('XYZ G1')) === JSON.stringify({ prefix: 'XYZ G', start: 1 }));
ok('XYZ R1 G1 -> prefix "XYZ R1 G", start 1', JSON.stringify(idp.parseNamePattern('XYZ R1 G1')) === JSON.stringify({ prefix: 'XYZ R1 G', start: 1 }));
ok('ABC G05 -> start 5', idp.parseNamePattern('ABC G05').start === 5);
ok('no number -> start 1', idp.parseNamePattern('XYZ').start === 1);

// ---------- 2. display + channel names ----------
console.log('group names:');
ok('first group "XYZ G1"', idp.groupDisplayName('XYZ G1', 0) === 'XYZ G1');
ok('second group "XYZ G2"', idp.groupDisplayName('XYZ G1', 1) === 'XYZ G2');
ok('R1 pattern third -> "XYZ R1 G3"', idp.groupDisplayName('XYZ R1 G1', 2) === 'XYZ R1 G3');
ok('channel slug "xyz-r1-g1"', idp.groupChannelName('XYZ R1 G1') === 'xyz-r1-g1');
ok('channel slug has no spaces', !idp.groupChannelName('XYZ G1').includes(' '));

// ---------- 3. panel buttons: punish only for scrims ----------
console.log('panel buttons:');
const tournGroup = {
  id: 'g1', groupNo: 1, locked: true, matchesDate: null, channelId: 'c1',
  tournament: { name: 'Big Tourney', type: 'TOURNAMENT', teamsPerGroup: 20 },
  matches: [{ matchNo: 1, map: null, idpAt: null, startAt: null }],
};
const tp = idp.idpPanelPayload(tournGroup);
const tLabels = tp.components.flatMap((r) => r.components.map((c) => c.data.label));
ok('tournament panel has 5 buttons in one row', tp.components.length === 1 && tp.components[0].components.length === 5);
ok('tournament panel has NO Punish Teams', !tLabels.includes('Punish Teams'));
ok('tournament panel has Qualify + Unlock', tLabels.includes('Qualify Teams') && tLabels.includes('Unlock Group'));

const scrimGroup = { ...tournGroup, tournament: { name: 'Scrim', type: 'SCRIM', teamsPerGroup: 20 } };
const sp = idp.idpPanelPayload(scrimGroup);
const sLabels = sp.components.flatMap((r) => r.components.map((c) => c.data.label));
ok('scrim panel keeps Punish Teams', sLabels.includes('Punish Teams'));
ok('scrim panel uses two rows (5+1)', sp.components.length === 2 && sp.components[0].components.length === 5 && sp.components[1].components.length === 1);
ok('no row exceeds 5 buttons', tp.components.concat(sp.components).every((r) => r.components.length <= 5));

// ---------- 4. map display ----------
console.log('map display:');
const desc = tp.embeds[0].data.description;
ok('null map shows "Not revealed yet"', desc.includes('Not revealed yet'));
ok('no thumbnail when map hidden', !tp.embeds[0].data.thumbnail);
const revealedGroup = { ...tournGroup, matches: [{ matchNo: 1, map: 'Erangel', idpAt: '12:45 PM', startAt: '1:00 PM' }] };
const rp = idp.idpPanelPayload(revealedGroup);
ok('revealed map name shown', rp.embeds[0].data.description.includes('Erangel'));
ok('revealed map gets thumbnail', !!rp.embeds[0].data.thumbnail && rp.embeds[0].data.thumbnail.url.includes('pubg.com'));
ok('MAPS has Erangel, Miramar, Rondo', JSON.stringify(idp.MAPS) === JSON.stringify(['Erangel', 'Miramar', 'Rondo']));

// ---------- 5. slot manager panels ----------
console.log('slot manager panels:');
const teamP = slot.teamPanelPayload('e1');
const teamBtns = teamP.components[0].components.map((c) => c.data.label);
ok('team panel has 4 buttons', teamBtns.length === 4);
ok('team panel buttons match reference', JSON.stringify(teamBtns) === JSON.stringify(['Cancel My Slot', 'My Groups', 'Change Team Name', 'Swap Groups']));
ok('team buttons use slot: prefix', teamP.components[0].components.every((c) => c.data.custom_id.startsWith('slot:')));
const adminP = slot.adminPanelPayload('e1');
const adminBtns = adminP.components[0].components.map((c) => c.data.label);
ok('admin panel has Cancel Slot + Transfer IDP Role', JSON.stringify(adminBtns) === JSON.stringify(['Cancel Slot', 'Transfer IDP Role']));
ok('no row exceeds 5 buttons', teamP.components.concat(adminP.components).every((r) => r.components.length <= 5));

// ---------- 6. createIdpGroups: naming + roles + null map ----------
console.log('createIdpGroups:');
(async () => {
  let n = 0;
  const mkChannel = async (opts) => {
    n++;
    createdChannels.push(opts.name);
    return { id: 'ch' + n, send: async (payload) => ({ id: 'msg' + n, payload }) };
  };
  const guild = {
    channels: { create: mkChannel, fetch: async () => null },
    roles: {
      create: async (opts) => {
        createdRoles.push(opts.name);
        return { id: 'role-' + opts.name };
      },
      fetch: async () => null,
      everyone: { id: 'everyone' },
    },
    members: { fetch: async () => null },
  };
  const summary = await idp.createIdpGroups({}, guild, 'e1', 'guild1', 'XYZ R1 G1');
  ok('created 2 groups (40 slots / 20 per group)', summary.groups === 2);
  ok('channels named xyz-r1-g1, xyz-r1-g2', JSON.stringify(createdChannels.slice(-2)) === JSON.stringify(['xyz-r1-g1', 'xyz-r1-g2']));
  ok('roles named "XYZ R1 G1", "XYZ R1 G2"', JSON.stringify(createdRoles) === JSON.stringify(['XYZ R1 G1', 'XYZ R1 G2']));
  ok('roleId stored on groups', createdGroups.every((g) => g.roleId && g.roleId.startsWith('role-')));
  ok('matches created with null map (not Erangel)', createdMatches.length === 2 && createdMatches.every((m) => m.map === null));
  ok('summary carries the pattern', summary.pattern === 'XYZ R1 G1');

  console.log(`\nAll ${pass} tests passed.`);
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
