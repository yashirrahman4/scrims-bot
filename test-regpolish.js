// Tests for the registration-polish batch (regpolish-1):
//  - panel redesigns (registration post, team wizard, team card)
//  - tags 0-4 validation + compulsory tags/teams-per-group at creation
//  - Post Panel button, setup gate, ping role on start
// Run: node test-regpolish.js
const assert = require('assert');
const calls = [];
const state = { event: null, updates: [], sends: [] };

// ---- stub ./src/db.js before any flow requires it ----
const dbPath = require.resolve('./src/db.js');
function delegate(model) {
  return new Proxy(
    {},
    {
      get(_, op) {
        return async (args) => {
          calls.push(`prisma.${model}.${op}`);
          if (model === 'tournament' && op === 'findUnique') return state.event;
          if (model === 'tournament' && op === 'update') {
            state.updates.push(args.data);
            return { id: 'e1', ...args.data };
          }
          if (model === 'tournamentRegistration' && op === 'count') return 0;
          if (model === 'tournamentRegistration' && op === 'findFirst') return null;
          if (model === 'user' && op === 'upsert') return { id: 'dbu1', discordId: 'u1' };
          if (model === 'team' && op === 'findFirst') {
            return { id: 't1', name: 'Ravens', tag: 'BR', status: 'ACTIVE', members: [] };
          }
          if (model === 'guildSettings' && op === 'findUnique') return { guildId: 'g1', groupSize: 20, adminRoleIds: [] };
          if (model === 'auditLog' && op === 'create') return { id: 'a1' };
          if (model === 'idpGroup' && op === 'findFirst') return null;
          return null;
        };
      },
    }
  );
}
const prismaStub = new Proxy(
  {},
  {
    get(_, prop) {
      if (prop === '$transaction')
        return async (fn) =>
          fn({
            tournamentRegistration: {
              count: async () => 0,
              create: async ({ data }) => ({ id: 'r1', slotNo: 1, groupNo: 1, taggedDiscordIds: [], ...data }),
            },
          });
      if (prop === '$executeRawUnsafe') return async () => {};
      if (prop === '$queryRaw') return async () => [];
      return delegate(prop);
    },
  }
);
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { prisma: prismaStub } };

