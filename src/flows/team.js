const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  EmbedBuilder,
} = require('discord.js');
const { prisma } = require('../db');
const {
  getSettings,
  getOrCreateUser,
  getOwnedTeam,
  getAnyTeamFor,
  isValidUid,
  isValidIgn,
  isValidTag,
  generateTeamId,
  extractDiscordId,
  errorEmbed,
  successEmbed,
  rosterLines,
  audit,
  sendLogEmbed,
} = require('../utils');

/** userId -> wizard draft: { name, tag, email, phone, playerIds: [discordId], details: { discordId: {ign, uid} }, createdAt } */
const pendingTeams = new Map();
const DRAFT_TTL_MS = 20 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[+\d][\d\s\-()]{5,19}$/;

function getDraft(userId) {
  const d = pendingTeams.get(userId);
  if (!d) return null;
  if (Date.now() - d.createdAt > DRAFT_TTL_MS) {
    pendingTeams.delete(userId);
    return null;
  }
  return d;
}

async function handle(interaction) {
  try {
    if (interaction.isButton()) return handleButton(interaction);
    if (interaction.isModalSubmit()) return handleModal(interaction);
    if (interaction.isUserSelectMenu()) return handleUserSelect(interaction);
    if (interaction.isStringSelectMenu()) return handleSelect(interaction);
  } catch (err) {
    console.error('[team] error:', err);
    try {
      if (interaction.deferred) {
        await interaction.editReply({ content: null, embeds: [errorEmbed('Something went wrong. Please try again.')], components: [] });
      } else if (!interaction.replied) {
        await interaction.reply({ embeds: [errorEmbed('Something went wrong. Please try again.')], ephemeral: true });
      }
    } catch {}
  }
}

// ---------- shared helpers ----------

// ---------- wizard payloads ----------

/** Step 2: player multi-select (shown after the step-1 modal). */
function wizSelectPayload(draft, settings) {
  const maxPlayers = settings.teamSize + settings.maxSubs;
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🛡️ Team Registration')
    .setDescription(`**${draft.name} [${draft.tag}]**\n✅ Step 1 of 3 complete — now select your players.`)
    .addFields(
      { name: '👥 Team', value: `**${draft.name}**\nTag: \`${draft.tag}\``, inline: true },
      { name: '✉️ Contact', value: `${draft.email || '—'}\n${draft.phone || '—'}`, inline: true },
      {
        name: '🎮 Select Players',
        value: `Pick **${settings.teamSize}–${maxPlayers}** players for the team (including yourself if you play).`,
      }
    )
    .setFooter({ text: 'Step 2 of 3 • Player selection' });
  const select = new UserSelectMenuBuilder()
    .setCustomId('team:wiz:players')
    .setPlaceholder('Select team players')
    .setMinValues(Math.min(settings.teamSize, 25))
    .setMaxValues(Math.min(maxPlayers, 25));
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)], ephemeral: true };
}

