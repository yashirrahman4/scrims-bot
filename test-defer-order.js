// Verifies the defer-first fix: for every DB-touching handler, the FIRST
// interaction acknowledge (deferReply/deferUpdate) must happen BEFORE the
// first Prisma call. Run: node test-defer-order.js
const path = require('path');
const calls = [];

// ---- stub ./src/db.js before any flow requires it ----
const dbPath = require.resolve('./src/db.js');
function delegate(model) {
  return new Proxy(
    {},
    {
      get(_, op) {
        return async (...args) => {
          calls.push(`prisma.${model}.${op}`);
          if (op === 'findMany' || op === 'groupBy') {
            if (model === 'tournament') {
              return [
                { id: 'e1', name: 'Test Scrim', type: 'SCRIM', status: 'OPEN', date: null, teamLimit: 20, format: 'Scrims — Points Table', maps: [], teamSize: 4, tagsRequired: 4, inviteUrl: null },
              ];
            }
            return [];
          }
          if (op === 'count') return 0;
          if (op === 'findUnique' && model === 'tournament') {
            return { id: 'e1', name: 'Test Scrim', type: 'SCRIM', status: 'OPEN', date: null, teamLimit: 20, format: 'x', maps: ['Erangel'], teamSize: 4, tagsRequired: 4, inviteUrl: null };
          }
          if (op === 'upsert' && model === 'user') return { id: 'dbu1' };
          if (op === 'findFirst' && model === 'team') return null;
          if (op === 'findUnique' && model === 'guildSettings') return null;
          if (op === 'findUnique' && model === 'idpGroup') {
            return {
              id: 'g1', tournamentId: 'e1', groupNo: 1, channelId: 'c1', categoryId: 'cat1',
              locked: true, matchesDate: null, totalMatches: 1, panelMsgId: 'm1', idpRoleHolderId: null,
              tournament: { id: 'e1', name: 'Test Tourney', type: 'TOURNAMENT', teamsPerGroup: 20 },
              matches: [{ id: 'm1', idpGroupId: 'g1', matchNo: 1, map: 'Erangel', idpAt: null, startAt: null }],
            };
          }
          if (op === 'findUnique' && model === 'idpMatch') {
            return { id: 'm1', idpGroupId: 'g1', matchNo: 1, map: 'Erangel', idpAt: null, startAt: null };
          }
          if (op === 'create' && model === 'guildSettings') {
            return { guildId: 'g1', maps: ['Erangel'], teamSize: 4, maxSubs: 2, teamIdPrefix: 'BR', adminRoleIds: [], groupSize: 20 };
          }
          return null;
        };
      },
    }
  );
}
const txProxy = new Proxy({}, { get: (_, m) => (m === '$transaction' ? async (fn) => { calls.push('prisma.$transaction'); return fn(txProxy); } : delegate(m)) });
const prismaStub = new Proxy(
  {},
  {
    get(_, prop) {
      if (prop === '$transaction') return async (fn) => { calls.push('prisma.$transaction'); return fn(txProxy); };
      if (prop === '$queryRaw') return async () => { calls.push('prisma.$queryRaw'); return []; };
      return delegate(prop);
    },
  }
);
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { prisma: prismaStub } };

function mockInteraction(kind, customId, fields = {}) {
  const ix = {
    customId,
    user: { id: 'u1', username: 'tester' },
    guildId: 'g1',
    guild: {
      members: { fetch: async () => null },
      roles: { fetch: async () => null, create: async () => null },
      channels: { fetch: async () => null },
    },
    member: { permissions: { has: () => true }, roles: { cache: [] } },
    replied: false,
    deferred: false,
    isButton: () => kind === 'button',
    isStringSelectMenu: () => kind === 'select',
    isModalSubmit: () => kind === 'modal',
    isUserSelectMenu: () => kind === 'userselect',
    isChannelSelectMenu: () => false,
    isChatInputCommand: () => false,
    fields: { getTextInputValue: (k) => fields[k] || '' },
    values: ['e1'],
    channel: { isTextBased: () => true, name: 'test', send: async () => {} },
    client: { guilds: { fetch: async () => null }, users: { fetch: async () => null } },
    deferReply: async () => { calls.push('deferReply'); ix.deferred = true; },
    deferUpdate: async () => { calls.push('deferUpdate'); ix.deferred = true; },
    reply: async () => { calls.push('reply'); ix.replied = true; },
    update: async () => { calls.push('update'); ix.replied = true; },
    editReply: async () => { calls.push('editReply'); },
    followUp: async () => { calls.push('followUp'); },
    showModal: async () => { calls.push('showModal'); ix.replied = true; },
  };
  return ix;
}

const teamFlows = require('./src/flows/team.js');
const eventFlows = require('./src/flows/events.js');
const adminFlows = require('./src/flows/admin.js');

const idpFlows = require('./src/flows/idp.js');

