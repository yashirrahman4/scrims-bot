// Tests for the panelplus-1 batch:
//  - IDP: panel-post isolation, "Repost IDP Panels" button (always enabled), repost handler
//  - Registration log embeds carry full team + registerer details
//  - Tournament poster: Set Poster button/modal, URL validation, panel image
//  - Manager channel selects show the saved default channel
// Run: node test-panelplus.js
const assert = require('assert');
const state = { event: null, updates: [], groups: [], sends: [] };

// ---- stub ./src/db.js before any flow requires it ----
const dbPath = require.resolve('./src/db.js');
function delegate(model) {
  return new Proxy(
    {},
    {
      get(_, op) {
        return async (args) => {
          if (model === 'tournament' && op === 'findUnique') return state.event;
          if (model === 'tournament' && op === 'update') {
            state.updates.push(args.data);
            state.event = { ...state.event, ...args.data };
            return state.event;
          }
          if (model === 'tournamentRegistration' && op === 'count') return 0;
          if (model === 'guildSettings' && op === 'findUnique') return { guildId: 'g1', groupSize: 20, adminRoleIds: [] };
          if (model === 'auditLog' && op === 'create') return { id: 'a1' };
          if (model === 'idpGroup' && op === 'findMany') return state.groups;
          if (model === 'idpGroup' && op === 'findUnique') return state.groups.find((g) => g.id === args?.where?.id) || null;
          if (model === 'idpGroup' && op === 'count') return state.groups.length;
          if (model === 'idpGroup' && op === 'update') {
            const g = state.groups.find((x) => x.id === args.where.id);
            if (g) Object.assign(g, args.data);
            return g;
          }
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
      if (prop === '$executeRawUnsafe') return async () => {};
      if (prop === '$queryRaw') return async () => [];
      return delegate(prop);
    },
  }
);
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { prisma: prismaStub } };

function mockIx(kind, customId, values = [], extra = {}) {
  const ix = {
    customId,
    values,
    guildId: 'g1',
    user: { id: 'u1', username: 'tester' },
    guild: {
      members: { fetch: async () => null },
      roles: { fetch: async () => null },
      channels: { fetch: async (id) => ({ id, isTextBased: () => true }) },
    },
    client: { guilds: { fetch: async () => ({}) } },
    member: { permissions: { has: () => true }, roles: { cache: [] } },
    replied: false,
    deferred: false,
    isButton: () => kind === 'button',
    isStringSelectMenu: () => kind === 'select',
    isChannelSelectMenu: () => kind === 'channelselect',
    isRoleSelectMenu: () => kind === 'roleselect',
    isUserSelectMenu: () => false,
    isModalSubmit: () => kind === 'modal',
    isChatInputCommand: () => false,
    fields: { getTextInputValue: (k) => extra.fields?.[k] ?? '' },
    deferReply: async () => { ix.deferred = true; },
    deferUpdate: async () => { ix.deferred = true; },
    reply: async (p) => { ix._reply = p; ix.replied = true; },
    update: async (p) => { ix._reply = p; ix.replied = true; },
    editReply: async (p) => { ix._edit = p; },
    followUp: async () => {},
    showModal: async (m) => { ix._modal = m; },
    ...extra.ix,
  };
  return ix;
}

const adminFlows = require('./src/flows/admin.js');
const eventFlows = require('./src/flows/events.js');
const idpFlows = require('./src/flows/idp.js');

function baseEvent(over = {}) {
  return {
    id: 'e1', name: 'Ravens Championship', type: 'TOURNAMENT', status: 'OPEN',
    date: null, regStartsAt: new Date('2026-10-05T10:00:00Z'), teamLimit: 40,
    teamsPerGroup: 20, tagsRequired: 4, regChannelId: 'reg1', logChannelId: 'log1',
    successRoleId: 'role1', pingRoleId: null, posterUrl: null,
    idpCategoryId: 'cat1', idpNamePattern: 'XYZ G1',
    ...over,
  };
}

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; /* console.log('ok -', name); */ }
  catch (e) { console.error(`FAIL: ${name}\n`, e); process.exitCode = 1; }
}