/** Step 3: per-player IGN/UID details board. */
function wizDetailsPayload(draft, settings) {
  const total = draft.playerIds.length;
  const set = draft.playerIds.filter((id) => draft.details[id]);
  const lines = draft.playerIds.map((id, i) => {
    const d = draft.details[id];
    const mark = d ? '✅' : '⬜';
    return `${mark} **P${i + 1}** <@${id}> — IGN: ${d ? `\`${d.ign}\`` : '*not set*'} · UID: ${d ? `\`${d.uid}\`` : '*not set*'}`;
  });
  const allSet = total >= settings.teamSize && set.length === total;
  const remaining = total - set.length;
  const embed = new EmbedBuilder()
    .setColor(allSet ? 0x57f287 : 0x5865f2)
    .setTitle('🛡️ Team Registration')
    .setDescription(
      `**${draft.name} [${draft.tag}]**\n` +
        `**Player Details** — ${set.length}/${total} complete\n\n` +
        (allSet ? '✅ All details set — press **Submit**!' : `⚠️ Set IGN + UID for **${remaining}** more player${remaining === 1 ? '' : 's'} to continue.`)
    )
    .addFields({ name: '📝 Roster', value: lines.join('\n').slice(0, 1000) || '—' })
    .setFooter({ text: 'Step 3 of 3 • Player details' });
  const rows = [];
  let row = new ActionRowBuilder();
  draft.playerIds.forEach((id, i) => {
    if (row.components.length === 5) {
      rows.push(row);
      row = new ActionRowBuilder();
    }
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`team:wiz:set:${id}`)
        .setLabel(`Set P${i + 1} Details`)
        .setStyle(draft.details[id] ? ButtonStyle.Success : ButtonStyle.Secondary)
    );
  });
  rows.push(row);
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('team:wiz:editplayers').setLabel('Add/Remove Players').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('team:wiz:back').setLabel('Back').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('team:wiz:cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('team:wiz:submit').setLabel('Submit').setStyle(ButtonStyle.Success).setDisabled(!allSet)
    )
  );
  return { embeds: [embed], components: rows, ephemeral: true };
}

function wizStep1Modal(draft) {
  const modal = new ModalBuilder().setCustomId('team:wiz:modal1').setTitle('Team Registration (1/2)');
  const mk = (cid, label, required, max, value, placeholder) =>
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId(cid)
        .setLabel(label)
        .setStyle(TextInputStyle.Short)
        .setRequired(required)
        .setMaxLength(max)
        .setValue(value || '')
        .setPlaceholder(placeholder || '')
    );
  modal.addComponents(
    mk('t_name', 'Team Name', true, 32, draft?.name),
    mk('t_tag', 'Team Tag (2-6 letters/numbers)', true, 6, draft?.tag),
    mk('t_email', 'Email (optional)', false, 64, draft?.email, 'team@example.com'),
    mk('t_phone', 'Phone Number (optional)', false, 20, draft?.phone, '+91 98765 43210')
  );
  return modal;
}

async function buildPlayerEntry(ignRaw, uidRaw, discordRaw, existingList) {
  const ign = (ignRaw || '').trim();
  const uid = (uidRaw || '').trim();
  if (!isValidIgn(ign)) return { error: 'In-game name must be 3–16 characters (letters, numbers, spaces, _).' };
  if (!isValidUid(uid)) return { error: 'BGMI UID must be 5–12 digits.' };
  const discordId = extractDiscordId(discordRaw);
  if (discordId === false) return { error: 'Discord field must be a user mention / user ID, or left blank.' };
  if (existingList.some((p) => p.uid === uid)) return { error: `UID \`${uid}\` is already added to this team.` };
  if (discordId && existingList.some((p) => p.discordId === discordId)) {
    return { error: 'This Discord account is already added to this team.' };
  }
  // UID <-> IGN consistency check (the "automatic UID vs in-game name" check)
  const existingPlayer = await prisma.player.findUnique({ where: { gameUid: uid } });
  if (existingPlayer && existingPlayer.ign.toLowerCase() !== ign.toLowerCase()) {
    return { error: `UID \`${uid}\` is already registered under a different in-game name (**${existingPlayer.ign}**).` };
  }
  if (discordId) {
    const dupe = await prisma.player.findUnique({ where: { discordId } });
    if (dupe && dupe.gameUid !== uid) {
      return { error: 'This Discord account is already linked to another player (one account per player).' };
    }
  }
  return { entry: { ign, uid, discordId: discordId || null } };
}

/** Create the team's Discord role if missing and assign it to the given users. */
async function ensureTeamRole(guild, team, discordIds) {
  let role = null;
  if (team.roleId) role = await guild.roles.fetch(team.roleId).catch(() => null);
  if (!role) {
    role = await guild.roles.create({
      name: `[${team.tag}] ${team.name}`.slice(0, 100),
      reason: `Team verified: ${team.teamId}`,
    });
    await prisma.team.update({ where: { id: team.id }, data: { roleId: role.id } });
    team.roleId = role.id;
  }
  for (const id of new Set((discordIds || []).filter(Boolean))) {
    const member = await guild.members.fetch(id).catch(() => null);
    if (member) await member.roles.add(role).catch(() => {});
  }
  return role;
}