const cases = [
  // [label, flow, kind, customId, fields]
  ['team:my', teamFlows, 'button', 'team:my'],
  ['team:leave', teamFlows, 'button', 'team:leave'],
  ['team:manage', teamFlows, 'button', 'team:manage'],
  ['team:leave:yes', teamFlows, 'button', 'team:leave:yes'],
  ['team:disband:yes', teamFlows, 'button', 'team:disband:yes'],
  ['team:wiz:editplayers', teamFlows, 'button', 'team:wiz:editplayers'],
  ['team:wiz:players (select)', teamFlows, 'select', 'team:wiz:players'],
  ['team:remove:select', teamFlows, 'select', 'team:remove:select:x'],
  ['team:wiz:modal1', teamFlows, 'modal', 'team:wiz:modal1', { t_name: 'Test Team', t_tag: 'TT', t_email: '', t_phone: '' }],
  ['team:edit:modal', teamFlows, 'modal', 'team:edit:modal', { t_name: 'x', t_tag: 'TT', t_email: '', t_phone: '', t_region: '' }],
  ['scrim:register', eventFlows, 'button', 'scrim:register'],
  ['tournament:register', eventFlows, 'button', 'tournament:register'],
  ['scrim:my', eventFlows, 'button', 'scrim:my'],
  ['scrim:unregister', eventFlows, 'button', 'scrim:unregister'],
  ['event:pick (select)', eventFlows, 'select', 'event:pick:SCRIM'],
  ['event:confirm', eventFlows, 'button', 'event:confirm:e1'],
  ['event:tags (userselect)', eventFlows, 'userselect', 'event:tags:e1'],
  ['event:registerpost', eventFlows, 'button', 'event:registerpost:e1'],
  ['event:unreg:yes', eventFlows, 'button', 'event:unreg:yes:r1'],
  ['event:unreg:pick (select)', eventFlows, 'select', 'event:unreg:pick:SCRIM'],
  ['admin:events', adminFlows, 'button', 'admin:events'],
  ['admin:regs', adminFlows, 'button', 'admin:regs'],
  ['admin:logs', adminFlows, 'button', 'admin:logs'],
  ['admin:event:delete:yes', adminFlows, 'button', 'admin:event:delete:yes:e1'],
  ['admin:event:open', adminFlows, 'button', 'admin:event:open:e1'],
  ['admin:regs:view', adminFlows, 'button', 'admin:regs:view:e1'],
  ['admin:reg:approve', adminFlows, 'button', 'admin:reg:approve:r1'],
  ['admin:reg:approveall', adminFlows, 'button', 'admin:reg:approveall:e1'],
  ['admin:team:disband:yes', adminFlows, 'button', 'admin:team:disband:yes:t1'],
  ['admin:regmgr', adminFlows, 'button', 'admin:regmgr:e1'],
  ['admin:regmgr:back', adminFlows, 'button', 'admin:regmgr:back:e1'],
  ['admin:regedit:name', adminFlows, 'button', 'admin:regedit:name:e1'],
  ['admin:reg:start', adminFlows, 'button', 'admin:reg:start:e1'],
  ['admin:reg:close', adminFlows, 'button', 'admin:reg:close:e1'],
  ['admin:regmgr:regch (select)', adminFlows, 'select', 'admin:regmgr:regch:e1'],
  ['admin:regmgr:logch (select)', adminFlows, 'select', 'admin:regmgr:logch:e1'],
  ['admin:regmgr:roles (select)', adminFlows, 'select', 'admin:regmgr:roles:e1'],
  ['admin:regedit:submit:name', adminFlows, 'modal', 'admin:regedit:submit:name:e1', { f_value: 'New Name' }],
  ['admin:regedit:submit:slots', adminFlows, 'modal', 'admin:regedit:submit:slots:e1', { f_value: '20' }],
  ['admin:regedit:submit:tags', adminFlows, 'modal', 'admin:regedit:submit:tags:e1', { f_value: '4' }],
  ['admin:regedit:submit:starttime', adminFlows, 'modal', 'admin:regedit:submit:starttime:e1', { f_value: '2026-10-01 18:00' }],
  ['admin:regedit:submit:successmsg', adminFlows, 'modal', 'admin:regedit:submit:successmsg:e1', { f_value: 'Welcome!' }],
  ['admin:team:suspend', adminFlows, 'button', 'admin:team:suspend:t1'],
  ['admin:player:rm', adminFlows, 'button', 'admin:player:rm:m1'],
  ['admin:lock:do', adminFlows, 'button', 'admin:lock:do:lock:c1'],
  ['admin:event:pick (select)', adminFlows, 'select', 'admin:event:pick'],
  ['admin:regs:pick (select)', adminFlows, 'select', 'admin:regs:pick'],
  ['admin:reg:pick (select)', adminFlows, 'select', 'admin:reg:pick'],
  ['admin:team:pick (select)', adminFlows, 'select', 'admin:team:pick'],
  ['admin:player:pick (select)', adminFlows, 'select', 'admin:player:pick'],
  ['admin:player:rmteam (select)', adminFlows, 'select', 'admin:player:rmteam:p1'],
  ['admin:lock:ch (select)', adminFlows, 'select', 'admin:lock:ch'],
  ['admin:create:type (select)', adminFlows, 'select', 'admin:create:type'],
  ['admin:create:modal1', adminFlows, 'modal', 'admin:create:modal1:SCRIM', { e_name: 'S1', e_date: '', e_limit: '20', e_tags: '4' }],
  ['admin:create:modal2', adminFlows, 'modal', 'admin:create:modal2:tok', { e_desc: '', e_regstart: '', e_successmsg: '' }],
  ['admin:teams:search', adminFlows, 'modal', 'admin:teams:search', { q: 'TT' }],
  ['admin:players:search', adminFlows, 'modal', 'admin:players:search', { q: 'x' }],
  ['admin:dm:modal', adminFlows, 'modal', 'admin:dm:modal', { dm_title: 'T', dm_message: 'M' }],
  ['admin:settings:modal', adminFlows, 'modal', 'admin:settings:modal', { s_teamsize: '4', s_maxsubs: '2', s_prefix: 'BR', s_maps: 'Erangel', s_adminroles: '' }],
  ['admin:settings:reg:modal', adminFlows, 'modal', 'admin:settings:reg:modal', { s_groupsize: '20' }],
  ['admin:team:edit:modal', adminFlows, 'modal', 'admin:team:edit:modal:t1', { t_name: 'x', t_tag: 'TT', t_logo: '', t_region: '' }],
  ['admin:announce:modal', adminFlows, 'modal', 'admin:announce:modal:c1', { a_title: 'T', a_message: 'M' }],
  ['admin:logs:pick (select)', adminFlows, 'select', 'admin:log:pick'],
  ['admin:log:ch (select)', adminFlows, 'select', 'admin:log:ch:verify'],
  ['admin:log:clear', adminFlows, 'button', 'admin:log:clear:verify'],
  ['admin:logs:activity', adminFlows, 'button', 'admin:logs:activity'],
  ['admin:idp:ask', adminFlows, 'button', 'admin:idp:ask:e1'],
  ['admin:idp:no', adminFlows, 'button', 'admin:idp:no:e1'],
  ['admin:idp:yes', adminFlows, 'button', 'admin:idp:yes:e1'],
  ['admin:regedit:submit:tpg', adminFlows, 'modal', 'admin:regedit:submit:tpg:e1', { f_value: '16' }],
  ['idp:edit', idpFlows, 'button', 'idp:edit:g1'],
  ['idp:edate', idpFlows, 'button', 'idp:edate:g1'],
  ['idp:slotlist', idpFlows, 'button', 'idp:slotlist:g1'],
  ['idp:punish', idpFlows, 'button', 'idp:punish:g1'],
  ['idp:qualify', idpFlows, 'button', 'idp:qualify:g1'],
  ['idp:cancelslot', idpFlows, 'button', 'idp:cancelslot:g1'],
  ['idp:remind', idpFlows, 'button', 'idp:remind:g1'],
  ['idp:lock', idpFlows, 'button', 'idp:lock:g1'],
  ['idp:transferrole', idpFlows, 'button', 'idp:transferrole:g1'],
  ['idp:ematch (select)', idpFlows, 'select', 'idp:ematch:g1'],
  ['idp:ematch:modal', idpFlows, 'modal', 'idp:ematch:modal:m1', { m_map: 'Miramar', m_idpat: '1:00 PM', m_startat: '1:10 PM' }],
  ['idp:edate:modal', idpFlows, 'modal', 'idp:edate:modal:g1', { d_date: '2026-10-05' }],
  ['idp:remind:modal', idpFlows, 'modal', 'idp:remind:modal:g1', { r_title: 'T', r_message: 'M' }],
];

(async () => {
  let pass = 0, fail = 0;
  for (const [label, flow, kind, customId, fields] of cases) {
    calls.length = 0;
    const ix = mockInteraction(kind, customId, fields);
    try { await flow.handle(ix); } catch (e) { calls.push('THREW:' + e.message); }
    const deferIdx = calls.findIndex((c) => c === 'deferReply' || c === 'deferUpdate' || c === 'showModal' || c === 'reply' || c === 'update');
    const prismaIdx = calls.findIndex((c) => c.startsWith('prisma.'));
    const firstAck = deferIdx === -1 ? '(none)' : calls[deferIdx];
    // showModal must be the first ack (Discord forbids defer-then-modal), so it
    // is allowed as the first acknowledge even if a quick DB read preceded it.
    const ok = prismaIdx === -1 || (deferIdx !== -1 && deferIdx < prismaIdx) || firstAck === 'showModal';
    if (ok) { pass++; }
    else { fail++; console.log(`FAIL ${label}: first ack=${firstAck}, order=${calls.slice(0, 6).join(' -> ')}`); }
  }
  console.log(`\n${pass} passed, ${fail} failed out of ${cases.length} handlers`);
  process.exit(fail ? 1 : 0);
})();