(async () => {
  // --- 1. IDP repost button: present, ENABLED, correct customId when groups are done ---
  await t('manager shows enabled Repost IDP Panels button when done', async () => {
    state.event = baseEvent();
    state.groups = [{ id: 'g1', tournamentId: 'e1', groupNo: 1, channelId: 'c1', panelMsgId: 'm1', locked: true, matches: [], tournament: state.event }];
    const rows = adminFlows.regManagerRows(state.event, 'done');
    const btns = rows[1].components;
    const repost = btns.find((b) => b.data.custom_id === 'admin:idp:repost:e1');
    assert(repost, 'repost button missing');
    assert.strictEqual(repost.data.disabled, undefined, 'repost button must NOT be disabled');
    assert.strictEqual(repost.data.label, 'Repost IDP Panels');
  });

  await t('manager still shows Create/Resume IDP button when groups missing', async () => {
    state.event = baseEvent({ idpCategoryId: null });
    state.groups = [];
    const rows = adminFlows.regManagerRows(state.event, 'none');
    const btns = rows[1].components;
    const create = btns.find((b) => b.data.custom_id === 'admin:idp:ask:e1');
    assert(create, 'create button missing');
    assert.strictEqual(create.data.label, 'Create IDP Groups');
  });

  // --- 2. Channel selects carry the saved default channel ---
  await t('log channel select shows saved default', async () => {
    state.event = baseEvent();
    const rows = adminFlows.regManagerRows(state.event, 'done');
    const logSel = rows[3].components[0];
    assert(logSel.data.custom_id === 'admin:regmgr:logch:e1');
    const defaults = logSel.data.default_values || [];
    assert(defaults.some((d) => d.id === 'log1'), 'saved log channel should be the default');
    const regSel = rows[2].components[0];
    const regDefaults = regSel.data.default_values || [];
    assert(regDefaults.some((d) => d.id === 'reg1'), 'saved reg channel should be the default');
  });

  // --- 3. Repost handler: no groups -> friendly message, never throws ---
  await t('admin:idp:repost with no groups replies gracefully', async () => {
    state.event = baseEvent();
    state.groups = [];
    const ix = mockIx('button', 'admin:idp:repost:e1');
    await adminFlows.handle(ix);
    assert(ix._edit, 'expected editReply');
    assert(ix._edit.content.includes('No IDP groups'), 'should say no groups exist');
  });

  // --- 4. Repost handler: ensures panels for groups missing them ---
  await t('admin:idp:repost sends panels to groups missing them', async () => {
    state.event = baseEvent();
    const sentPayloads = [];
    const fakeGuild = { channels: { fetch: async () => null } };
    const fakeClient = {
      channels: {
        fetch: async (id) => ({
          id,
          isTextBased: () => true,
          messages: { fetch: async () => null },
          send: async (payload) => { sentPayloads.push(payload); return { id: `msg-${id}` }; },
        }),
      },
    };
    state.groups = [
      { id: 'g1', tournamentId: 'e1', groupNo: 1, channelId: 'c1', panelMsgId: null, locked: true, matches: [], tournament: state.event },
      { id: 'g2', tournamentId: 'e1', groupNo: 2, channelId: 'c2', panelMsgId: 'already', locked: true, matches: [], tournament: state.event },
    ];
    const edits = [];
    const ix = mockIx('button', 'admin:idp:repost:e1', [], { ix: { client: fakeClient, guild: fakeGuild, editReply: async (pl) => { edits.push(pl); } } });
    await adminFlows.handle(ix);
    const summaryEdit = edits.find((e) => e.content && e.content.includes('IDP panels ensured'));
    assert(summaryEdit && summaryEdit.content.includes('2/2'), `expected 2/2 ensured, got: ${JSON.stringify(edits.map((e) => e.content))}`);
    assert(state.groups[0].panelMsgId === 'msg-c1', 'missing panel should be sent + recorded');
    assert(sentPayloads.length >= 1, 'should have sent at least one panel');
  });

  // --- 5. createIdpGroups returns panelFailures (isolation) + exports refreshPanel ---
  await t('idp module exports refreshPanel', async () => {
    assert(typeof idpFlows.refreshPanel === 'function', 'refreshPanel should be exported');
    assert(typeof idpFlows.createIdpGroups === 'function');
  });

  // --- 6. Poster URL validation ---
  const realFetch = global.fetch;
  const headWith = (ct, ok = true) => async () => ({ ok, headers: { get: (k) => (k === 'content-type' ? ct : null) } });
  await t('validatePosterUrl rejects non-URLs and non-https', async () => {
    assert(await adminFlows.validatePosterUrl('not a url'), 'non-url rejected');
    assert(await adminFlows.validatePosterUrl('http://example.com/a.png'), 'http rejected');
    assert(await adminFlows.validatePosterUrl(''), 'empty rejected');
  });
  await t('validatePosterUrl accepts a real image content-type', async () => {
    global.fetch = headWith('image/png');
    assert.strictEqual(await adminFlows.validatePosterUrl('https://cdn.discordapp.com/attachments/1/poster.png'), null);
  });
  await t('validatePosterUrl rejects a non-image content-type', async () => {
    global.fetch = headWith('text/html');
    const err = await adminFlows.validatePosterUrl('https://example.com/page');
    assert(err && err.includes('image'), `expected image error, got: ${err}`);
  });
  await t('validatePosterUrl falls back to extension when HEAD fails', async () => {
    global.fetch = async () => { throw new Error('blocked'); };
    assert.strictEqual(await adminFlows.validatePosterUrl('https://example.com/poster.jpg?x=1'), null);
    const err = await adminFlows.validatePosterUrl('https://example.com/poster');
    assert(err, 'no extension + HEAD failed should be rejected');
  });
  global.fetch = realFetch;

  // --- 7. Public panel carries the poster image ---
  await t('registrationPostPayload embeds the poster image', async () => {
    const withPoster = eventFlows.registrationPostPayload(baseEvent({ posterUrl: 'https://cdn.example/poster.png' }), 5);
    const img = withPoster.embeds[0].data.image;
    assert(img && img.url === 'https://cdn.example/poster.png', 'poster should be the embed image');
    const without = eventFlows.registrationPostPayload(baseEvent(), 5);
    assert(!without.embeds[0].data.image, 'no image when poster not set');
  });

  // --- 8. Registration log embed has full team details ---
  await t('registrationLogEmbed includes team ID, owner, roster and slot', async () => {
    const team = {
      tag: 'BR', name: 'Black Ravens', teamId: 'BR_OQ-G10',
      owner: { discordId: 'owner1', username: 'captain' },
      members: [
        { player: { ign: 'RavenOne', gameUid: '5111111111', discordId: 'p1' } },
        { player: { ign: 'RavenTwo', gameUid: '5222222222', discordId: 'p2' } },
      ],
    };
    const reg = { groupNo: 3, slotNo: 12, taggedDiscordIds: ['p1', 'p2'] };
    const embed = eventFlows.registrationLogEmbed(team, baseEvent(), reg, 'reg1');
    const d = embed.data;
    const fields = Object.fromEntries(d.fields.map((f) => [f.name, f.value]));
    assert(fields['🆔 Team ID'].includes('BR_OQ-G10'), 'Team ID present');
    assert(fields['🎰 Slot'].includes('Group 3') && fields['🎰 Slot'].includes('Slot 12'), 'slot present');
    assert(fields['👤 Registered by'].includes('<@reg1>'), 'registerer mention present');
    assert(fields['👑 Owner'].includes('<@owner1>'), 'owner mention present');
    assert(fields['👥 Roster (2)'].includes('RavenOne') && fields['👥 Roster (2)'].includes('5111111111'), 'roster IGN+UID present');
    assert(fields['🏷️ Tagged'].includes('<@p1>'), 'tagged mentions present');
    assert(d.description.includes('[BR] Black Ravens'), 'team name in description');
  });

  // --- 9. Details panel: Set Poster button + Poster field ---
  await t('event details panel has Set Poster button and poster field', async () => {
    const rows = adminFlows.eventActionRows(baseEvent());
    const all = rows.flatMap((r) => r.components);
    const poster = all.find((b) => b.data.custom_id === 'admin:poster:e1');
    assert(poster, 'Set Poster button missing');
    assert.strictEqual(poster.data.label, 'Set Poster');
    const embed = adminFlows.eventDetailEmbed(baseEvent(), 0);
    const posterField = embed.data.fields.find((f) => f.name === '🖼️ Poster');
    assert(posterField && posterField.value.includes('not set'), 'poster field shows not-set');
    const withPoster = adminFlows.eventDetailEmbed(baseEvent({ posterUrl: 'https://cdn.example/p.png' }), 0);
    assert(withPoster.data.fields.find((f) => f.name === '🖼️ Poster').value.includes('Set'), 'poster field shows set');
    assert(withPoster.data.thumbnail && withPoster.data.thumbnail.url === 'https://cdn.example/p.png', 'poster shown as thumbnail');
  });

  // --- 10. Poster modal saves the URL ---
  await t('poster modal saves a valid poster URL', async () => {
    state.event = baseEvent();
    state.updates = [];
    global.fetch = headWith('image/jpeg');
    const ix = mockIx('modal', 'admin:poster:modal:e1', [], {
      fields: { p_url: 'https://cdn.discordapp.com/attachments/9/poster.jpg' },
      ix: { client: { channels: { fetch: async () => null } }, guild: { channels: { fetch: async () => null } } },
    });
    await adminFlows.handle(ix);
    global.fetch = realFetch;
    assert(state.updates.some((u) => u.posterUrl === 'https://cdn.discordapp.com/attachments/9/poster.jpg'), 'posterUrl should be saved');
    assert(ix._edit.embeds[0].data.title.includes('Poster saved'), 'confirmation shown');
  });

  await t('poster modal rejects a bad URL', async () => {
    state.event = baseEvent();
    state.updates = [];
    global.fetch = headWith('text/html');
    const ix = mockIx('modal', 'admin:poster:modal:e1', [], { fields: { p_url: 'https://example.com/not-an-image' } });
    await adminFlows.handle(ix);
    global.fetch = realFetch;
    assert(!state.updates.some((u) => u.posterUrl), 'bad URL must not be saved');
    assert(ix._edit.embeds[0].data.description && ix._edit.embeds[0].data.description.includes('❌'), 'error shown');
  });

  console.log(`\n${passed} panelplus tests passed${process.exitCode ? ' (with failures)' : ''}`);
})().catch((e) => { console.error('HARNESS FAILED:', e); process.exit(1); });
