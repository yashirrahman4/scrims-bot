// Tests for: DM broadcast opt-out (mute button), muted filtering, unmute-all,
// throttled sends, and the router route for dm:optout.
// Run: node test-dm-optout.js
const assert = require('assert');
const calls = [];

// ---- stub ./src/db.js before any flow requires it ----
const sentPayloads = [];
const state = {
  upsertArgs: null,
  updateManyArgs: null,
  teams: [
    { id: 't1', tag: 'AAA', status: 'ACTIVE', owner: { discordId: 'u1', dmOptOut: false } },
    { id: 't2', tag: 'BBB', status: 'ACTIVE', owner: { discordId: 'u2', dmOptOut: true } },
    { id: 't3', tag: 'CCC', status: 'ACTIVE', owner: { discordId: 'u3', dmOptOut: false } },
  ],
};
function delegate(model) {
  return new Proxy(
    {},
    {
      get(_, op) {
        return async (args) => {
          calls.push(`prisma.${model}.${op}`);
          if (model === 'user' && op === 'upsert') {
            state.upsertArgs = args;
            return { id: 'dbu1', ...args.create };
          }
          if (model === 'user' && op === 'updateMany') {
            state.updateManyArgs = args;
            return { count: 1 };
          }
          if (model === 'user' && op === 'count') return 1; // one muted user
          if (model === 'team' && op === 'count') return 3;
          if (model === 'team' && op === 'findMany') return state.teams;
          if (model === 'auditLog' && op === 'create') return { id: 'a1' };
          if (model === 'guildSettings' && op === 'findUnique') {
            return { guildId: 'g1', groupSize: 20, adminRoleIds: ['role1'], logAdminActivity: null };
          }
          return null;
        };
      },
    }
  );
}
const prismaStub = new Proxy(
  {},
  { get(_, m) { if (m === '$executeRawUnsafe') return async () => {}; return delegate(m); } }
);
require.cache[require.resolve('./src/db.js')] = {
  id: require.resolve('./src/db.js'),
  filename: require.resolve('./src/db.js'),
  loaded: true,
  exports: { prisma: prismaStub },
};

const admin = require('./src/flows/admin');

let pass = 0;
const ok = (name, cond) => {
  assert(cond, name);
  pass++;
  console.log('  ✓', name);
};

function adminInteraction(overrides = {}) {
  const ix = {
    customId: 'admin:dm:yes',
    user: { id: 'admin1', tag: 'admin#1', username: 'admin1' },
    guildId: 'g1',
    member: { permissions: { has: () => true }, roles: { cache: [] } },
    guild: { members: { fetch: async () => ({ roles: { cache: ['role1'] } }) } },
    deferred: false, replied: false,
    isButton: () => true, isStringSelectMenu: () => false, isChannelSelectMenu: () => false,
    isRoleSelectMenu: () => false, isModalSubmit: () => false,
    isChatInputCommand: () => false,
    fields: { getTextInputValue: (k) => (k === 'dm_title' ? 'Server Update' : 'Hello teams!') },
    update: async (p) => { calls.push('update'); ix.lastUpdate = p; },
    deferUpdate: async () => { calls.push('deferUpdate'); ix.deferred = true; },
    deferReply: async () => { calls.push('deferReply'); ix.deferred = true; },
    editReply: async (p) => { calls.push('editReply'); ix.lastEdit = p; return p; },
    followUp: async (p) => { calls.push('followUp'); ix.lastFollowUp = p; return { edit: async (e) => { ix.statusEdits = [...(ix.statusEdits || []), e]; } }; },
    reply: async (p) => { calls.push('reply'); ix.lastReply = p; },
    client: {
      users: { fetch: async (id) => ({ send: async (payload) => { sentPayloads.push({ to: id, payload }); } }) },
    },
    ...overrides,
  };
  return ix;
}

