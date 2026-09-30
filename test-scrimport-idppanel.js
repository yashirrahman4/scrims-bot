/**
 * scrimport-7 tests:
 *  1. Scrims IDP schedule panel (tournament-style detail display, Edit +
 *     Lock/Unlock buttons, lock state derived from channel overwrites).
 *  2. Team-verification connection: ACTIVE team satisfies scrims verification
 *     for OQ/T3 registration (isVerifiedForScrims), verify panel auto-links,
 *     registration confirm transaction honors it.
 *  3. Router wiring for the new bs:panel:edit|lock|unlock + edit sub-flow.
 *
 * No Discord connection, no database needed.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0;
function ok(name, cond) {
  if (!cond) {
    console.error('FAIL:', name);
    process.exitCode = 1;
    return;
  }
  passed++;
}

(async () => {
  const panels = require('./src/scrimpanels');
  const scrims = require('./src/flows/scrims');
  const groups = require('./src/flows/scrimgroups');

  const group = { id: 'gid1', groupType: 'OQ', groupNo: 3, matchDate: new Date('2026-09-30T08:10:00Z') };
  const matches = [
    { matchNo: 1, map: 'Erangel', idpAt: new Date('2026-09-30T08:10:00Z'), startAt: new Date('2026-09-30T08:25:00Z') },
    { matchNo: 2, map: null, idpAt: null, startAt: null },
  ];

  // --- panel builder -------------------------------------------------------
  ok('scrimIdpPanelTitle format', panels.scrimIdpPanelTitle(group) === '🗂️ OQ G3 · Match Schedule');

  const locked = panels.scrimIdpPanel(group, matches, true);
  const desc = locked.embeds[0].data.description;
  const title = locked.embeds[0].data.title;
  ok('panel title matches canonical title', title === panels.scrimIdpPanelTitle(group));
  ok('panel shows Event line (tournament-style)', desc.includes('**🏆 Event:**'));
  ok('panel shows Matches Date line', desc.includes('**📅 Matches Date:** 2026-09-30'));
  ok('panel shows Total Slots = 21', desc.includes('**👥 Total Slots:** 21'));
  ok('panel shows Total Matches = 2', desc.includes('**🎮 Total Matches:** 2'));
  ok('panel shows per-match map', desc.includes('**Match 1** — 🗺️ Erangel'));
  ok('panel shows IDP AT / START AT', desc.includes('✨ IDP AT:') && desc.includes('🚀 START AT:'));
  ok('panel shows TBD for unset match', desc.includes('**Match 2** — 🗺️ _Not revealed yet_'));
  ok('locked footer text', locked.embeds[0].data.footer.text.includes('🔒 Group locked'));

  const btns = locked.components[0].components;
  ok('Edit button customId', btns[0].data.custom_id === 'bs:panel:edit:gid1');
  ok('locked panel offers Unlock Group', btns[1].data.custom_id === 'bs:panel:unlock:gid1' && btns[1].data.label === 'Unlock Group');

  const unlocked = panels.scrimIdpPanel(group, matches, false);
  const ubtns = unlocked.components[0].components;
  ok('unlocked panel offers Lock Group', ubtns[1].data.custom_id === 'bs:panel:lock:gid1' && ubtns[1].data.label === 'Lock Group');
  ok('unlocked footer text', unlocked.embeds[0].data.footer.text.includes('🔓 Group unlocked'));

  // --- merged single panel ---------------------------------------------------
  ok('merged panel has exactly 2 rows (schedule controls + staff management)', locked.components.length === 2);
  const mgmt = locked.components[1].components;
  const mgmtIds = mgmt.map((b) => b.data.custom_id);
  ok('merged row carries Match Reminder', mgmtIds[0] === 'bs:panel:remind:gid1' && mgmt[0].data.label === 'Match Reminder');
  ok('merged row carries Publish Slots', mgmtIds[1] === 'bs:panel:publish:gid1');
  ok('merged row carries Warn Team', mgmtIds[2] === 'bs:panel:warn:gid1');
  ok('merged row carries Remove Team', mgmtIds[3] === 'bs:panel:remove:gid1');
  ok('merged row carries Qualify', mgmtIds[4] === 'bs:panel:qualify:gid1');
  ok('Remove Team is Danger, Qualify is Success', mgmt[3].data.style === 4 && mgmt[4].data.style === 3);

  // --- reconcile sweep --------------------------------------------------------
  const fs = require('fs');
  const gsrcPanel = fs.readFileSync(__dirname + '/src/flows/scrimgroups.js', 'utf8');
  ok('reconcileScrimPanels exported', typeof groups.reconcileScrimPanels === 'function');
  ok('creation no longer posts legacy standalone groupPanel', !gsrcPanel.includes('channel.send(groupPanel('));
  ok('sweep deletes legacy panels only after merged panel exists', gsrcPanel.includes('Only remove the legacy message once the merged panel is definitely there'));
  ok('sweep detects legacy GROUP title', gsrcPanel.includes('🛡️ GROUP ${g.groupType}-${g.groupNo}'));
  const isrc = fs.readFileSync(__dirname + '/src/index.js', 'utf8');
  ok('startup calls reconcileScrimPanels', isrc.includes('reconcileScrimPanels(c)'));

  // --- isGroupLocked --------------------------------------------------------
  const { isGroupLocked } = groups._test;
  const ow = (allow, deny) => ({
    permissionOverwrites: { cache: new Map([['role1', { allow: { has: () => allow }, deny: { has: () => deny } }]]) },
  });
  ok('fail closed without channel', isGroupLocked(null, { roleId: 'role1' }) === true);
  ok('fail closed without roleId', isGroupLocked(ow(true, false), {}) === true);
  ok('fail closed without overwrite', isGroupLocked({ permissionOverwrites: { cache: new Map() } }, { roleId: 'role1' }) === true);
  ok('unlocked when allowed', isGroupLocked(ow(true, false), { roleId: 'role1' }) === false);
  ok('locked when denied', isGroupLocked(ow(false, true), { roleId: 'role1' }) === true);

  // --- isVerifiedForScrims ---------------------------------------------------
  const { isVerifiedForScrims } = scrims._test;
  ok('scrims row verified passes', isVerifiedForScrims({ scrimsVerified: true, hasVerifiedRole: false, team: null }) === true);
  ok('verified role passes', isVerifiedForScrims({ scrimsVerified: false, hasVerifiedRole: true, team: null }) === true);
  ok('ACTIVE team passes (team-verification connection)', isVerifiedForScrims({ scrimsVerified: false, hasVerifiedRole: false, team: { status: 'ACTIVE' } }) === true);
  ok('SUSPENDED team does not pass alone', isVerifiedForScrims({ scrimsVerified: false, hasVerifiedRole: false, team: { status: 'SUSPENDED' } }) === false);
  ok('nothing passes nothing', isVerifiedForScrims({ scrimsVerified: false, hasVerifiedRole: false, team: null }) === false);

  // --- wiring (source) -------------------------------------------------------
  const gsrc = read('src/flows/scrimgroups.js');
  ok('router: edit|lock|unlock buttons', gsrc.includes('id.match(/^bs:panel:(edit|lock|unlock):(.+)$/)'));
  ok('router: ematch select', gsrc.includes('id.match(/^bs:panel:ematch:(.+)$/)'));
  ok('router: emap select', gsrc.includes('id.match(/^bs:panel:emap:(.+)$/)'));
  ok('router: etimes button', gsrc.includes('id.match(/^bs:panel:etimes:(.+)$/)'));
  ok('router: edate button', gsrc.includes('id.match(/^bs:panel:edate:(.+)$/)'));
  ok('router: times modal', gsrc.includes('id.match(/^bs:panel:ematch:modal:(.+)$/)'));
  ok('router: date modal', gsrc.includes('id.match(/^bs:panel:edate:modal:(.+)$/)'));
  ok('creation posts the IDP panel locked', gsrc.includes('scrimIdpPanel(group, idpMatches, true)'));
  ok('lock toggles SendMessages+AttachFiles', gsrc.includes('{ SendMessages: false, AttachFiles: false }') && gsrc.includes('{ SendMessages: true, AttachFiles: true }'));
  ok('refreshScrimIdpPanel exported', typeof groups.refreshScrimIdpPanel === 'function');

  const ssrc = read('src/flows/scrims.js');
  ok('guardCheck uses isVerifiedForScrims', ssrc.includes('isVerifiedForScrims({ scrimsVerified, hasVerifiedRole, team })'));
  ok('confirm transaction honors team verification', ssrc.includes("if (!isVerifiedForScrims({ scrimsVerified, hasVerifiedRole: false, team })) throw new Error('NOT_VERIFIED')"));
  ok('onVerify auto-links team data', ssrc.includes('linkTeamVerification(interaction.user.id, interaction.guild)'));
  ok('registration links team data post-confirm', ssrc.includes('await linkTeamVerification(userId, interaction.guild)'));
  ok('linkTeamVerification exported for tests', typeof scrims._test.linkTeamVerification === 'function');

  console.log(`\n${passed} passed`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
