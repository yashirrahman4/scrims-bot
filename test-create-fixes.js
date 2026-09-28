// Tests for: tournament creation hang fix, 2000 slot limit, DM success message.
// Run: node test-create-fixes.js
const assert = require('assert');
const calls = [];

// ---- stub ./src/db.js before any flow requires it ----
const dbPath = require.resolve('./src/db.js');
const state = { dmShouldFail: false, settings: null };
function delegate(model) {
  return new Proxy(
    {},
    {
      get(_, op) {
        return async (args) => {
          calls.push(`prisma.${model}.${op}`);
          if (model === 'tournament' && op === 'findUnique') {
            return {
              id: 'e1', name: 'Big Tourney', type: 'TOURNAMENT', status: 'OPEN',
              date: null, teamLimit: 2000, format: 'Squad', maps: [], teamSize: 4,
              tagsRequired: 2, teamsPerGroup: 20, inviteUrl: null,
              regStartsAt: null, regChannelId: null, logChannelId: null,
              successRoleId: null, successMessage: 'Welcome to the arena! Read #rules.',
              idpCategoryId: null,
            };
          }
          if (model === 'tournament' && op === 'create') {
            return { id: 'e9', idpCategoryId: null, ...args.data };
          }
          if (model === 'tournament' && op === 'update') return { id: 'e1', ...args.data };
          if (model === 'tournamentRegistration' && op === 'count') return 0;
          if (model === 'guildSettings' && op === 'findUnique') return state.settings;
          if (model === 'guildSettings' && op === 'create') return { guildId: 'g1', groupSize: 20, ...args.data };
          if (model === 'user' && op === 'upsert') return { id: 'dbu1' };
          if (model === 'team' && op === 'findFirst') {
            return { id: 't1', name: 'Ravens', tag: 'BR', status: 'ACTIVE', ownerId: 'dbu1', members: [{ role: 'PLAYER' }, { role: 'PLAYER' }] };
          }
          if (model === 'auditLog' && op === 'create') return { id: 'a1' };
          return null;
        };
      },
    }
  );
}
const txProxy = new Proxy(
  {},
  {
    get(_, m) {
      if (m === '$transaction')
        return async (fn) => {
          calls.push('prisma.$transaction');
          return fn({
            tournamentRegistration: {
              count: async () => 0,
              create: async ({ data }) => ({ id: 'r1', slotNo: 1, groupNo: 1, ...data }),
            },
          });
        };
      return delegate(m);
    },
  }
);
const prismaStub = new Proxy(
  {},
  {
    get(_, prop) {
      if (prop === '$transaction') return txProxy.$transaction;
      if (prop === '$queryRaw') return async () => [];
      return delegate(prop);
    },
  }
);
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { prisma: prismaStub } };

function mockInteraction(kind, customId, fields = {}, opts = {}) {
  const ix = {
    customId,
    user: {
      id: 'u1',
      username: 'tester',
      send: async (payload) => {
        calls.push('user.send');
        ix._dmPayload = payload;
        if (state.dmShouldFail) throw new Error('Cannot send messages to this user');
        return { id: 'dm1' };
      },
    },
    guildId: 'g1',
    guild: {
      members: { fetch: async () => null },
      roles: { fetch: async () => null, create: async () => null },
      channels: { fetch: async () => null },
    },
    client: { guilds: { cache: new Map([['g1', { id: 'g1', channels: { fetch: async () => null } }]]), fetch: async () => { throw new Error('should use cache'); } } },
    member: { permissions: { has: () => true }, roles: { cache: [] } },
    replied: false,
    deferred: false,
    isButton: () => kind === 'button',
    isStringSelectMenu: () => kind === 'select',
    isChannelSelectMenu: () => false,
    isRoleSelectMenu: () => false,
    isUserSelectMenu: () => false,
    isModalSubmit: () => kind === 'modal',
    isChatInputCommand: () => false,
    fields: { getTextInputValue: (k) => (fields[k] !== undefined ? fields[k] : '') },
    values: opts.values || [],
    channel: { isTextBased: () => true, name: 'test', send: async () => {} },
    deferReply: async () => { calls.push('deferReply'); ix.deferred = true; },
    deferUpdate: async () => { calls.push('deferUpdate'); ix.deferred = true; },
    reply: async (p) => { calls.push('reply'); ix._reply = p; ix.replied = true; },
    update: async (p) => { calls.push('update'); ix._reply = p; ix.replied = true; },
    editReply: async (p) => { calls.push('editReply'); ix._edit = p; },
    followUp: async () => { calls.push('followUp'); },
    showModal: async () => { calls.push('showModal'); ix.replied = true; },
  };
  return ix;
}

const adminFlows = require('./src/flows/admin.js');
const eventFlows = require('./src/flows/events.js');