(async () => {
  // ---------- 1. dm:optout handler (no admin gate) ----------
  console.log('opt-out:');
  calls.length = 0;
  const dmIx = {
    customId: 'dm:optout',
    user: { id: 'u9', username: 'player9', tag: 'player9#0' },
    guildId: null, // DMs have no guild
    deferUpdate: async () => { calls.push('deferUpdate'); },
    editReply: async (p) => { dmIx.lastEdit = p; },
  };
  await admin.handleDmOptOut(dmIx);
  const deferIdx = calls.indexOf('deferUpdate');
  const upsertIdx = calls.findIndex((c) => c === 'prisma.user.upsert');
  ok('deferUpdate before prisma upsert', deferIdx !== -1 && upsertIdx !== -1 && deferIdx < upsertIdx);
  ok('upsert targets the tapping user', state.upsertArgs.where.discordId === 'u9');
  ok('upsert sets dmOptOut=true', state.upsertArgs.update.dmOptOut === true && state.upsertArgs.create.dmOptOut === true);
  ok('confirmation mentions muting', dmIx.lastEdit.content.includes('Muted'));

  calls.length = 0;
  state.upsertArgs = null;
  await admin.handleDmOptOut({ customId: 'dm:something-else', deferUpdate: async () => {} });
  ok('ignores other dm: ids', state.upsertArgs === null);

  // ---------- 2. preview shows muted count + unmute button ----------
  console.log('preview:');
  calls.length = 0;
  const modalIx = adminInteraction({
    customId: 'admin:dm:modal',
    isButton: () => false, isModalSubmit: () => true,
  });
  await admin.handle(modalIx);
  ok('preview names muted count', modalIx.lastEdit.content.includes('Muted (skipped): **1**'));
  const previewBtns = modalIx.lastEdit.components.flatMap((r) => r.components.map((c) => c.data.custom_id));
  ok('preview has unmute-all button', previewBtns.includes('admin:dm:unmute'));
  ok('preview warns about report risk', modalIx.lastEdit.content.includes('reported'));

  // ---------- 3. broadcast skips muted, carries opt-out button ----------
  console.log('broadcast:');
  calls.length = 0;
  sentPayloads.length = 0;
  const yesIx = adminInteraction({ customId: 'admin:dm:yes' });
  await admin.handle(yesIx);
  const recipients = sentPayloads.map((s) => s.to).sort();
  ok('muted owner skipped', JSON.stringify(recipients) === JSON.stringify(['u1', 'u3']));
  const firstPayload = sentPayloads[0].payload;
  const dmBtns = firstPayload.components[0].components.map((c) => c.data.custom_id);
  ok('DM carries mute button', dmBtns.includes('dm:optout'));
  ok('DM footer mentions muting', firstPayload.embeds[0].data.footer.text.includes('🔕'));
  const finalStatus = yesIx.statusEdits[yesIx.statusEdits.length - 1].content;
  ok('final status reports muted skip', finalStatus.includes('**1** skipped (muted)') && finalStatus.includes('**2** delivered'));

  // ---------- 4. unmute-all ----------
  console.log('unmute:');
  calls.length = 0;
  state.updateManyArgs = null;
  // Re-create the draft (the yes-handler consumed it) so the preview re-renders.
  await admin.handle(adminInteraction({ customId: 'admin:dm:modal', isButton: () => false, isModalSubmit: () => true }));
  const unmuteIx = adminInteraction({ customId: 'admin:dm:unmute' });
  await admin.handle(unmuteIx);
  ok('unmute resets dmOptOut', state.updateManyArgs && state.updateManyArgs.data.dmOptOut === false);
  ok('unmute confirms + disables button', unmuteIx.lastEdit.content.includes('Unmuted') && unmuteIx.lastEdit.components[1].components[0].data.disabled === true);

  // ---------- 5. router route ----------
  console.log('router:');
  const routerSrc = require('fs').readFileSync('./src/router.js', 'utf8');
  ok("router routes dm: -> handleDmOptOut", routerSrc.includes("id.startsWith('dm:')") && routerSrc.includes('handleDmOptOut'));

  console.log(`\nAll ${pass} tests passed.`);
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
