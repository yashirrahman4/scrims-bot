/**
 * scrimport-1 tests: unknown bs: custom IDs must be ignored by every
 * flow router without throwing (synchronously or via rejection) and
 * without sending any reply. Handlers must not claim unknown IDs.
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

const mods = {
  scrims: require('./src/flows/scrims.js'),
  scrimgroups: require('./src/flows/scrimgroups.js'),
  scrimidp: require('./src/flows/scrimidp.js'),
  scrimadmin: require('./src/flows/scrimadmin.js'),
};

// IDs that match no known prefix in any of the four routers.
const UNKNOWN_IDS = [
  'bs:unknown:xyz',
  'bs:x',
  'bs::',
  'bs:teamx:1',       // near-miss of bs:team:
  'bs:panelx:remind:1', // near-miss of bs:panel:
  'bs:verifyx',       // near-miss of bs:verify
  'bs:ssidx:start:t', // near-miss of bs:ssidp:
  'bs:adminx:ban',    // near-miss of bs:admin:
  'bs:tply:list',     // near-miss of bs:tpl:
];

function fakeInteraction(customId) {
  let replied = false;
  const mark = () => { replied = true; };
  return {
    interaction: {
      customId,
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      isChatInputCommand: () => false,
      user: { id: 'u_test_1', tag: 'tester#0001' },
      guild: null,
      channel: null,
      reply: async () => { mark(); },
      deferReply: async () => { mark(); },
      deferUpdate: async () => { mark(); },
      editReply: async () => { mark(); },
      followUp: async () => { mark(); },
    },
    wasReplied: () => replied,
  };
}

(async () => {
  console.log('unknown bs: customId routing:');
  for (const [name, mod] of Object.entries(mods)) {
    ok(`${name}: exports handle()`, typeof mod.handle === 'function');
    for (const id of UNKNOWN_IDS) {
      const { interaction, wasReplied } = fakeInteraction(id);
      let threw = null;
      let result;
      try {
        result = await mod.handle(interaction);
      } catch (e) {
        threw = e;
      }
      ok(`${name}: "${id}" does not throw`, threw === null);
      ok(`${name}: "${id}" sends no reply`, wasReplied() === false);
      ok(`${name}: "${id}" not claimed as handled`, result === undefined || result === false);
    }
  }

  console.log('non-bs: IDs:');
  for (const [name, mod] of Object.entries(mods)) {
    const { interaction } = fakeInteraction('slot:swap:t9');
    let threw = null;
    try {
      await mod.handle(interaction);
    } catch (e) {
      threw = e;
    }
    ok(`${name}: foreign namespace "slot:swap:t9" does not throw`, threw === null);
  }

  console.log(`\n${passed} scrimport enforcement/routing tests passed.`);
})().catch((e) => {
  console.error('FAIL: routing test threw:', e);
  process.exitCode = 1;
});