function teamCardEmbed(team, relation) {
  const embed = new EmbedBuilder()
    .setColor(0x0b7a4b)
    .setTitle(`🛡️ ${team.name} [${team.tag}]`)
    .setDescription(`Team ID: \`${team.teamId}\``)
    .addFields(
      { name: '📌 Status', value: `\`${team.status}\``, inline: true },
      { name: '🌍 Region', value: team.region || '—', inline: true },
      { name: '👑 Owner', value: `<@${team.owner.discordId}>`, inline: true }
    );
  if (relation === 'OWNER' && (team.email || team.phone)) {
    embed.addFields({ name: '✉️ Contact', value: [team.email, team.phone].filter(Boolean).join('\n'), inline: true });
  }
  embed
    .addFields({ name: `👥 Roster (${team.members.length})`, value: rosterLines(team).join('\n').slice(0, 1000) || '—' })
    .setFooter({ text: relation === 'OWNER' ? 'You own this team • manage it from Team Manager' : `You are on this team (${relation})` });
  if (team.logo) embed.setThumbnail(team.logo);
  return embed;
}

async function playerModal(kind) {
  const modal = new ModalBuilder()
    .setCustomId(`team:player:modal:${kind}`)
    .setTitle(kind === 'starter' ? 'Add Starter' : 'Add Substitute');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('p_ign').setLabel('In-Game Name (IGN)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(16)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('p_uid').setLabel('BGMI UID (numbers only)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(12)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('p_discord')
        .setLabel('Discord (mention or user ID, optional)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setPlaceholder('@player or 123456789012345678')
    )
  );
  return modal;
}

// ---------- buttons ----------