let n = 0;
function ok(label, cond) {
  n++;
  assert(cond, `FAILED: ${label}`);
  console.log(`  ok - ${label}`);
}
const embedText = (p) => (p && p.embeds ? p.embeds.map((e) => `${e.data.title || ''} ${e.data.description || ''}`).join(' | ') : '');

(async () => {
  // --- 1. Full step-2 creation with a real stashed draft (the hang scenario) ---
  state.settings = { guildId: 'g1', groupSize: 20, logAdminActivity: 'logchan1' };
  const token = adminFlows.stashCreation({
    type: 'TOURNAMENT', name: 'Big Tourney', date: null,
    teamLimit: 2000, tagsRequired: 4, teamsPerGroup: 20, createdBy: 'u1',
  });
  const createIx = mockInteraction('modal', `admin:create:modal2:${token}`, {
    e_desc: 'Big event', e_regstart: '', e_successmsg: 'Welcome!',
  });
  await adminFlows.handle(createIx);
  ok('modal2: deferReply happened (thinking started)', calls.includes('deferReply'));
  ok('modal2: editReply happened (no infinite thinking)', calls.includes('editReply'));
  const createText = embedText(createIx._edit) + ' ' + (createIx._edit.content || '');
  ok('modal2: reg manager panel shown after creation', /Registration|Big Tourney/.test(createText));
  const rows = createIx._edit.components;
  ok('modal2: panel has 5 rows', rows.length === 5);
  const btnCounts = rows.map((r) => r.components.filter((c) => c.data.type === 2).length);
  ok('modal2: no row has more than 5 buttons', btnCounts.every((c) => c <= 5));
  const labels = rows.flatMap((r) => r.components.map((c) => c.data.label).filter(Boolean));
  ok('modal2: Teams/Group button present', labels.includes('Teams/Group'));
  ok('modal2: log path used guild cache, not fetch', !calls.includes('guilds.fetch'));

  // --- 2. Modal1 accepts 2000, rejects 2001 ---
  const m2000 = mockInteraction('modal', 'admin:create:modal1:TOURNAMENT', {
    e_name: 'Huge', e_date: '', e_limit: '2000', e_tags: '4', e_tpg: '20',
  });
  await adminFlows.handle(m2000);
  ok('modal1: 2000 accepted (step-2 continue shown)', /Step 1 saved/.test(m2000._edit.content || ''));
  const m2001 = mockInteraction('modal', 'admin:create:modal1:TOURNAMENT', {
    e_name: 'Huge', e_date: '', e_limit: '2001', e_tags: '4', e_tpg: '20',
  });
  await adminFlows.handle(m2001);
  ok('modal1: 2001 rejected with 2000 message', embedText(m2001._edit).includes('between 2 and 2000'));

  // --- 3. Regedit slots: 2000 ok, 2001 rejected ---
  const re2000 = mockInteraction('modal', 'admin:regedit:submit:slots:e1', { f_value: '2000' });
  await adminFlows.handle(re2000);
  ok('regedit: 2000 slots accepted', calls.includes('prisma.tournament.update'));
  const re2001 = mockInteraction('modal', 'admin:regedit:submit:slots:e1', { f_value: '2001' });
  await adminFlows.handle(re2001);
  ok('regedit: 2001 rejected', embedText(re2001._edit).includes('between 2 and 2000'));

  // --- 4. Registration: success message goes to DM ---
  state.dmShouldFail = false;
  const regIx = mockInteraction('select', 'event:tags:e1', {}, { values: ['u2', 'u3'] });
  await eventFlows.handle(regIx);
  ok('register: DM sent', calls.includes('user.send'));
  const dmDesc = regIx._dmPayload.embeds[0].data.description;
  ok('register: DM contains the success message', dmDesc.includes('Welcome to the arena!'));
  const replyText = embedText(regIx._edit);
  ok('register: success message NOT duplicated in reply when DM worked', !replyText.includes('Welcome to the arena!'));
  ok('register: reply still shows slot/group', replyText.includes('Slot 1') && replyText.includes('Group 1'));

  // --- 5. Registration: DM closed -> message falls back to the reply ---
  state.dmShouldFail = true;
  const regIx2 = mockInteraction('select', 'event:tags:e1', {}, { values: ['u2', 'u3'] });
  await eventFlows.handle(regIx2);
  const replyText2 = embedText(regIx2._edit);
  ok('register: success message in reply when DM fails', replyText2.includes('Welcome to the arena!'));
  ok('register: reply notes DMs may be closed', replyText2.includes('DMs may be closed'));

  console.log(`\n${n} create-fix tests passed`);
})().catch((e) => {
  console.error('TEST FAILURE:', e.message);
  process.exit(1);
});
