# Discord Scrims & Tournament Operations Bot

discord.js bot (Node 20) + Prisma + PostgreSQL for BGMI scrims and tournament operations.
Covers the full architecture: **team verification → scrim/tournament registration → admin operations**, with
audit logging throughout.

## What it does

**Team Verification panel** (matches your reference design)
- 🧾 Register Team — one team per owner; team name, tag, logo, region
- Add starters + substitutes (counts come from Settings; default 4 + 2)
- Validation: one Discord account per player, no fake/duplicate tags, **UID checked against the in-game name**
  (UID must be unique and already-registered UIDs must match the same IGN)
- Generates a Team ID like `BR_OQ-G10` and creates/assigns a team Discord role
- ✏️ My Team, 🛠️ Team Manager (edit info, add/remove players, sync roles, disband), 🚪 Leave Team

**Scrim Registration panel** — pick an open scrim → eligibility checks (team ownership, roster size,
region, slot availability) → confirm → `PENDING` registration. View / cancel registrations.

**Tournament Registration panel** — same flow for tournaments.

**Admin Control Panel**
- 🗓️ Create Event — scrim or tournament; name, description, format, date (IST), team limit, region, maps, team size
- 🎛️ Manage Events — open / lock / go live / complete / cancel / delete
- 📝 View Registrations — approve / disqualify / remove per team, or approve-all-pending
- 👥 Manage Teams — search, view, edit, suspend, activate, disband
- 🎮 Manage Players — search by UID/IGN, view, remove from team
- 📢 Announce — send an embed announcement to any channel
- 🔒 Lock/Unlock channels (tournament-time channel control)
- ✉️ DM Owners — broadcast a DM to **every active team owner** (with delivery report)
- 🧾 Logs — recent audit log
- ⚙️ Settings — team size, max subs, team-ID prefix, maps, admin role IDs

Deliberately **no payments and no ban/kick features**.

## Black Raven scrims port (`2026-09-30.scrimport-1`)

The full Black Raven scrims lifecycle is ported alongside the existing tournament structure
(which is untouched): two tracks (OQ + T3) with identical mechanics.

**Flow** — scrims verification (auto-approved, one profile reused for OQ + T3) → OQ/T3 registration
(group pick + confirm, lowest free slot 5–25, closes 15 min before Match 1 IDP) → `/create_group`
(auto-numbered, private channel + role, 21 slots 5–25, 2 matches at IDP + 6 min) → group management
panel (match reminder, publish slots, warn / remove / qualify team) → SS-IDP (screenshot → Tesseract
OCR extracts room ID/password; `/ss_idp manual` fallback) → timed reminders (IDP −30/−5 min, match-day
ping, slot list auto-posted 15 min before Match 1, result-screenshot reminder) → qualification
(qualified role, group close) → slot-waste enforcement (cumulative warnings → auto temp-ban) →
cleanup (channel + role deleted 3 h after results).

**Panels** (via `/setup-panel`): `BR Scrims Verification` (`br_verify`), `BR OQ Registration`
(`br_oq`), `BR T3 Registration` (`br_t3`), `BR Scrims Admin` (`br_admin`), `BR Live Lobby` (`br_lobby`).

**Extra tools**: `/message_template` (runtime message templates), `/bot_health` (self-diagnostics),
`/export scrim` (Excel export), scrims ban/unban/list, scrim-only team deletion with JSON backup +
restore, live lobby occupancy panels, automatic vacancy DM to subscribed teams when a slot frees.

**Fixed vs the source**: DB-backed form sessions (no in-memory loss), consistent IST parsing,
no hardcoded channel/role IDs (all env/config), SS-IDP pings the group's own role, slots validated
5–25, modular handlers (no monolithic router), graceful OCR fallback.

## Requirements

- Node.js 20+, PostgreSQL 14+
- A Discord application + bot token with the **Server Members intent** enabled
  (Discord Developer Portal → your app → Bot → Privileged Gateway Intents → Server Members Intent)
- Bot role placed **above** the team roles it creates, with Manage Roles permission

## VPS setup (manual)

```bash
# 1. copy the project to your VPS, then:
cd discord-scrims-bot
npm install

# 2. configure
cp .env.example .env
nano .env   # DISCORD_TOKEN, CLIENT_ID, GUILD_ID, DATABASE_URL

# 3. database
npx prisma migrate deploy   # creates all tables

# 4. register the /setup-panel slash command
npm run deploy:commands

# 5. run (pick one)
node src/index.js
# or with pm2:
npm i -g pm2 && pm2 start ecosystem.config.js && pm2 save && pm2 startup
```

## VPS setup (docker compose)

```bash
cp .env.example .env
nano .env   # DISCORD_TOKEN, CLIENT_ID, GUILD_ID (DATABASE_URL is overridden by compose)
npm run deploy:commands   # needs DATABASE_URL reachable; or run once manually
docker compose up -d --build
```

## Posting the panels

In your Discord server, as an admin, run in each target channel:

- `/setup-panel panel:Team Verification` → #team-verification
- `/setup-panel panel:Scrim Registration` → #scrim-registration
- `/setup-panel panel:Tournament Registration` → #tournament-registration
- `/setup-panel panel:Admin Control Panel` → private #admin-panel

## Configuration

Open the Admin Panel → **Settings** (or edit per-server `GuildSettings` row):
- **Team size** — starters required per team (customizable)
- **Max substitutes**
- **Team ID prefix** (default `BR`)
- **Maps** — default `Erangel, Miramar, Rondo`; events validate against this list
- **Admin role IDs** — extra roles treated as bot admins (server Administrators always count)

## Notes & limits

- The UID↔IGN check is a **consistency + uniqueness** check inside the bot's database
  (a UID can only ever map to one IGN, one Discord account per player). Live verification
  against Krafton's servers would need an official API and is not included.
- DM broadcast sends ~1 message/0.75s to respect rate limits; owners with closed DMs are
  counted as failed and listed in the report.
- Everything admin/staff does is written to `AuditLog` (viewable from the Admin Panel → Logs).
- Back up Postgres regularly (`pg_dump`) — it holds all teams, players and registrations.

## Project layout

```
prisma/schema.prisma      # PostgreSQL schema (Users, Teams, Players, TeamMembers,
                          #   Tournaments, TournamentRegistrations, AuditLogs, GuildSettings)
src/index.js              # client entrypoint
src/router.js             # interaction router
src/commands.js           # /setup-panel definition
src/panels.js             # the 4 panel embeds + buttons
src/flows/team.js         # team verification flow
src/flows/events.js       # scrim + tournament registration flows
src/flows/admin.js        # admin operations
src/utils.js              # validation, team IDs, roles, audit
scripts/deploy-commands.js
```