async function handleButton(interaction) {
  const id = interaction.customId;

  if (id === 'team:register') {
    const dbUser = await getOrCreateUser(interaction.user);
    const existing = await getOwnedTeam(dbUser.id);
    if (existing) {
      return interaction.reply({
        embeds: [errorEmbed(`You already own a team (**${existing.tag}**). One team per owner.`)],
        ephemeral: true,
      });
    }
    return interaction.showModal(wizStep1Modal(null));
  }

  if (id === 'team:my') {
    await interaction.deferReply({ ephemeral: true });
    const dbUser = await getOrCreateUser(interaction.user);
    const { team, relation } = await getAnyTeamFor(interaction.user.id, dbUser.id);
    if (!team) return interaction.editReply({ embeds: [errorEmbed('You are not on any team yet. Register one to get started.')] });
    return interaction.editReply({ embeds: [teamCardEmbed(team, relation)] });
  }

  if (id === 'team:leave') {
    await interaction.deferReply({ ephemeral: true });
    const dbUser = await getOrCreateUser(interaction.user);
    const { team, relation } = await getAnyTeamFor(interaction.user.id, dbUser.id);
    if (!team) return interaction.editReply({ embeds: [errorEmbed('You are not on any team.')] });
    if (relation === 'OWNER') {
      return interaction.editReply({ embeds: [errorEmbed('You own this team. Use Team Manager to disband it instead.')] });
    }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('team:leave:yes').setLabel('Yes, leave').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('team:leave:no').setLabel('Stay').setStyle(ButtonStyle.Secondary)
    );
    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(0xf1c40f).setDescription(`Leave **${team.name} [${team.tag}]**?`)],
      components: [row],
    });
  }

  if (id === 'team:leave:yes' || id === 'team:leave:no') {
    if (id === 'team:leave:no') return interaction.update({ content: 'Cancelled — you are still on the team.', embeds: [], components: [] });
    await interaction.deferUpdate();
    const dbUser = await getOrCreateUser(interaction.user);
    const { team, relation } = await getAnyTeamFor(interaction.user.id, dbUser.id);
    if (!team || relation === 'OWNER') return interaction.editReply({ content: 'Nothing to do.', embeds: [], components: [] });
    const membership = await prisma.teamMember.findFirst({
      where: { teamId: team.id, player: { discordId: interaction.user.id } },
    });
    if (membership) await prisma.teamMember.delete({ where: { id: membership.id } });
    if (team.roleId) {
      const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
      if (member) await member.roles.remove(team.roleId).catch(() => {});
    }
    await audit('TEAM_LEAVE', interaction.user.id, `${team.tag} left by ${interaction.user.username}`);
    return interaction.editReply({ content: `✅ You left **${team.name} [${team.tag}]**.`, embeds: [], components: [] });
  }

  if (id === 'team:manage') {
    await interaction.deferReply({ ephemeral: true });
    const dbUser = await getOrCreateUser(interaction.user);
    const team = await getOwnedTeam(dbUser.id);
    if (!team) return interaction.editReply({ embeds: [errorEmbed('You do not own a team. Register one first.')] });
    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('team:edit').setLabel('Edit Info').setStyle(ButtonStyle.Primary).setEmoji('✏️'),
      new ButtonBuilder().setCustomId('team:manage:add:starter').setLabel('Add Starter').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('team:manage:add:sub').setLabel('Add Sub').setStyle(ButtonStyle.Secondary)
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('team:manage:remove').setLabel('Remove Player').setStyle(ButtonStyle.Secondary).setEmoji('➖'),
      new ButtonBuilder().setCustomId('team:role:sync').setLabel('Sync Roles').setStyle(ButtonStyle.Secondary).setEmoji('🔄'),
      new ButtonBuilder().setCustomId('team:disband').setLabel('Disband Team').setStyle(ButtonStyle.Danger).setEmoji('💥')
    );
    return interaction.editReply({ embeds: [teamCardEmbed(team, 'OWNER')], components: [row1, row2] });
  }

  if (id.startsWith('team:wiz:set:')) {
    const draft = getDraft(interaction.user.id);
    if (!draft) return interaction.reply({ embeds: [errorEmbed('Session expired. Start again with Register Team.')], ephemeral: true });
    const discordId = id.split(':')[3];
    if (!draft.playerIds.includes(discordId)) {
      return interaction.reply({ embeds: [errorEmbed('This player is not in your selection. Use Add/Remove Players first.')], ephemeral: true });
    }
    const modal = new ModalBuilder().setCustomId(`team:wiz:playermodal:${discordId}`).setTitle('Player Details');
    const d = draft.details[discordId] || {};
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('p_ign').setLabel('In-Game Name (IGN)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(16).setValue(d.ign || '')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('p_uid').setLabel('BGMI UID (numbers only)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(12).setValue(d.uid || '')
      )
    );
    return interaction.showModal(modal);
  }

  if (id === 'team:wiz:editplayers') {
    const draft = getDraft(interaction.user.id);
    if (!draft) return interaction.reply({ embeds: [errorEmbed('Session expired. Start again with Register Team.')], ephemeral: true });
    await interaction.deferUpdate();
    const settings = await getSettings(interaction.guildId);
    return interaction.editReply(wizSelectPayload(draft, settings));
  }

  if (id === 'team:wiz:back') {
    const draft = getDraft(interaction.user.id);
    if (!draft) return interaction.reply({ embeds: [errorEmbed('Session expired. Start again with Register Team.')], ephemeral: true });
    return interaction.showModal(wizStep1Modal(draft));
  }

  if (id === 'team:wiz:cancel') {
    pendingTeams.delete(interaction.user.id);
    return interaction.update({ content: 'Registration draft discarded.', embeds: [], components: [] });
  }

  if (id === 'team:wiz:submit') {
    const draft = getDraft(interaction.user.id);
    if (!draft) return interaction.reply({ embeds: [errorEmbed('Session expired. Start again with Register Team.')], ephemeral: true });
    const settings = await getSettings(interaction.guildId);
    const missing = draft.playerIds.filter((pid) => !draft.details[pid]);
    if (draft.playerIds.length < settings.teamSize || missing.length) {
      return interaction.reply({
        embeds: [errorEmbed(`Set IGN + UID for every player (need at least ${settings.teamSize} players with details).`)],
        ephemeral: true,
      });
    }
    await interaction.deferUpdate();
    try {
      const dbUser = await getOrCreateUser(interaction.user);
      const stillOwned = await getOwnedTeam(dbUser.id);
      if (stillOwned) {
        return interaction.editReply({ content: null, embeds: [errorEmbed(`You already own a team (**${stillOwned.tag}**).`)], components: [] });
      }
      const teamIdStr = await generateTeamId(settings.teamIdPrefix);
      // First `teamSize` players are starters, the rest are substitutes.
      const roster = draft.playerIds.map((pid, i) => ({
        discordId: pid,
        ign: draft.details[pid].ign,
        uid: draft.details[pid].uid,
        role: i < settings.teamSize ? 'PLAYER' : 'SUB',
      }));
      const team = await prisma.$transaction(async (tx) => {
        const t = await tx.team.create({
          data: {
            teamId: teamIdStr,
            name: draft.name,
            tag: draft.tag,
            email: draft.email || null,
            phone: draft.phone || null,
            ownerId: dbUser.id,
          },
        });
        for (const p of roster) {
          const player = await tx.player.upsert({
            where: { gameUid: p.uid },
            update: { ign: p.ign, discordId: p.discordId },
            create: { gameUid: p.uid, ign: p.ign, discordId: p.discordId },
          });
          await tx.teamMember.create({ data: { teamId: t.id, playerId: player.id, role: p.role } });
        }
        return t;
      });
      pendingTeams.delete(interaction.user.id);
      let roleNote = '';
      try {
        await ensureTeamRole(interaction.guild, team, [interaction.user.id, ...draft.playerIds]);
      } catch (e) {
        console.error('[team] role assign failed:', e.message);
        roleNote = '\n⚠️ Could not create/assign the Discord role automatically — ask an admin to check bot permissions.';
      }
      await audit('TEAM_REGISTER', interaction.user.id, `${team.tag} (${team.teamId}) verified with ${roster.length} players`);
      const starters = roster.filter((p) => p.role === 'PLAYER').length;
      const subs = roster.length - starters;
      await sendLogEmbed(
        interaction.client,
        interaction.guildId,
        settings.logTeamVerify,
        new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle('🛡️ Team Verified')
          .setDescription(
            `**${team.name} [${team.tag}]** — Team ID \`${team.teamId}\`\n` +
              `Owner: <@${interaction.user.id}>\n` +
              `Players: ${roster.length} (${starters} starters${subs ? `, ${subs} substitutes` : ''})\n\n` +
              roster.map((p, i) => `P${i + 1} **${p.ign}** — UID \`${p.uid}\``).join('\n').slice(0, 1500)
          )
      );
      return interaction.editReply({
        content: null,
        embeds: [
          new EmbedBuilder()
            .setColor(0x57f287)
            .setTitle('🎉 Registration Submitted')
            .setDescription(
              `**${team.name} [${team.tag}]** is now verified for scrims.\n\n` +
                `• Team ID: \`${team.teamId}\`\n` +
                `• Players: ${starters} starters${subs ? `, ${subs} substitutes` : ''}${roleNote}`
            ),
        ],
        components: [],
      });
    } catch (err) {
      console.error('[team] wizard submit error:', err);
      return interaction.editReply({ content: null, embeds: [errorEmbed(`Could not complete registration: ${err.message}`)], components: [] });
    }
  }

  if (id === 'team:edit') {
    const dbUser = await getOrCreateUser(interaction.user);
    const team = await getOwnedTeam(dbUser.id);
    if (!team) return interaction.reply({ embeds: [errorEmbed('You do not own a team.')], ephemeral: true });
    const modal = new ModalBuilder().setCustomId('team:edit:modal').setTitle('Edit Team Info');
    const mk = (cid, label, value, max) =>
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId(cid).setLabel(label).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(max).setValue(value || '')
      );
    modal.addComponents(
      mk('t_name', 'Team Name', team.name, 32),
      mk('t_tag', 'Team Tag (2-6 letters/numbers)', team.tag, 6),
      mk('t_email', 'Email', team.email, 64),
      mk('t_phone', 'Phone Number', team.phone, 20),
      mk('t_region', 'Region', team.region, 32)
    );
    return interaction.showModal(modal);
  }

  if (id === 'team:manage:add:starter' || id === 'team:manage:add:sub') {
    const dbUser = await getOrCreateUser(interaction.user);
    const team = await getOwnedTeam(dbUser.id);
    if (!team) return interaction.reply({ embeds: [errorEmbed('You do not own a team.')], ephemeral: true });
    const settings = await getSettings(interaction.guildId);
    const kind = id.endsWith('starter') ? 'starter' : 'sub';
    const count = team.members.filter((m) => m.role === (kind === 'starter' ? 'PLAYER' : 'SUB')).length;
    const limit = kind === 'starter' ? settings.teamSize : settings.maxSubs;
    if (count >= limit) return interaction.reply({ embeds: [errorEmbed(`No free ${kind} slots (limit ${limit}).`)], ephemeral: true });
    const modal = await playerModal(kind);
    modal.setCustomId(`team:playeradd:modal:${kind}:${team.id}`);
    modal.setTitle(kind === 'starter' ? 'Add Starter to Team' : 'Add Substitute to Team');
    return interaction.showModal(modal);
  }

  if (id === 'team:manage:remove') {
    const dbUser = await getOrCreateUser(interaction.user);
    const team = await getOwnedTeam(dbUser.id);
    if (!team) return interaction.reply({ embeds: [errorEmbed('You do not own a team.')], ephemeral: true });
    if (!team.members.length) return interaction.reply({ embeds: [errorEmbed('No players to remove.')], ephemeral: true });
    const select = new StringSelectMenuBuilder()
      .setCustomId(`team:remove:select:${team.id}`)
      .setPlaceholder('Select a player to remove')
      .addOptions(
        team.members.slice(0, 25).map((m) => ({
          label: `${m.player.ign} (${m.role})`.slice(0, 100),
          value: m.id,
          description: `UID ${m.player.gameUid}`.slice(0, 100),
        }))
      );
    return interaction.reply({
      content: 'Select a player to remove from the team:',
      components: [new ActionRowBuilder().addComponents(select)],
      ephemeral: true,
    });
  }

  if (id === 'team:role:sync') {
    const dbUser = await getOrCreateUser(interaction.user);
    const team = await getOwnedTeam(dbUser.id);
    if (!team) return interaction.reply({ embeds: [errorEmbed('You do not own a team.')], ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    const discordIds = [team.owner.discordId, ...team.members.map((m) => m.player.discordId)];
    await ensureTeamRole(interaction.guild, team, discordIds);
    await interaction.editReply({ embeds: [successEmbed('Team role synced to all roster members.')] });
    return;
  }

  if (id === 'team:disband') {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('team:disband:yes').setLabel('Yes, disband').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('team:disband:no').setLabel('Keep team').setStyle(ButtonStyle.Secondary)
    );
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0xed4245).setDescription('⚠️ Disband your team? This removes the roster and the team role. This cannot be undone.')],
      components: [row],
      ephemeral: true,
    });
  }

  if (id === 'team:disband:yes' || id === 'team:disband:no') {
    if (id === 'team:disband:no') return interaction.update({ content: 'Cancelled.', embeds: [], components: [] });
    await interaction.deferUpdate();
    const dbUser = await getOrCreateUser(interaction.user);
    const team = await getOwnedTeam(dbUser.id);
    if (!team) return interaction.editReply({ content: 'No team found.', embeds: [], components: [] });
    await prisma.team.update({ where: { id: team.id }, data: { status: 'DISBANDED' } });
    if (team.roleId) {
      const role = await interaction.guild.roles.fetch(team.roleId).catch(() => null);
      if (role) await role.delete('Team disbanded').catch(() => {});
    }
    await audit('TEAM_DISBAND', interaction.user.id, `${team.tag} (${team.teamId}) disbanded`);
    {
      const logSettings = await getSettings(interaction.guildId);
      await sendLogEmbed(
        interaction.client,
        interaction.guildId,
        logSettings.logTeamVerify,
        new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle('🛡️ Team Disbanded')
          .setDescription(`**${team.name} [${team.tag}]** — Team ID \`${team.teamId}\`\nOwner: <@${interaction.user.id}>`)
      );
    }
    return interaction.editReply({ content: `✅ **${team.name} [${team.tag}]** has been disbanded.`, embeds: [], components: [] });
  }
}

