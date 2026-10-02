/**
 * Tests for the 2026-10-02 four-fix batch:
 * 1. slot-waste warning DM to team leader (owner)
 * 2. manual scrims-ban DM to the banned team leader
 * 3. qualification_results template receives owner_mention
 * 4. live lobby panel: public refresh button, debounced event-driven refresh,
 *    overlap guard, components preserved on edit
 * No Discord connection, no DB needed (static + unit checks).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

const groupsSrc = fs.readFileSync(path.join(__dirname, 'src/flows/scrimgroups.js'), 'utf8');
const adminSrc = fs.readFileSync(path.join(__dirname, 'src/flows/scrimadmin.js'), 'utf8');
const scrimsSrc = fs.readFileSync(path.join(__dirname, 'src/flows/scrims.js'), 'utf8');

// --- 1. warning DM ---
ok('warn flow DMs the team leader on plain warnings (not just bans)',
  groupsSrc.includes('Slot-waste warning ${warningNo}/${MAX_WARNINGS}') &&
  groupsSrc.includes('ownerUser.send({ content: dmText })'));
ok('warn DM covers the auto-ban case too',
  groupsSrc.includes('has been scrims-banned for ${BAN_DAYS} days (slot-waste warning #${warningNo}'));
ok('warn DM is best-effort (never throws on closed DMs)',
  groupsSrc.includes('if (ownerUser) await ownerUser.send({ content: dmText }).catch(() => {});'));

// --- 2. manual ban DM ---
ok('manual scrims ban DMs the banned user',
  adminSrc.includes('You have been banned from Black Raven scrims') &&
  adminSrc.includes("await interaction.client.users.fetch(discordId)"));
ok('manual ban DM is best-effort',
  adminSrc.includes('[scrimadmin] ban DM failed:'));

// --- 3. results owner mention ---
const { render } = require('./src/services/scrimmsgtemplate')._test;
const rendered = render(
  '{trophy_emoji} **{group_type} RESULT**\n**CAPTAIN:** {owner_mention}',
  { trophy_emoji: '🏆', group_type: 'OQ', owner_mention: '<@123>' }
);
ok('template render substitutes owner_mention', rendered.includes('<@123>') && !rendered.includes('{owner_mention}'));
ok('qualify passes owner_mention to qualification_results',
  groupsSrc.includes("resultsText = await tpl.renderTemplate('qualification_results', {") &&
  /renderTemplate\('qualification_results', \{[^}]*owner_mention: ownerMention/s.test(groupsSrc));

// --- 4. lobby refresh ---
const scrimAdmin = require('./src/flows/scrimadmin.js');
ok('scheduleLobbyRefresh is exported', typeof scrimAdmin.scheduleLobbyRefresh === 'function');
ok('refreshAllLobbyPanels is exported', typeof scrimAdmin.refreshAllLobbyPanels === 'function');

// Debounce: two rapid calls => single timer; returns without throwing and without a client.
scrimAdmin.scheduleLobbyRefresh(null);
scrimAdmin.scheduleLobbyRefresh(null);
ok('scheduleLobbyRefresh(null) never throws', true);

ok('lobby refresh button is routed publicly (not admin-gated)',
  adminSrc.includes("if (id === 'bs:lobby:refresh') return handleLobbyRefreshPublic(interaction);"));
ok('lobby refresh no longer sits behind requireAdmin handleButton path',
  !adminSrc.includes("id === 'bs:lobby:refresh'\n    ) {"));
ok('refresh has an overlap guard', adminSrc.includes('if (lobbyRefreshRunning) return 0;'));
ok('refresh preserves the Refresh button components on edit',
  adminSrc.includes('components: msg.components.map((c) => c.toJSON())'));
ok('event-driven refresh wired: registration', scrimsSrc.includes('scheduleLobbyRefresh(interaction.client);'));
ok('event-driven refresh wired: group create', groupsSrc.includes('New open group — lobby counts changed'));
ok('event-driven refresh wired: warn auto-ban', groupsSrc.includes('Lobby counts changed (slot freed)'));
ok('event-driven refresh wired: qualify close', groupsSrc.includes('Group closed — lobby counts changed'));

console.log(`\n${passed} four-fix tests passed`);