function mockInteraction(kind, customId, fields = {}, opts = {}) {
  const textChannel = (id) => ({
    id,
    isTextBased: () => true,
    send: async (payload) => {
      state.sends.push({ channelId: id, payload });
      return { id: 'msg-' + state.sends.length };
    },
    messages: { fetch: async () => null },
  });
  const ix = {
    customId,
    user: {
      id: 'u1',
      username: 'tester',
      send: async (payload) => {
        calls.push('user.send');
        ix._dmPayload = payload;
        return { id: 'dm1' };
      },
    },
    guildId: 'g1',
    guild: {
      members: { fetch: async () => null },
      roles: { fetch: async () => null },
      channels: { fetch: async (id) => textChannel(id) },
    },
    client: { guilds: { fetch: async () => ({ channels: { fetch: async (id) => textChannel(id) } }) } },
    member: { permissions: { has: () => true }, roles: { cache: [] } },
    replied: false,
    deferred: false,
    isButton: () => kind === 'button',
    isStringSelectMenu: () => kind === 'select',
    isChannelSelectMenu: () => false,
    isRoleSelectMenu: () => kind === 'roleselect',
    isUserSelectMenu: () => false,
    isModalSubmit: () => kind === 'modal',
    isChatInputCommand: () => false,
    fields: { getTextInputValue: (k) => (fields[k] !== undefined ? fields[k] : '') },
    values: opts.values || [],
    deferReply: async () => { calls.push('deferReply'); ix.deferred = true; },
    deferUpdate: async () => { calls.push('deferUpdate'); ix.deferred = true; },
    reply: async (p) => { calls.push('reply'); ix._reply = p; ix.replied = true; },
    update: async (p) => { calls.push('update'); ix._reply = p; ix.replied = true; },
    editReply: async (p) => { calls.push('editReply'); ix._edit = p; },
    followUp: async (p) => { calls.push('followUp'); ix._followUp = p; },
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
const editText = (ix) =>
  (ix._edit ? (ix._edit.content || '') + ' ' + (ix._edit.embeds || []).map((e) => `${e.data.title || ''} ${e.data.description || ''}`).join(' | ') : '');

function baseEvent(over = {}) {
  return {
    id: 'e1', name: 'Big Tourney', type: 'TOURNAMENT', status: 'DRAFT', date: null,
    teamLimit: 40, teamsPerGroup: 20, tagsRequired: 4, teamSize: 4,
    regStartsAt: null, regChannelId: 'regchan', logChannelId: 'logchan',
    successRoleId: 'sucrole', successMessage: 'Welcome!', pingRoleId: null,
    announceMsgId: null, announceChannelId: null, idpCategoryId: null,
    ...over,
  };
}

(async () => {
  // ---------- 1. creation validation: tags 0-4, compulsory ----------
  const modalFields = (tags, tpg) => ({ e_name: 'T', e_date: '', e_limit: '40', e_tags: tags, e_tpg: tpg });
  const m0 = mockInteraction('modal', 'admin:create:modal1:TOURNAMENT', modalFields('0', '20'));
  await adminFlows.handle(m0);
  ok('modal1: tags=0 accepted', /Step 1 saved/.test(m0._edit.content || ''));
  const m4 = mockInteraction('modal', 'admin:create:modal1:TOURNAMENT', modalFields('4', '20'));
  await adminFlows.handle(m4);
  ok('modal1: tags=4 accepted', /Step 1 saved/.test(m4._edit.content || ''));
  const m5 = mockInteraction('modal', 'admin:create:modal1:TOURNAMENT', modalFields('5', '20'));
  await adminFlows.handle(m5);
  ok('modal1: tags=5 rejected (0-4)', editText(m5).includes('between 0 and 4'));
  const mNeg = mockInteraction('modal', 'admin:create:modal1:TOURNAMENT', modalFields('-1', '20'));
  await adminFlows.handle(mNeg);
  ok('modal1: tags=-1 rejected', editText(mNeg).includes('between 0 and 4'));
  const mEmpty = mockInteraction('modal', 'admin:create:modal1:TOURNAMENT', modalFields('', '20'));
  await adminFlows.handle(mEmpty);
  ok('modal1: empty tags rejected as compulsory', editText(mEmpty).includes('compulsory'));
  const mTpgEmpty = mockInteraction('modal', 'admin:create:modal1:TOURNAMENT', modalFields('2', ''));
  await adminFlows.handle(mTpgEmpty);
  ok('modal1: empty teams-per-group rejected as compulsory', editText(mTpgEmpty).includes('compulsory'));
  const mTpgBad = mockInteraction('modal', 'admin:create:modal1:TOURNAMENT', modalFields('2', '101'));
  await adminFlows.handle(mTpgBad);
  ok('modal1: tpg=101 rejected (1-100)', editText(mTpgBad).includes('between 1 and 100'));

  // ---------- 2. regedit tags 0-4 ----------
  state.event = baseEvent();
  const re0 = mockInteraction('modal', 'admin:regedit:submit:tags:e1', { f_value: '0' });
  await adminFlows.handle(re0);
  ok('regedit: tags=0 accepted', state.updates.some((u) => u.tagsRequired === 0));
  state.updates.length = 0;
  const re5 = mockInteraction('modal', 'admin:regedit:submit:tags:e1', { f_value: '5' });
  await adminFlows.handle(re5);
  ok('regedit: tags=5 rejected', editText(re5).includes('between 0 and 4'));
  ok('regedit: rejected value not saved', !state.updates.some((u) => 'tagsRequired' in u));

  // ---------- 3. ?? 4 behavior ----------
  const team0 = { status: 'ACTIVE', members: [] };
  ok('checkEligibility: tagsRequired 0 passes with 0 starters', (await eventFlows.checkEligibility(baseEvent({ tagsRequired: 0, status: 'OPEN' }), team0)) === null);
  const need4 = await eventFlows.checkEligibility(baseEvent({ tagsRequired: 4, status: 'OPEN' }), team0);
  ok('checkEligibility: tagsRequired 4 still demands starters', need4 && need4.includes('at least 4 starters'));
  const needUnset = await eventFlows.checkEligibility(baseEvent({ status: 'OPEN', tagsRequired: undefined }), team0);
  ok('checkEligibility: unset tagsRequired defaults to 4', needUnset && needUnset.includes('at least 4 starters'));

  // ---------- 4. zero-tags registration skips the picker ----------
  state.event = baseEvent({ status: 'OPEN', tagsRequired: 0 });
  state.sends.length = 0;
  const regIx = mockInteraction('button', 'event:registerpost:e1');
  await eventFlows.handle(regIx);
  ok('tags=0: registration completed directly', regIx._edit && regIx._edit.embeds[0].data.title === '🎉 Registration Successful');
  ok('tags=0: no picker components in final payload', (regIx._edit.components || []).length === 0);
  ok('tags=0: DM sent with success message', regIx._dmPayload.embeds[0].data.description.includes('Welcome!'));

  // ---------- 5. setupGate ----------
  ok('gate: all set -> no missing', adminFlows.setupGate(baseEvent()).length === 0);
  ok('gate: names the missing items', JSON.stringify(adminFlows.setupGate(baseEvent({ logChannelId: null, successRoleId: null }))) === JSON.stringify(['Log Channel', 'Success Role']));
  ok('gate: missing reg channel flagged', adminFlows.setupGate(baseEvent({ regChannelId: null })).includes('Registration Channel'));

  // ---------- 6. start blocked by gate ----------
  state.event = baseEvent({ status: 'DRAFT', logChannelId: null });
  state.updates.length = 0;
  const startBlocked = mockInteraction('button', 'admin:reg:start:e1');
  await adminFlows.handle(startBlocked);
  ok('start: blocked when log channel missing', editText(startBlocked).includes('Log Channel'));
  ok('start: status untouched when blocked', !state.updates.some((u) => 'status' in u));

  // ---------- 7. post panel: gate + no status change + no ping ----------
  state.event = baseEvent({ status: 'DRAFT', pingRoleId: 'pingrole1' });
  state.updates.length = 0;
  state.sends.length = 0;
  const postIx = mockInteraction('button', 'admin:reg:postpanel:e1');
  await adminFlows.handle(postIx);
  ok('postpanel: announcement sent to reg channel', state.sends.some((s) => s.channelId === 'regchan'));
  ok('postpanel: status unchanged', !state.updates.some((u) => 'status' in u));
  ok('postpanel: ping role NOT mentioned', !state.sends.some((s) => typeof s.payload === 'string' && s.payload.includes('pingrole1')));
  ok('postpanel: confirm follow-up sent', !!(postIx._followUp && postIx._followUp.content.includes('posted')));

  state.event = baseEvent({ status: 'DRAFT', regChannelId: null });
  const postBlocked = mockInteraction('button', 'admin:reg:postpanel:e1');
  await adminFlows.handle(postBlocked);
  ok('postpanel: blocked when reg channel missing', editText(postBlocked).includes('Registration Channel'));

  // ---------- 8. start: ping sent exactly once ----------
  state.event = baseEvent({ status: 'DRAFT', pingRoleId: 'pingrole1' });
  state.updates.length = 0;
  state.sends.length = 0;
  const startIx = mockInteraction('button', 'admin:reg:start:e1');
  await adminFlows.handle(startIx);
  ok('start: status set OPEN', state.updates.some((u) => u.status === 'OPEN'));
  const pings = state.sends.filter((s) => typeof s.payload === 'string' && s.payload.includes('<@&pingrole1>'));
  ok('start: ping role mentioned exactly once', pings.length === 1);
  ok('start: ping message format', pings[0].payload.includes('is now OPEN'));

  state.event = baseEvent({ status: 'DRAFT', pingRoleId: null });
  state.sends.length = 0;
  const startNoPing = mockInteraction('button', 'admin:reg:start:e1');
  await adminFlows.handle(startNoPing);
  ok('start: no ping when role not set', !state.sends.some((s) => typeof s.payload === 'string' && s.payload.includes('🔔')));

  // ---------- 9. combined roles select saved ----------
  state.event = baseEvent();
  state.updates.length = 0;
  const rolesSel = mockInteraction('roleselect', 'admin:regmgr:roles:e1', {}, { values: ['success1', 'ping1'] });
  await adminFlows.handle(rolesSel);
  ok('roles select: success + ping saved', state.updates.some((u) => u.successRoleId === 'success1' && u.pingRoleId === 'ping1'));
  state.updates.length = 0;
  const rolesSelOne = mockInteraction('roleselect', 'admin:regmgr:roles:e1', {}, { values: ['success1'] });
  await adminFlows.handle(rolesSelOne);
  ok('roles select: single pick clears ping', state.updates.some((u) => u.successRoleId === 'success1' && u.pingRoleId === null));

  // ---------- 10. panel payloads well-formed ----------
  const pp = eventFlows.registrationPostPayload(baseEvent({ status: 'OPEN', tagsRequired: 0 }), 0);
  ok('post payload: Register button customId kept', pp.components[0].components[0].data.custom_id === 'event:registerpost:e1');
  ok('post payload: no row exceeds 5 buttons', pp.components.every((r) => r.components.length <= 5));
  const tagField = pp.embeds[0].data.fields.find((f) => f.name.includes('Tags'));
  ok('post payload: tags=0 shows "None"', tagField.value.includes('None'));
  ok('post payload: has Date/Slots/Status fields', ['🗓️ Date', '🎰 Slots', '📌 Status'].every((nm) => pp.embeds[0].data.fields.some((f) => f.name === nm)));
  ok('post payload: footer present', !!pp.embeds[0].data.footer);
  const ppFull = eventFlows.registrationPostPayload(baseEvent({ status: 'OPEN' }), 40);
  ok('post payload: Register disabled when full', ppFull.components[0].components[0].data.disabled === true);

  const rows = adminFlows.regManagerRows(baseEvent({ status: 'DRAFT' }), 'none');
  ok('reg manager: at most 5 rows (Discord limit)', rows.length <= 5);
  ok('reg manager: exactly 5 rows', rows.length === 5);
  ok('reg manager: no row exceeds 5 components', rows.every((r) => r.components.length <= 5));
  ok('reg manager: no row has >1 select', rows.every((r) => r.components.filter((c) => c.data.custom_id && /:(regch|logch|roles):/.test(c.data.custom_id)).length <= 1));
  const row2Labels = rows[1].components.map((c) => c.data.label).filter(Boolean);
  ok('reg manager: Post Panel next to Start Registration', row2Labels.includes('Post Panel') && row2Labels.includes('Start Registration'));
  const embed = adminFlows.regManagerEmbed(baseEvent({ regChannelId: null, logChannelId: null, successRoleId: null, pingRoleId: 'p1' }), 0, 'none');
  const fmap = Object.fromEntries(embed.data.fields.map((f) => [f.name, f.value]));
  ok('reg manager embed: missing gate fields flagged', fmap['Registration Channel'].includes('required') && fmap['Log Channel'].includes('required') && fmap['Success Role'].includes('required'));
  ok('reg manager embed: ping role shown', fmap['Ping Role'].includes('p1'));

  // ---------- 11. not-open message on the post's Register button ----------
  state.event = baseEvent({ status: 'DRAFT', tagsRequired: 0 });
  const earlyIx = mockInteraction('button', 'event:registerpost:e1');
  await eventFlows.handle(earlyIx);
  ok('register before start: clean "not open yet" message', editText(earlyIx).includes('not open yet'));

  console.log(`\n${n} regpolish tests passed`);
})().catch((e) => {
  console.error('TEST FAILURE:', e.message);
  process.exit(1);
});