// ---------- modals ----------

async function handleModal(interaction) {
  const id = interaction.customId;

  if (id === 'team:wiz:modal1') {
    await interaction.deferReply({ ephemeral: true });
    const name = interaction.fields.getTextInputValue('t_name').trim();
    const tag = interaction.fields.getTextInputValue('t_tag').trim().toUpperCase();
    const email = interaction.fields.getTextInputValue('t_email').trim();
    const phone = interaction.fields.getTextInputValue('t_phone').trim();
    if (!isValidTag(tag)) {
      return interaction.editReply({ embeds: [errorEmbed('Team tag must be 2–6 letters/numbers, no spaces.')] });
    }
    if (email && !EMAIL_RE.test(email)) {
      return interaction.editReply({ embeds: [errorEmbed('That email address does not look valid.')] });
    }
    if (phone && !PHONE_RE.test(phone)) {
      return interaction.editReply({ embeds: [errorEmbed('That phone number does not look valid.')] });
    }
    const prev = getDraft(interaction.user.id);
    const tagTaken = await prisma.team.findFirst({ where: { tag, status: { not: 'DISBANDED' } } });
    if (tagTaken && tagTaken.tag !== prev?.tag) {
      return interaction.editReply({ embeds: [errorEmbed(`Tag **${tag}** is already taken.`)] });
    }
    const nameTaken = await prisma.team.findFirst({ where: { name, status: { not: 'DISBANDED' } } });
    if (nameTaken && nameTaken.name !== prev?.name) {
      return interaction.editReply({ embeds: [errorEmbed(`Team name **${name}** is already taken.`)] });
    }
    pendingTeams.set(interaction.user.id, {
      name,
      tag,
      email: email || null,
      phone: phone || null,
      playerIds: prev?.playerIds || [],
      details: prev?.details || {},
      createdAt: prev?.createdAt || Date.now(),
    });
    const settings = await getSettings(interaction.guildId);
    return interaction.editReply(wizSelectPayload(pendingTeams.get(interaction.user.id), settings));
  }

  if (id.startsWith('team:wiz:playermodal:')) {
    const discordId = id.split(':')[3];
    const draft = getDraft(interaction.user.id);
    if (!draft) return interaction.reply({ embeds: [errorEmbed('Session expired. Start again with Register Team.')], ephemeral: true });
    if (!draft.playerIds.includes(discordId)) {
      return interaction.reply({ embeds: [errorEmbed('This player is not in your selection.')], ephemeral: true });
    }
    await interaction.deferUpdate();
    const existingList = draft.playerIds
      .filter((pid) => pid !== discordId && draft.details[pid])
      .map((pid) => ({ uid: draft.details[pid].uid, discordId: pid }));
    const { entry, error } = await buildPlayerEntry(
      interaction.fields.getTextInputValue('p_ign'),
      interaction.fields.getTextInputValue('p_uid'),
      `<@${discordId}>`,
      existingList
    );
    if (error) return interaction.editReply({ content: null, embeds: [errorEmbed(error)], components: [] });
    draft.details[discordId] = { ign: entry.ign, uid: entry.uid };
    const settings = await getSettings(interaction.guildId);
    return interaction.editReply(wizDetailsPayload(draft, settings));
  }

  if (id === 'team:edit:modal') {
    await interaction.deferReply({ ephemeral: true });
    const dbUser = await getOrCreateUser(interaction.user);
    const team = await getOwnedTeam(dbUser.id);
    if (!team) return interaction.editReply({ embeds: [errorEmbed('You do not own a team.')] });
    const name = interaction.fields.getTextInputValue('t_name').trim() || team.name;
    const tag = (interaction.fields.getTextInputValue('t_tag').trim() || team.tag).toUpperCase();
    const email = interaction.fields.getTextInputValue('t_email').trim();
    const phone = interaction.fields.getTextInputValue('t_phone').trim();
    const region = interaction.fields.getTextInputValue('t_region').trim();
    if (!isValidTag(tag)) return interaction.editReply({ embeds: [errorEmbed('Team tag must be 2–6 letters/numbers, no spaces.')] });
    if (email && !EMAIL_RE.test(email)) return interaction.editReply({ embeds: [errorEmbed('That email address does not look valid.')] });
    if (phone && !PHONE_RE.test(phone)) return interaction.editReply({ embeds: [errorEmbed('That phone number does not look valid.')] });
    if (tag !== team.tag) {
      const taken = await prisma.team.findFirst({ where: { tag, status: { not: 'DISBANDED' }, NOT: { id: team.id } } });
      if (taken) return interaction.editReply({ embeds: [errorEmbed(`Tag **${tag}** is already taken.`)] });
    }
    await prisma.team.update({ where: { id: team.id }, data: { name, tag, email: email || null, phone: phone || null, region: region || null } });
    if (team.roleId) {
      const role = await interaction.guild.roles.fetch(team.roleId).catch(() => null);
      if (role) await role.setName(`[${tag}] ${name}`.slice(0, 100)).catch(() => {});
    }
    await audit('TEAM_EDIT', interaction.user.id, `${team.tag} -> ${tag} info updated`);
    return interaction.editReply({ embeds: [successEmbed(`Team info updated: **${name} [${tag}]**.`)] });
  }

  if (id.startsWith('team:playeradd:modal:')) {
    const [, , , kind, teamId] = id.split(':');
    await interaction.deferReply({ ephemeral: true });
    const dbUser = await getOrCreateUser(interaction.user);
    const team = await getOwnedTeam(dbUser.id);
    if (!team || team.id !== teamId) return interaction.editReply({ embeds: [errorEmbed('You do not own this team.')] });
    const existingList = team.members.map((m) => ({ uid: m.player.gameUid, discordId: m.player.discordId }));
    const { entry, error } = await buildPlayerEntry(
      interaction.fields.getTextInputValue('p_ign'),
      interaction.fields.getTextInputValue('p_uid'),
      interaction.fields.getTextInputValue('p_discord'),
      existingList
    );
    if (error) return interaction.editReply({ embeds: [errorEmbed(error)] });
    const player = await prisma.player.upsert({
      where: { gameUid: entry.uid },
      update: { ign: entry.ign, discordId: entry.discordId },
      create: { gameUid: entry.uid, ign: entry.ign, discordId: entry.discordId },
    });
    try {
      await prisma.teamMember.create({ data: { teamId: team.id, playerId: player.id, role: kind === 'starter' ? 'PLAYER' : 'SUB' } });
    } catch {
      return interaction.editReply({ embeds: [errorEmbed('This player is already on the team.')] });
    }
    if (entry.discordId) {
      const member = await interaction.guild.members.fetch(entry.discordId).catch(() => null);
      if (member && team.roleId) await member.roles.add(team.roleId).catch(() => {});
    }
    await audit('TEAM_PLAYER_ADD', interaction.user.id, `${entry.ign} (${entry.uid}) added to ${team.tag} as ${kind}`);
    return interaction.editReply({ embeds: [successEmbed(`**${entry.ign}** added to **${team.tag}** as ${kind === 'starter' ? 'starter' : 'substitute'}.`)] });
  }
}

// ---------- user selects ----------

async function handleUserSelect(interaction) {
  const id = interaction.customId;
  if (id === 'team:wiz:players') {
    const draft = getDraft(interaction.user.id);
    if (!draft) return interaction.reply({ embeds: [errorEmbed('Session expired. Start again with Register Team.')], ephemeral: true });
    await interaction.deferUpdate();
    const settings = await getSettings(interaction.guildId);
    const ids = [...new Set(interaction.values)];
    const maxPlayers = settings.teamSize + settings.maxSubs;
    if (ids.length < settings.teamSize) {
      return interaction.editReply({
        embeds: [errorEmbed(`Select at least ${settings.teamSize} players (you picked ${ids.length}).`)],
        components: [],
      });
    }
    if (ids.length > maxPlayers) {
      return interaction.editReply({
        embeds: [errorEmbed(`You can select at most ${maxPlayers} players.`)],
        components: [],
      });
    }
    // keep details for players that are still selected
    const details = {};
    for (const pid of ids) if (draft.details[pid]) details[pid] = draft.details[pid];
    draft.playerIds = ids;
    draft.details = details;
    return interaction.editReply(wizDetailsPayload(draft, settings));
  }
}

// ---------- selects ----------

async function handleSelect(interaction) {
  const id = interaction.customId;
  if (id.startsWith('team:remove:select:')) {
    const teamId = id.split(':')[3];
    await interaction.deferUpdate();
    const dbUser = await getOrCreateUser(interaction.user);
    const team = await getOwnedTeam(dbUser.id);
    if (!team || team.id !== teamId) return interaction.editReply({ content: 'You do not own this team.', embeds: [], components: [] });
    const memberId = interaction.values[0];
    const membership = await prisma.teamMember.findFirst({ where: { id: memberId, teamId: team.id }, include: { player: true } });
    if (!membership) return interaction.editReply({ content: 'Player not found on this team.', embeds: [], components: [] });
    await prisma.teamMember.delete({ where: { id: membership.id } });
    if (membership.player.discordId && team.roleId) {
      const member = await interaction.guild.members.fetch(membership.player.discordId).catch(() => null);
      if (member) await member.roles.remove(team.roleId).catch(() => {});
    }
    await audit('TEAM_PLAYER_REMOVE', interaction.user.id, `${membership.player.ign} removed from ${team.tag}`);
    return interaction.editReply({ content: `✅ **${membership.player.ign}** removed from **${team.tag}**.`, embeds: [], components: [] });
  }
}

module.exports = { handle };
