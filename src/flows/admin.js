const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
} = require('discord.js');
const { prisma } = require('../db');
const {
  getSettings,
  requireAdmin,
  errorEmbed,
  successEmbed,
  formatIST,
  parseDateTimeIST,
  rosterLines,
  audit,
  postAdminLog,
} = require('../utils');
const { postRegistrationAnnouncement } = require('./events');
const { createIdpGroups } = require('./idp');

/** audit() + mirror to the Admin Activity log channel (never throws). */
async function adminAudit(interaction, action, details) {
  await audit(action, interaction.user.id, details);
  await postAdminLog(interaction.client, interaction.guildId, action, interaction.user.id, details);
}

/** userId -> { title, message } pending DM broadcast drafts */
const dmDrafts = new Map();

/** token -> step-1 event creation data, expires after 10 min (two-step modal) */
const pendingCreations = new Map();
function stashCreation(data) {
  const token = require('crypto').randomBytes(6).toString('hex');
  pendingCreations.set(token, { ...data, expiresAt: Date.now() + 10 * 60 * 1000 });
  setTimeout(() => pendingCreations.delete(token), 10 * 60 * 1000).unref?.();
  return token;
}

async function handle(interaction) {
  if (!(await requireAdmin(interaction))) return;
  try {
    if (interaction.isButton()) return handleButton(interaction);
    if (interaction.isStringSelectMenu() || interaction.isChannelSelectMenu() || interaction.isRoleSelectMenu?.()) return handleSelect(interaction);
    if (interaction.isModalSubmit()) return handleModal(interaction);
  } catch (err) {
    console.error('[admin] error:', err);
    try {
      if (interaction.deferred) {
        await interaction.editReply({ content: null, embeds: [errorEmbed('Something went wrong. Please try again.')], components: [] });
      } else if (!interaction.replied) {
        await interaction.reply({ embeds: [errorEmbed('Something went wrong. Please try again.')], ephemeral: true });
      }
    } catch {}
  }
}

const ACTIVE_REG = ['PENDING', 'APPROVED'];

async function regCount(eventId) {
  return prisma.tournamentRegistration.count({ where: { tournamentId: eventId, status: { in: ACTIVE_REG } } });
}

function eventDetailEmbed(event, taken) {
  const statusColor = { DRAFT: 0x95a5a6, OPEN: 0x57f287, LOCKED: 0xf1c40f, LIVE: 0x5865f2, COMPLETED: 0x2c2f33, CANCELLED: 0xed4245 };
  return new EmbedBuilder()
    .setColor(statusColor[event.status] ?? 0x95a5a6)
    .setTitle(`${event.type === 'SCRIM' ? '🎯' : '🏆'} ${event.name}`)
    .setDescription(event.description || '—')
    .addFields(
      { name: 'Status', value: `\`${event.status}\``, inline: true },
      { name: 'Date', value: formatIST(event.date), inline: true },
      { name: 'Tags Required', value: String(event.tagsRequired ?? 4), inline: true },
      { name: 'Teams/Group', value: event.teamsPerGroup ? String(event.teamsPerGroup) : '—', inline: true },
      { name: 'Slots', value: `${taken}/${event.teamLimit}`, inline: true }
    );
}

function eventActionRows(event) {
  const b = (action, label, style, emoji) =>
    new ButtonBuilder().setCustomId(`admin:event:${action}:${event.id}`).setLabel(label).setStyle(style).setEmoji(emoji);
  const row1 = new ActionRowBuilder();
  if (event.status === 'DRAFT') row1.addComponents(b('open', 'Open Registration', ButtonStyle.Success, '🟢'));
  if (event.status === 'OPEN') row1.addComponents(b('lock', 'Lock Registration', ButtonStyle.Secondary, '🔒'));
  if (event.status === 'OPEN') row1.addComponents(b('repost', 'Repost Announcement', ButtonStyle.Secondary, '📣'));
  if (event.status === 'OPEN' || event.status === 'LOCKED') row1.addComponents(b('live', 'Go Live', ButtonStyle.Primary, '🔴'));
  if (event.status === 'LIVE' || event.status === 'LOCKED') row1.addComponents(b('complete', 'Complete', ButtonStyle.Success, '🏁'));
  if (!['COMPLETED', 'CANCELLED'].includes(event.status)) row1.addComponents(b('cancel', 'Cancel Event', ButtonStyle.Danger, '⛔'));
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`admin:regs:view:${event.id}`).setLabel('View Registrations').setStyle(ButtonStyle.Primary).setEmoji('📝'),
    new ButtonBuilder().setCustomId(`admin:regmgr:${event.id}`).setLabel('Manage Registration').setStyle(ButtonStyle.Secondary).setEmoji('⚙️'),
    new ButtonBuilder().setCustomId(`admin:event:delete:${event.id}`).setLabel('Delete').setStyle(ButtonStyle.Danger).setEmoji('🗑️')
  );
  return row1.components.length ? [row1, row2] : [row2];
}

/** Channel picker + skip for posting an event's registration announcement. */
function announcePickerRows(eventId) {
  return [
    new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(`admin:event:announce:${eventId}`)
        .setPlaceholder('Select the registration channel')
        .addChannelTypes(ChannelType.GuildText)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`admin:event:announce:skip:${eventId}`).setLabel('Skip').setStyle(ButtonStyle.Secondary)
    ),
  ];
}

async function showEventManager(interaction, eventId, useUpdate) {
  // Defer first when we will update a message — the DB reads below can be slow on a remote DB.
  if (useUpdate && !interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  const event = await prisma.tournament.findUnique({ where: { id: eventId } });
  if (!event) {
    const payload = { content: 'Event not found.', embeds: [], components: [] };
    if (interaction.deferred) return interaction.editReply(payload);
    return useUpdate ? interaction.update(payload) : interaction.reply({ ...payload, ephemeral: true });
  }
  const taken = await regCount(event.id);
  const payload = { content: null, embeds: [eventDetailEmbed(event, taken)], components: eventActionRows(event) };
  if (interaction.deferred) return interaction.editReply(payload);
  return useUpdate ? interaction.update(payload) : interaction.reply({ ...payload, ephemeral: true });
}

// ---------- registration manager (mirrors the reference tournament manager) ----------

function regManagerEmbed(event, taken, idpState) {
  const open = event.status === 'OPEN';
  const ch = (id) => (id ? `<#${id}>` : '—');
  return new EmbedBuilder()
    .setColor(open ? 0x57f287 : 0x95a5a6)
    .setTitle(`⚙️ Managing: ${event.name}`)
    .addFields(
      { name: 'Registration Status', value: open ? '🟢 Open' : '🔴 Closed', inline: true },
      { name: 'Total Slots', value: String(event.teamLimit), inline: true },
      { name: 'Registrations', value: String(taken), inline: true },
      { name: 'Tags Required', value: String(event.tagsRequired ?? 4), inline: true },
      { name: 'Teams/Group', value: event.teamsPerGroup ? String(event.teamsPerGroup) : '—', inline: true },
      { name: 'IDP Groups', value: idpState === 'done' ? '✅ Created' : idpState === 'partial' ? '⚠️ Partial' : 'Not created', inline: true },
      { name: 'Registration Starts', value: event.regStartsAt ? formatIST(event.regStartsAt) : '—', inline: true },
      { name: 'Registration Channel', value: ch(event.regChannelId), inline: true },
      { name: 'Log Channel', value: ch(event.logChannelId), inline: true },
      { name: 'Success Role', value: event.successRoleId ? `<@&${event.successRoleId}>` : '—', inline: true },
      { name: 'Success Message', value: event.successMessage ? event.successMessage.slice(0, 250) : '—' }
    )
    .setFooter({ text: `ID: ${event.id}` });
}

function regManagerRows(event, idpState) {
  const open = event.status === 'OPEN';
  const eb = (field, label, emoji) =>
    new ButtonBuilder().setCustomId(`admin:regedit:${field}:${event.id}`).setLabel(label).setStyle(ButtonStyle.Primary).setEmoji(emoji);
  const row1 = new ActionRowBuilder().addComponents(
    eb('name', 'Edit Name', '✏️'),
    eb('slots', 'Edit Slots', '🎰'),
    eb('tags', 'Edit Tags', '🏷️'),
    eb('tpg', 'Teams/Group', '👥'),
    eb('starttime', 'Edit Start Time', '🕓'),
    eb('successmsg', 'Edit Success Msg', '💬')
  );
  const row2 = new ActionRowBuilder().addComponents(
    open
      ? new ButtonBuilder().setCustomId(`admin:reg:close:${event.id}`).setLabel('Close Registration').setStyle(ButtonStyle.Danger).setEmoji('🔒')
      : new ButtonBuilder().setCustomId(`admin:reg:start:${event.id}`).setLabel('Start Registration').setStyle(ButtonStyle.Success).setEmoji('▶️'),
    idpState === 'done'
      ? new ButtonBuilder().setCustomId('admin:idp:done').setLabel('IDP Groups Ready').setStyle(ButtonStyle.Secondary).setEmoji('🗂️').setDisabled(true)
      : new ButtonBuilder()
          .setCustomId(`admin:idp:ask:${event.id}`)
          .setLabel(idpState === 'partial' ? 'Resume IDP Groups' : 'Create IDP Groups')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🗂️'),
    new ButtonBuilder().setCustomId(`admin:regmgr:back:${event.id}`).setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('◀️')
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId(`admin:regmgr:regch:${event.id}`)
      .setPlaceholder('Select new Registration Channel')
      .addChannelTypes(ChannelType.GuildText)
  );
  const row4 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId(`admin:regmgr:logch:${event.id}`)
      .setPlaceholder('Select new Log Channel')
      .addChannelTypes(ChannelType.GuildText)
  );
  const row5 = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder().setCustomId(`admin:regmgr:role:${event.id}`).setPlaceholder('Select new Success Role')
  );
  return [row1, row2, row3, row4, row5];
}

async function showRegManager(interaction, eventId, useUpdate) {
  // Defer first when we will update a message — the DB reads below can be slow on a remote DB.
  if (useUpdate && !interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  const event = await prisma.tournament.findUnique({ where: { id: eventId } });
  if (!event) {
    const payload = { content: 'Event not found.', embeds: [], components: [] };
    if (interaction.deferred) return interaction.editReply(payload);
    return useUpdate ? interaction.update(payload) : interaction.reply({ ...payload, ephemeral: true });
  }
  const taken = await regCount(event.id);
  const settings = await getSettings(interaction.guildId);
  const perGroup = event.teamsPerGroup || settings.groupSize || 20;
  const nGroups = Math.max(Math.ceil(event.teamLimit / perGroup), 1);
  const idpHave = event.idpCategoryId ? await prisma.idpGroup.count({ where: { tournamentId: event.id } }) : 0;
  const idpState = !event.idpCategoryId ? 'none' : idpHave >= nGroups ? 'done' : 'partial';
  const payload = { content: null, embeds: [regManagerEmbed(event, taken, idpState)], components: regManagerRows(event, idpState) };
  if (interaction.deferred) return interaction.editReply(payload);
  return useUpdate ? interaction.update(payload) : interaction.reply({ ...payload, ephemeral: true });
}

// ---------- log channel setup (Admin Panel -> Logs) ----------

const LOG_ACTIONS = [
  { key: 'teamverify', label: 'Team Verification', emoji: '🛡️', field: 'logTeamVerify', desc: 'Team verified, edited, disbanded' },
  { key: 'tourneyreg', label: 'Tournament Registration', emoji: '🏆', field: 'logTourneyReg', desc: 'Tournament registrations & withdrawals' },
  { key: 'scrimreg', label: 'Scrim Registration', emoji: '🎯', field: 'logScrimReg', desc: 'Scrim registrations & withdrawals' },
  { key: 'admin', label: 'Admin Activity', emoji: '🛠️', field: 'logAdminActivity', desc: 'Admin actions, edits, announcements' },
];

function logSetupEmbed(settings) {
  const ch = (id) => (id ? `<#${id}>` : '— not set —');
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📋 Log Channels')
    .setDescription('Pick an action below, then choose the channel its logs go to.')
    .addFields(LOG_ACTIONS.map((a) => ({ name: `${a.emoji} ${a.label}`, value: ch(settings[a.field]), inline: true })));
}

function logSetupBaseRows() {
  const row1 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('admin:log:pick')
      .setPlaceholder('Select an action to configure')
      .addOptions(
        LOG_ACTIONS.map((a) => ({ label: a.label, value: a.key, description: a.desc.slice(0, 100), emoji: a.emoji }))
      )
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin:logs:activity').setLabel('View Recent Activity').setStyle(ButtonStyle.Secondary).setEmoji('🧾'),
    new ButtonBuilder().setCustomId('admin:logs:done').setLabel('Done').setStyle(ButtonStyle.Secondary)
  );
  return [row1, row2];
}

async function showLogSetup(interaction, useUpdate, actionKey) {
  // Defer first when we will update a message — the DB reads below can be slow on a remote DB.
  if (useUpdate && !interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  const settings = await getSettings(interaction.guildId);
  const rows = logSetupBaseRows();
  if (actionKey) {
    const a = LOG_ACTIONS.find((x) => x.key === actionKey);
    if (a) {
      rows.splice(
        1,
        0,
        new ActionRowBuilder().addComponents(
          new ChannelSelectMenuBuilder()
            .setCustomId(`admin:log:ch:${a.key}`)
            .setPlaceholder(`Select log channel for ${a.label}`)
            .addChannelTypes(ChannelType.GuildText)
        ),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`admin:log:clear:${a.key}`).setLabel(`Clear ${a.label}`).setStyle(ButtonStyle.Danger)
        )
      );
    }
  }
  const payload = { content: null, embeds: [logSetupEmbed(settings)], components: rows };
  if (interaction.deferred) return interaction.editReply(payload);
  return useUpdate ? interaction.update(payload) : interaction.reply({ ...payload, ephemeral: true });
}

// ---------- buttons ----------

async function handleButton(interaction) {
  const id = interaction.customId;

  // ----- top-level admin actions -----
  if (id === 'admin:create') {
    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('admin:create:type')
        .setPlaceholder('Select event type')
        .addOptions([
          { label: 'Scrim', value: 'SCRIM', description: 'Daily/practice scrim with slots', emoji: '🎯' },
          { label: 'Tournament', value: 'TOURNAMENT', description: 'Full tournament event', emoji: '🏆' },
        ])
    );
    return interaction.reply({ content: 'What do you want to create?', components: [row], ephemeral: true });
  }

  if (id === 'admin:events' || id === 'admin:regs') {
    await interaction.deferReply({ ephemeral: true });
    const events = await prisma.tournament.findMany({
      where: { status: { notIn: ['COMPLETED', 'CANCELLED'] } },
      orderBy: { createdAt: 'desc' },
      take: 25,
    });
    if (!events.length) return interaction.editReply({ embeds: [errorEmbed('No events yet. Create one first.')] });
    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(id === 'admin:events' ? 'admin:event:pick' : 'admin:regs:pick')
        .setPlaceholder('Select an event')
        .addOptions(
          events.map((e) => ({
            label: `${e.type === 'SCRIM' ? '🎯' : '🏆'} ${e.name}`.slice(0, 100),
            value: e.id,
            description: `${e.status} • ${formatIST(e.date)}`.slice(0, 100),
          }))
        )
    );
    return interaction.editReply({ content: 'Select an event:', components: [row] });
  }

  if (id === 'admin:teams') {
    const modal = new ModalBuilder().setCustomId('admin:teams:search').setTitle('Find Team');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('q').setLabel('Team ID, tag or name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(64)
      )
    );
    return interaction.showModal(modal);
  }

  if (id === 'admin:players') {
    const modal = new ModalBuilder().setCustomId('admin:players:search').setTitle('Find Player');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('q').setLabel('BGMI UID or in-game name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(64)
      )
    );
    return interaction.showModal(modal);
  }

  if (id === 'admin:announce') {
    const row = new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId('admin:announce:ch')
        .setPlaceholder('Select announcement channel')
        .addChannelTypes(ChannelType.GuildText)
    );
    return interaction.reply({ content: 'Where should the announcement go?', components: [row], ephemeral: true });
  }

  if (id === 'admin:lock') {
    const row = new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId('admin:lock:ch')
        .setPlaceholder('Select a channel to lock/unlock')
        .addChannelTypes(ChannelType.GuildText)
    );
    return interaction.reply({ content: 'Which channel?', components: [row], ephemeral: true });
  }

  if (id === 'admin:dm') {
    const modal = new ModalBuilder().setCustomId('admin:dm:modal').setTitle('DM All Team Owners');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('dm_title').setLabel('Title').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('dm_message').setLabel('Message').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500)
      )
    );
    return interaction.showModal(modal);
  }

  if (id === 'admin:dm:yes' || id === 'admin:dm:no') {
    if (id === 'admin:dm:no') {
      dmDrafts.delete(interaction.user.id);
      return interaction.update({ content: 'Broadcast cancelled.', embeds: [], components: [] });
    }
    const draft = dmDrafts.get(interaction.user.id);
    if (!draft) return interaction.update({ content: 'Draft expired — start again.', embeds: [], components: [] });
    dmDrafts.delete(interaction.user.id);
    await interaction.update({ content: '📣 Starting DM broadcast…', embeds: [], components: [] });
    const statusMsg = await interaction.followUp({ content: '📣 Sending… (0 sent)', ephemeral: true });
    const teams = await prisma.team.findMany({ where: { status: 'ACTIVE' }, include: { owner: true }, orderBy: { createdAt: 'asc' } });
    let sent = 0;
    let failed = 0;
    const failedTags = [];
    const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(`📢 ${draft.title}`).setDescription(draft.message);
    for (const t of teams) {
      try {
        const user = await interaction.client.users.fetch(t.owner.discordId);
        await user.send({ embeds: [embed] });
        sent++;
      } catch {
        failed++;
        if (failedTags.length < 20) failedTags.push(t.tag);
      }
      if ((sent + failed) % 20 === 0) {
        await statusMsg.edit({ content: `📣 Sending… (${sent} sent, ${failed} failed, ${sent + failed}/${teams.length})` }).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 750)); // stay well under DM rate limits
    }
    await adminAudit(interaction, 'DM_BROADCAST', `"${draft.title}" -> ${sent} sent, ${failed} failed`);
    await statusMsg
      .edit({
        content:
          `✅ Broadcast finished: **${sent}** delivered, **${failed}** failed (DMs closed/blocked).` +
          (failedTags.length ? `\nFailed: ${failedTags.join(', ')}${failed > failedTags.length ? ` (+${failed - failedTags.length} more)` : ''}` : ''),
      })
      .catch(() => {});
    return;
  }

  if (id === 'admin:logs') {
    await interaction.deferUpdate();
    return showLogSetup(interaction, true);
  }

  if (id === 'admin:logs:done') {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    return interaction.editReply({ content: 'Log setup closed.', embeds: [], components: [] });
  }

  if (id === 'admin:logs:activity') {
    await interaction.deferReply({ ephemeral: true });
    const logs = await prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 15 });
    const lines = logs.map((l) => {
      const t = l.createdAt.toISOString().slice(0, 16).replace('T', ' ');
      return `\`${t}\` **${l.action}** — <@${l.userId}>${l.details ? `\n↳ ${l.details.slice(0, 120)}` : ''}`;
    });
    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(0x95a5a6).setTitle('🧾 Recent Activity').setDescription(lines.join('\n\n') || 'No logs yet.')],
    });
  }

  if (id.startsWith('admin:log:clear:')) {
    const key = id.split(':')[3];
    const a = LOG_ACTIONS.find((x) => x.key === key);
    if (!a) return interaction.reply({ embeds: [errorEmbed('Unknown log action.')], ephemeral: true });
    await interaction.deferUpdate();
    await prisma.guildSettings.upsert({
      where: { guildId: interaction.guildId },
      update: { [a.field]: null },
      create: { guildId: interaction.guildId, [a.field]: null },
    });
    await adminAudit(interaction, 'LOG_CHANNEL_CLEAR', `${a.label} log channel cleared`);
    return showLogSetup(interaction, true);
  }

  if (id === 'admin:settings') {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('admin:settings:general').setLabel('General Settings').setStyle(ButtonStyle.Primary).setEmoji('⚙️'),
      new ButtonBuilder().setCustomId('admin:settings:reg').setLabel('Registration Settings').setStyle(ButtonStyle.Secondary).setEmoji('🎯')
    );
    return interaction.reply({ content: 'Which settings do you want to change?', components: [row], ephemeral: true });
  }

  if (id === 'admin:settings:general') {
    const s = await getSettings(interaction.guildId);
    const modal = new ModalBuilder().setCustomId('admin:settings:modal').setTitle('Bot Settings');
    const mk = (cid, label, value, max, required) =>
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId(cid).setLabel(label).setStyle(TextInputStyle.Short).setRequired(required).setMaxLength(max).setValue(value)
      );
    modal.addComponents(
      mk('s_teamsize', 'Team size (starters)', String(s.teamSize), 2, true),
      mk('s_maxsubs', 'Max substitutes', String(s.maxSubs), 2, true),
      mk('s_prefix', 'Team ID prefix', s.teamIdPrefix, 6, true),
      mk('s_maps', 'Maps (comma separated)', s.maps.join(', '), 100, true),
      mk('s_adminroles', 'Admin role IDs (comma separated, optional)', s.adminRoleIds.join(', '), 400, false)
    );
    return interaction.showModal(modal);
  }

  if (id === 'admin:settings:reg') {
    const s = await getSettings(interaction.guildId);
    const modal = new ModalBuilder().setCustomId('admin:settings:reg:modal').setTitle('Registration Settings');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('s_groupsize')
          .setLabel('Teams per group (auto group assignment)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(3)
          .setValue(String(s.groupSize || 20))
      )
    );
    return interaction.showModal(modal);
  }

  // ----- event lifecycle -----
  if (id.startsWith('admin:event:delete:yes:')) {
    await interaction.deferUpdate();
    const eventId = id.split(':')[4];
    await prisma.tournamentRegistration.deleteMany({ where: { tournamentId: eventId } });
    await prisma.tournament.delete({ where: { id: eventId } }).catch(() => {});
    await adminAudit(interaction, 'EVENT_DELETE', eventId);
    return interaction.editReply({ content: '✅ Event deleted.', embeds: [], components: [] });
  }
  if (id.startsWith('admin:event:delete:no:')) {
    return interaction.update({ content: 'Cancelled.', embeds: [], components: [] });
  }
  if (id === 'admin:noop') return interaction.deferUpdate();
  // ----- registration announcement: skip button -----
  if (id.startsWith('admin:event:announce:skip:')) {
    return interaction.update({ content: 'Announcement skipped — you can post it anytime with Repost Announcement.', embeds: [], components: [] });
  }
  if (id.startsWith('admin:event:')) {
    const [, , action, eventId] = id.split(':');
    await interaction.deferUpdate();
    const event = await prisma.tournament.findUnique({ where: { id: eventId } });
    if (!event) return interaction.editReply({ content: 'Event not found.', embeds: [], components: [] });

    if (action === 'delete') {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`admin:event:delete:yes:${eventId}`).setLabel('Yes, delete').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`admin:event:delete:no:${eventId}`).setLabel('Keep').setStyle(ButtonStyle.Secondary)
      );
      return interaction.followUp({
        embeds: [new EmbedBuilder().setColor(0xed4245).setDescription(`Delete **${event.name}** and all its registrations?`)],
        components: [row],
        ephemeral: true,
      });
    }

    const transitions = { open: 'OPEN', lock: 'LOCKED', live: 'LIVE', complete: 'COMPLETED', cancel: 'CANCELLED' };
    const next = transitions[action];

    if (action === 'repost') {
      return interaction.followUp({
        content: `📣 Where should the registration post for **${event.name}** go?`,
        components: announcePickerRows(event.id),
        ephemeral: true,
      });
    }

    if (!next) return interaction.followUp({ embeds: [errorEmbed('Unknown action.')], ephemeral: true });
    await prisma.tournament.update({ where: { id: event.id }, data: { status: next } });
    await adminAudit(interaction, 'EVENT_STATUS', `${event.name} -> ${next}`);
    if (action === 'open') {
      await showEventManager(interaction, event.id, true);
      return interaction.followUp({
        content: `📣 **${event.name}** is now OPEN. Where should the registration post go?`,
        components: announcePickerRows(event.id),
        ephemeral: true,
      });
    }
    return showEventManager(interaction, event.id, true);
  }

  // ----- registrations -----
  if (id.startsWith('admin:regs:view:')) {
    await interaction.deferUpdate();
    return showRegistrations(interaction, id.split(':')[3], true);
  }
  if (id.startsWith('admin:reg:approve:') || id.startsWith('admin:reg:disqualify:') || id.startsWith('admin:reg:remove:')) {
    await interaction.deferUpdate();
    const [action, regId] = [id.split(':')[2], id.split(':')[3]];
    const reg = await prisma.tournamentRegistration.findUnique({ where: { id: regId }, include: { tournament: true, team: true } });
    if (!reg) return interaction.editReply({ content: 'Registration not found.', embeds: [], components: [] });
    const next = action === 'approve' ? 'APPROVED' : action === 'disqualify' ? 'DISQUALIFIED' : 'REMOVED';
    await prisma.tournamentRegistration.update({ where: { id: reg.id }, data: { status: next } });
    await adminAudit(interaction, 'REG_STATUS', `${reg.team.tag} in ${reg.tournament.name} -> ${next}`);
    return showRegistrations(interaction, reg.tournamentId, true);
  }
  if (id.startsWith('admin:reg:approveall:')) {
    await interaction.deferUpdate();
    const eventId = id.split(':')[3];
    const res = await prisma.tournamentRegistration.updateMany({ where: { tournamentId: eventId, status: 'PENDING' }, data: { status: 'APPROVED' } });
    await adminAudit(interaction, 'REG_APPROVE_ALL', `${eventId}: ${res.count} approved`);
    return showRegistrations(interaction, eventId, true);
  }

  // ----- registration manager -----
  if (id.startsWith('admin:regmgr:back:')) return showEventManager(interaction, id.split(':')[3], true);
  if (id.startsWith('admin:regmgr:') && id.split(':').length === 3) return showRegManager(interaction, id.split(':')[2], true);

  if (id.startsWith('admin:regedit:')) {
    const field = id.split(':')[2];
    const cfg = {
      name: { title: 'Edit Event Name', label: 'Event name', style: TextInputStyle.Short, max: 80, ph: 'Evening Scrims #12' },
      slots: { title: 'Edit Total Slots', label: 'Total slots (2-500)', style: TextInputStyle.Short, max: 4, ph: '20' },
      tags: { title: 'Edit Tags Required', label: 'Tags required (1-8)', style: TextInputStyle.Short, max: 2, ph: '4' },
      tpg: { title: 'Edit Teams Per Group', label: 'Teams per group 1-100 (empty = use settings)', style: TextInputStyle.Short, max: 3, ph: '20' },
      starttime: { title: 'Edit Registration Start', label: 'Start — YYYY-MM-DD HH:MM IST (empty = clear)', style: TextInputStyle.Short, max: 16, ph: '2026-10-01 18:00' },
      successmsg: { title: 'Edit Success Message', label: 'Message (empty = clear)', style: TextInputStyle.Paragraph, max: 500, ph: 'Welcome! Check the rules channel before match day.' },
    }[field];
    if (!cfg) return interaction.reply({ embeds: [errorEmbed('Unknown field.')], ephemeral: true });
    // showModal must NOT be preceded by defer — Discord forbids defer-then-modal.
    const eventId = id.split(':')[3];
    const modal = new ModalBuilder().setCustomId(`admin:regedit:submit:${field}:${eventId}`).setTitle(cfg.title);
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('f_value')
          .setLabel(cfg.label)
          .setStyle(cfg.style)
          .setRequired(false)
          .setMaxLength(cfg.max)
          .setPlaceholder(cfg.ph)
      )
    );
    return interaction.showModal(modal);
  }

  if (id.startsWith('admin:reg:start:')) {
    const eventId = id.split(':')[3];
    await interaction.deferUpdate();
    const event = await prisma.tournament.findUnique({ where: { id: eventId } });
    if (!event) return interaction.editReply({ content: 'Event not found.', embeds: [], components: [] });
    await prisma.tournament.update({ where: { id: eventId }, data: { status: 'OPEN', regStartsAt: new Date() } });
    await adminAudit(interaction, 'REG_START', `${event.name} registration started instantly`);
    await showRegManager(interaction, eventId, true);
    // Instant start: post the announcement right away when a registration channel is already chosen.
    if (event.regChannelId) {
      try {
        await postRegistrationAnnouncement(interaction.client, interaction.guildId, event.regChannelId, eventId);
        return interaction.followUp({ content: `✅ **${event.name}** registration is LIVE — announcement posted in <#${event.regChannelId}>.`, ephemeral: true });
      } catch (e) {
        console.error('[admin] instant-start announce failed:', e.message);
      }
    }
    return interaction.followUp({
      content: `✅ **${event.name}** registration is LIVE. Where should the registration post go?`,
      components: announcePickerRows(eventId),
      ephemeral: true,
    });
  }

  if (id.startsWith('admin:reg:close:')) {
    const eventId = id.split(':')[3];
    await interaction.deferUpdate();
    const event = await prisma.tournament.findUnique({ where: { id: eventId } });
    if (!event) return interaction.editReply({ content: 'Event not found.', embeds: [], components: [] });
    await prisma.tournament.update({ where: { id: eventId }, data: { status: 'LOCKED' } });
    await adminAudit(interaction, 'REG_CLOSE', `${event.name} registration closed`);
    return showRegManager(interaction, eventId, true);
  }

  // ----- IDP group creation (confirmation -> create in a fresh "<name> — Round 1" category) -----
  if (id.startsWith('admin:idp:ask:')) {
    const eventId = id.split(':')[3];
    await interaction.deferUpdate();
    const event = await prisma.tournament.findUnique({ where: { id: eventId } });
    if (!event) return interaction.editReply({ content: 'Event not found.', embeds: [], components: [] });
    const settings = await getSettings(interaction.guildId);
    const perGroup = event.teamsPerGroup || settings.groupSize || 20;
    const nGroups = Math.max(Math.ceil(event.teamLimit / perGroup), 1);
    const have = event.idpCategoryId ? await prisma.idpGroup.count({ where: { tournamentId: event.id } }) : 0;
    if (have >= nGroups) {
      return interaction.editReply({ content: 'IDP groups were already created for this event.', embeds: [], components: [] });
    }
    const remaining = nGroups - have;
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`🗂️ ${have ? 'Resume' : 'Create'} IDP Groups — ${event.name}`)
      .setDescription(
        (have
          ? `**${remaining}** of **${nGroups}** group channels are still missing — this will create the remaining ones.\n\n`
          : `This will create a **new category** named **${event.name} — Round 1** with **${nGroups}** group channels ` +
            `(\`${perGroup}\` teams per group, ${event.teamLimit} total slots).\n\n`) +
          'Each channel starts **locked** and gets a schedule panel:\n' +
          '✏️ Edit · 📋 Send Slot List · ⚠️ Punish Teams · ✅ Qualify Teams · 🔔 Send Reminders · 🔓 Unlock Group · ❌ Cancel Slot · 🔄 Transfer IDP Role\n\n' +
          'Create them now?'
      );
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`admin:idp:yes:${eventId}`)
        .setLabel(have ? `Resume (${remaining} left)` : `Create ${nGroups} Groups`)
        .setStyle(ButtonStyle.Success)
        .setEmoji('✅'),
      new ButtonBuilder().setCustomId(`admin:idp:no:${eventId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    );
    return interaction.editReply({ content: null, embeds: [embed], components: [row] });
  }

  if (id.startsWith('admin:idp:no:')) {
    return showRegManager(interaction, id.split(':')[3], true);
  }

  if (id.startsWith('admin:idp:yes:')) {
    const eventId = id.split(':')[3];
    await interaction.deferUpdate();
    await interaction.editReply({ content: '🗂️ Creating IDP groups… this can take a bit for large tournaments.', embeds: [], components: [] });
    try {
      const summary = await createIdpGroups(interaction.client, interaction.guild, eventId, interaction.guildId);
      await adminAudit(interaction, 'IDP_CREATE', `${summary.eventName}: ${summary.groups} groups in "${summary.categoryName}"`);
      await interaction.editReply({
        content:
          `✅ Created **${summary.groups}** IDP groups in category **${summary.categoryName}**. Panels posted in every group channel.` +
          (summary.failures.length ? `\n⚠️ ${summary.failures.length} channel(s) failed — press Create IDP Groups again to retry.` : ''),
        embeds: [],
        components: [],
      });
    } catch (e) {
      console.error('[admin] idp create failed:', e);
      await interaction.editReply({ content: `❌ Could not create IDP groups: ${e.message}`, embeds: [], components: [] });
      return;
    }
    return showRegManager(interaction, eventId, true);
  }

  // ----- team management -----
  if (id.startsWith('admin:team:disband:yes:') || id.startsWith('admin:team:disband:no:')) {
    const yes = id.startsWith('admin:team:disband:yes:');
    const teamId = id.split(':')[4];
    if (!yes) return interaction.update({ content: 'Cancelled.', embeds: [], components: [] });
    await interaction.deferUpdate();
    const team = await prisma.team.findUnique({ where: { id: teamId } });
    if (!team) return interaction.editReply({ content: 'Team not found.', embeds: [], components: [] });
    await prisma.team.update({ where: { id: team.id }, data: { status: 'DISBANDED' } });
    if (team.roleId) {
      const role = await interaction.guild.roles.fetch(team.roleId).catch(() => null);
      if (role) await role.delete('Team disbanded by admin').catch(() => {});
    }
    await adminAudit(interaction, 'TEAM_DISBAND', `${team.tag} disbanded by admin`);
    return interaction.editReply({ content: `✅ **${team.tag}** disbanded.`, embeds: [], components: [] });
  }
  if (id.startsWith('admin:team:')) {
    const [, , action, teamId] = id.split(':');
    if (action === 'edit') {
      // showModal must be the first acknowledge — no defer allowed here.
      const team = await prisma.team.findUnique({ where: { id: teamId }, include: { members: { include: { player: true } }, owner: true } });
      if (!team) return interaction.reply({ embeds: [errorEmbed('Team not found.')], ephemeral: true });
      const modal = new ModalBuilder().setCustomId(`admin:team:edit:modal:${team.id}`).setTitle('Edit Team');
      const mk = (cid, label, value, max) =>
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId(cid).setLabel(label).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(max).setValue(value || '')
        );
      modal.addComponents(
        mk('t_name', 'Team Name', team.name, 32),
        mk('t_tag', 'Team Tag', team.tag, 6),
        mk('t_logo', 'Logo URL', team.logo, 256),
        mk('t_region', 'Region', team.region, 32)
      );
      return interaction.showModal(modal);
    }
    await interaction.deferUpdate();
    const team = await prisma.team.findUnique({ where: { id: teamId }, include: { members: { include: { player: true } }, owner: true } });
    if (!team) return interaction.editReply({ content: 'Team not found.', embeds: [], components: [] });

    if (action === 'suspend' || action === 'activate') {
      const next = action === 'suspend' ? 'SUSPENDED' : 'ACTIVE';
      await prisma.team.update({ where: { id: team.id }, data: { status: next } });
      await adminAudit(interaction, 'TEAM_STATUS', `${team.tag} -> ${next}`);
      return interaction.editReply({ embeds: [successEmbed(`**${team.tag}** is now \`${next}\`.`)], components: [] });
    }
    if (action === 'disband') {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`admin:team:disband:yes:${team.id}`).setLabel('Yes, disband').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`admin:team:disband:no:${team.id}`).setLabel('Keep').setStyle(ButtonStyle.Secondary)
      );
      return interaction.followUp({ content: `Disband **${team.name} [${team.tag}]**?`, components: [row], ephemeral: true });
    }
  }

  // ----- player management -----
  if (id.startsWith('admin:player:rm:')) {
    await interaction.deferUpdate();
    const memberId = id.split(':')[3];
    const membership = await prisma.teamMember.findUnique({ where: { id: memberId }, include: { player: true, team: true } });
    if (!membership) return interaction.editReply({ content: 'Not found.', embeds: [], components: [] });
    await prisma.teamMember.delete({ where: { id: membership.id } });
    if (membership.player.discordId && membership.team.roleId) {
      const member = await interaction.guild.members.fetch(membership.player.discordId).catch(() => null);
      if (member) await member.roles.remove(membership.team.roleId).catch(() => {});
    }
    await adminAudit(interaction, 'PLAYER_REMOVE', `${membership.player.ign} removed from ${membership.team.tag}`);
    return interaction.editReply({ content: `✅ **${membership.player.ign}** removed from **${membership.team.tag}**.`, embeds: [], components: [] });
  }

  // ----- channel lock -----
  if (id.startsWith('admin:lock:do:')) {
    const [, , , action, channelId] = id.split(':');
    await interaction.deferUpdate();
    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return interaction.editReply({ content: 'Channel not found.', embeds: [], components: [] });
    await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
      SendMessages: action === 'lock' ? false : null,
    });
    await adminAudit(interaction, 'CHANNEL_LOCK', `#${channel.name} ${action}ed`);
    return interaction.editReply({
      content: action === 'lock' ? `🔒 **#${channel.name}** locked.` : `🔓 **#${channel.name}** unlocked.`,
      embeds: [],
      components: [],
    });
  }

  if (id.startsWith('admin:create:step2:')) {
    const token = id.split(':')[3];
    const draft = pendingCreations.get(token);
    if (!draft || draft.expiresAt < Date.now()) {
      pendingCreations.delete(token);
      return interaction.reply({ embeds: [errorEmbed('This form expired. Please start again with Create Event.')], ephemeral: true });
    }
    const modal2 = new ModalBuilder().setCustomId(`admin:create:modal2:${token}`).setTitle(draft.type === 'SCRIM' ? 'Create Scrim (2/2)' : 'Create Tournament (2/2)');
    const mk2 = (cid, label, placeholder, style, max) =>
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId(cid).setLabel(label).setPlaceholder(placeholder).setStyle(style).setRequired(false).setMaxLength(max)
      );
    modal2.addComponents(
      mk2('e_desc', 'Description (optional)', 'Room opens 15 min early…', TextInputStyle.Paragraph, 1000),
      mk2('e_regstart', 'Registration starts (optional)', 'YYYY-MM-DD HH:MM IST (empty = none)', TextInputStyle.Short, 32),
      mk2('e_successmsg', 'Success message (optional)', 'Welcome! Check the rules channel before match day.', TextInputStyle.Paragraph, 500)
    );
    return interaction.showModal(modal2);
  }
}

async function showRegistrations(interaction, eventId, useUpdate) {
  if (useUpdate && !interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  const event = await prisma.tournament.findUnique({ where: { id: eventId } });
  if (!event) {
    const p = { content: 'Event not found.', embeds: [], components: [] };
    if (interaction.deferred) return interaction.editReply(p);
    return useUpdate ? interaction.update(p) : interaction.reply({ ...p, ephemeral: true });
  }
  const regs = await prisma.tournamentRegistration.findMany({
    where: { tournamentId: eventId, status: { not: 'REMOVED' } },
    include: { team: { include: { owner: true } } },
    orderBy: { registeredAt: 'asc' },
  });
  const taken = await regCount(eventId);
  const emoji = { PENDING: '⏳', APPROVED: '✅', DISQUALIFIED: '⛔' };
  const lines = regs.slice(0, 20).map((r, i) => `${i + 1}. ${emoji[r.status] || '•'} **[${r.team.tag}]** ${r.team.name} — <@${r.team.owner.discordId}> — \`${r.status}\``);
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`📝 Registrations — ${event.name}`)
    .setDescription(`Slots: ${taken}/${event.teamLimit}\n\n${lines.join('\n') || 'No registrations yet.'}`);
  const components = [];
  if (regs.length) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`admin:reg:pick:${event.id}`)
      .setPlaceholder('Select a team to manage')
      .addOptions(
        regs.slice(0, 25).map((r) => ({
          label: `[${r.team.tag}] ${r.team.name}`.slice(0, 100),
          value: r.id,
          description: `Status: ${r.status}`.slice(0, 100),
        }))
      );
    components.push(new ActionRowBuilder().addComponents(select));
    const pending = regs.filter((r) => r.status === 'PENDING').length;
    if (pending) {
      components.push(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`admin:reg:approveall:${event.id}`).setLabel(`Approve all pending (${pending})`).setStyle(ButtonStyle.Success)
        )
      );
    }
  }
  const payload = { content: null, embeds: [embed], components };
  if (interaction.deferred) return interaction.editReply(payload);
  return useUpdate ? interaction.update(payload) : interaction.reply({ ...payload, ephemeral: true });
}

// ---------- selects ----------

async function handleSelect(interaction) {
  const id = interaction.customId;

  if (id.startsWith('admin:event:announce:')) {
    const eventId = id.split(':')[3];
    const channelId = interaction.values[0];
    await interaction.deferUpdate();
    try {
      await postRegistrationAnnouncement(interaction.client, interaction.guildId, channelId, eventId);
    } catch (e) {
      console.error('[admin] announce post failed:', e.message);
      return interaction.editReply({ content: `❌ Could not post the announcement: ${e.message}`, embeds: [], components: [] });
    }
    await adminAudit(interaction, 'EVENT_ANNOUNCE', `${eventId} announcement posted in ${channelId}`);
    return interaction.editReply({ content: `✅ Registration post published in <#${channelId}>.`, embeds: [], components: [] });
  }

  if (id.startsWith('admin:regmgr:regch:') || id.startsWith('admin:regmgr:logch:') || id.startsWith('admin:regmgr:role:')) {
    const parts = id.split(':');
    const kind = parts[2];
    const eventId = parts[3];
    const value = interaction.values[0];
    await interaction.deferUpdate();
    const event = await prisma.tournament.findUnique({ where: { id: eventId } });
    if (!event) return interaction.editReply({ content: 'Event not found.', embeds: [], components: [] });
    const data = kind === 'regch' ? { regChannelId: value } : kind === 'logch' ? { logChannelId: value } : { successRoleId: value };
    await prisma.tournament.update({ where: { id: eventId }, data });
    const label =
      kind === 'regch' ? `registration channel -> ${value}` : kind === 'logch' ? `log channel -> ${value}` : `success role -> ${value}`;
    await adminAudit(interaction, 'REG_FIELD_EDIT', `${event.name}: ${label}`);
    return showRegManager(interaction, eventId, true);
  }

  if (id === 'admin:log:pick') {
    await interaction.deferUpdate();
    return showLogSetup(interaction, true, interaction.values[0]);
  }

  if (id.startsWith('admin:log:ch:')) {
    const key = id.split(':')[3];
    const a = LOG_ACTIONS.find((x) => x.key === key);
    const channelId = interaction.values[0];
    await interaction.deferUpdate();
    if (!a) return interaction.editReply({ content: 'Unknown log action.', embeds: [], components: [] });
    await prisma.guildSettings.upsert({
      where: { guildId: interaction.guildId },
      update: { [a.field]: channelId },
      create: { guildId: interaction.guildId, [a.field]: channelId },
    });
    await adminAudit(interaction, 'LOG_CHANNEL_SET', `${a.label} logs -> <#${channelId}>`);
    return showLogSetup(interaction, true);
  }

  if (id === 'admin:create:type') {
    const type = interaction.values[0];
    // Discord allows max 5 text inputs per modal — step 1 of 2. No format/maps step anymore.
    const modal = new ModalBuilder().setCustomId(`admin:create:modal1:${type}`).setTitle(type === 'SCRIM' ? 'Create Scrim (1/2)' : 'Create Tournament (1/2)');
    const mk = (cid, label, placeholder, style, required, max) =>
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId(cid).setLabel(label).setPlaceholder(placeholder).setStyle(style).setRequired(required).setMaxLength(max)
      );
    modal.addComponents(
      mk('e_name', 'Name', 'Evening Scrims #12', TextInputStyle.Short, true, 80),
      mk('e_date', 'Date (optional) — YYYY-MM-DD HH:MM IST', '2026-10-01 19:00', TextInputStyle.Short, false, 16),
      mk('e_limit', 'Team limit (slots)', '20', TextInputStyle.Short, true, 4),
      mk('e_tags', 'Tags required (1-8)', 'Teammates the leader must tag', TextInputStyle.Short, false, 2),
      mk('e_tpg', 'Teams per group (IDP groups)', 'e.g. 20 — empty = use settings', TextInputStyle.Short, false, 3)
    );
    // showModal must NOT be preceded by defer — Discord forbids defer-then-modal.
    return interaction.showModal(modal);
  }

  if (id === 'admin:event:pick') return showEventManager(interaction, interaction.values[0], true);
  if (id === 'admin:regs:pick') return showRegistrations(interaction, interaction.values[0], true);

  if (id.startsWith('admin:reg:pick:')) {
    await interaction.deferUpdate();
    const reg = await prisma.tournamentRegistration.findUnique({
      where: { id: interaction.values[0] },
      include: { team: { include: { members: { include: { player: true } }, owner: true } }, tournament: true },
    });
    if (!reg) return interaction.editReply({ content: 'Registration not found.', embeds: [], components: [] });
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`[${reg.team.tag}] ${reg.team.name}`)
      .addFields(
        { name: 'Team ID', value: `\`${reg.team.teamId}\``, inline: true },
        { name: 'Status', value: `\`${reg.status}\``, inline: true },
        { name: 'Owner', value: `<@${reg.team.owner.discordId}>`, inline: true },
        { name: `Roster (${reg.team.members.length})`, value: rosterLines(reg.team).join('\n').slice(0, 1000) || '—' }
      );
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`admin:reg:approve:${reg.id}`).setLabel('Approve').setStyle(ButtonStyle.Success).setDisabled(reg.status === 'APPROVED'),
      new ButtonBuilder().setCustomId(`admin:reg:disqualify:${reg.id}`).setLabel('Disqualify').setStyle(ButtonStyle.Danger).setDisabled(reg.status === 'DISQUALIFIED'),
      new ButtonBuilder().setCustomId(`admin:reg:remove:${reg.id}`).setLabel('Remove').setStyle(ButtonStyle.Secondary)
    );
    return interaction.editReply({ content: null, embeds: [embed], components: [row] });
  }

  if (id === 'admin:team:pick') {
    await interaction.deferUpdate();
    const team = await prisma.team.findUnique({
      where: { id: interaction.values[0] },
      include: { members: { include: { player: true } }, owner: true },
    });
    if (!team) return interaction.editReply({ content: 'Team not found.', embeds: [], components: [] });
    const embed = new EmbedBuilder()
      .setColor(0x0b7a4b)
      .setTitle(`${team.name} [${team.tag}]`)
      .addFields(
        { name: 'Team ID', value: `\`${team.teamId}\``, inline: true },
        { name: 'Status', value: `\`${team.status}\``, inline: true },
        { name: 'Region', value: team.region || '—', inline: true },
        { name: 'Owner', value: `<@${team.owner.discordId}>`, inline: true },
        { name: `Roster (${team.members.length})`, value: rosterLines(team).join('\n').slice(0, 1000) || '—' }
      );
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`admin:team:edit:${team.id}`).setLabel('Edit').setStyle(ButtonStyle.Primary),
      team.status === 'SUSPENDED'
        ? new ButtonBuilder().setCustomId(`admin:team:activate:${team.id}`).setLabel('Activate').setStyle(ButtonStyle.Success)
        : new ButtonBuilder().setCustomId(`admin:team:suspend:${team.id}`).setLabel('Suspend').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`admin:team:disband:${team.id}`).setLabel('Disband').setStyle(ButtonStyle.Danger)
    );
    return interaction.editReply({ content: null, embeds: [embed], components: [row] });
  }

  if (id === 'admin:player:pick') {
    await interaction.deferUpdate();
    const player = await prisma.player.findUnique({
      where: { id: interaction.values[0] },
      include: { members: { include: { team: true } } },
    });
    if (!player) return interaction.editReply({ content: 'Player not found.', embeds: [], components: [] });
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`🎮 ${player.ign}`)
      .addFields(
        { name: 'BGMI UID', value: `\`${player.gameUid}\``, inline: true },
        { name: 'Discord', value: player.discordId ? `<@${player.discordId}>` : '—', inline: true },
        { name: 'Teams', value: player.members.map((m) => `[${m.team.tag}] ${m.team.name} (${m.role})`).join('\n') || '—' }
      );
    const components = [];
    if (player.members.length) {
      components.push(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`admin:player:rmteam:${player.id}`)
            .setPlaceholder('Remove from a team…')
            .addOptions(
              player.members.slice(0, 25).map((m) => ({
                label: `[${m.team.tag}] ${m.team.name}`.slice(0, 100),
                value: m.id,
                description: `Role: ${m.role}`.slice(0, 100),
              }))
            )
        )
      );
    }
    return interaction.editReply({ content: null, embeds: [embed], components });
  }

  if (id.startsWith('admin:player:rmteam:')) {
    await interaction.deferUpdate();
    const memberId = interaction.values[0];
    const membership = await prisma.teamMember.findUnique({ where: { id: memberId }, include: { player: true, team: true } });
    if (!membership) return interaction.editReply({ content: 'Not found.', embeds: [], components: [] });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`admin:player:rm:${membership.id}`).setLabel(`Remove ${membership.player.ign}`).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('admin:noop').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    );
    return interaction.editReply({
      content: `Remove **${membership.player.ign}** from **[${membership.team.tag}] ${membership.team.name}**?`,
      embeds: [],
      components: [row],
    });
  }

  if (id === 'admin:announce:ch') {
    const channelId = interaction.values[0];
    const modal = new ModalBuilder().setCustomId(`admin:announce:modal:${channelId}`).setTitle('Send Announcement');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('a_title').setLabel('Title').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('a_message').setLabel('Message').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(2000)
      )
    );
    return interaction.showModal(modal);
  }

  if (id === 'admin:lock:ch') {
    const channelId = interaction.values[0];
    await interaction.deferUpdate();
    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    const name = channel ? `#${channel.name}` : 'channel';
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`admin:lock:do:lock:${channelId}`).setLabel(`Lock ${name}`).setStyle(ButtonStyle.Danger).setEmoji('🔒'),
      new ButtonBuilder().setCustomId(`admin:lock:do:unlock:${channelId}`).setLabel(`Unlock ${name}`).setStyle(ButtonStyle.Success).setEmoji('🔓')
    );
    return interaction.editReply({ content: `Lock or unlock **${name}** (blocks @everyone from sending messages while locked):`, components: [row] });
  }
}

// ---------- modals ----------

async function handleModal(interaction) {
  const id = interaction.customId;

  if (id.startsWith('admin:regedit:submit:')) {
    const [, , , field, eventId] = id.split(':');
    await interaction.deferReply({ ephemeral: true });
    const raw = interaction.fields.getTextInputValue('f_value').trim();
    const event = await prisma.tournament.findUnique({ where: { id: eventId } });
    if (!event) return interaction.editReply({ embeds: [errorEmbed('Event not found.')] });
    let data = null;
    let note = '';
    if (field === 'name') {
      if (!raw) return interaction.editReply({ embeds: [errorEmbed('Name cannot be empty.')] });
      data = { name: raw.slice(0, 80) };
      note = `name -> "${data.name}"`;
    } else if (field === 'slots') {
      const n = parseInt(raw, 10);
      if (!raw || !Number.isInteger(n) || n < 2 || n > 500) {
        return interaction.editReply({ embeds: [errorEmbed('Slots must be a number between 2 and 500.')] });
      }
      const taken = await regCount(eventId);
      if (n < taken) return interaction.editReply({ embeds: [errorEmbed(`Cannot set slots below the current registration count (${taken}).`)] });
      data = { teamLimit: n };
      note = `slots -> ${n}`;
    } else if (field === 'tags') {
      const n = parseInt(raw, 10);
      if (!raw || !Number.isInteger(n) || n < 1 || n > 8) {
        return interaction.editReply({ embeds: [errorEmbed('Tags required must be a number between 1 and 8.')] });
      }
      data = { tagsRequired: n, teamSize: n };
      note = `tags required -> ${n}`;
    } else if (field === 'starttime') {
      if (!raw) {
        data = { regStartsAt: null };
        note = 'registration start cleared';
      } else {
        const dt = parseDateTimeIST(raw);
        if (!dt) return interaction.editReply({ embeds: [errorEmbed('Use `YYYY-MM-DD HH:MM` in IST (e.g. 2026-10-01 18:00), or leave empty to clear.')] });
        data = { regStartsAt: dt };
        note = `registration starts -> ${formatIST(dt)}`;
      }
    } else if (field === 'successmsg') {
      data = { successMessage: raw || null };
      note = raw ? 'success message updated' : 'success message cleared';
    } else if (field === 'tpg') {
      if (!raw) {
        data = { teamsPerGroup: null };
        note = 'teams per group cleared (uses Registration Settings)';
      } else {
        const n = parseInt(raw, 10);
        if (!Number.isInteger(n) || n < 1 || n > 100) {
          return interaction.editReply({ embeds: [errorEmbed('Teams per group must be a number between 1 and 100.')] });
        }
        data = { teamsPerGroup: n };
        note = `teams per group -> ${n}`;
      }
    } else {
      return interaction.editReply({ embeds: [errorEmbed('Unknown field.')] });
    }
    await prisma.tournament.update({ where: { id: eventId }, data });
    await adminAudit(interaction, 'REG_FIELD_EDIT', `${event.name}: ${note}`);
    return showRegManager(interaction, eventId, true);
  }

  if (id.startsWith('admin:create:modal1:')) {
    const type = id.split(':')[3];
    await interaction.deferReply({ ephemeral: true });
    const name = interaction.fields.getTextInputValue('e_name').trim();
    const dateRaw = interaction.fields.getTextInputValue('e_date').trim();
    const limitRaw = interaction.fields.getTextInputValue('e_limit').trim();
    const tagsRaw = interaction.fields.getTextInputValue('e_tags').trim();

    const teamLimit = parseInt(limitRaw, 10);
    if (!Number.isInteger(teamLimit) || teamLimit < 2 || teamLimit > 500) {
      return interaction.editReply({ embeds: [errorEmbed('Team limit must be a number between 2 and 500.')] });
    }
    let date = null;
    if (dateRaw) {
      date = parseDateTimeIST(dateRaw);
      if (!date) return interaction.editReply({ embeds: [errorEmbed('Date must be `YYYY-MM-DD HH:MM` in IST (e.g. 2026-10-01 19:00).')] });
    }
    const tagsRequired = tagsRaw ? parseInt(tagsRaw, 10) : 4;
    if (!Number.isInteger(tagsRequired) || tagsRequired < 1 || tagsRequired > 8) {
      return interaction.editReply({ embeds: [errorEmbed('Tags required must be a number between 1 and 8.')] });
    }
    const tpgRaw = interaction.fields.getTextInputValue('e_tpg').trim();
    let teamsPerGroup = null;
    if (tpgRaw) {
      teamsPerGroup = parseInt(tpgRaw, 10);
      if (!Number.isInteger(teamsPerGroup) || teamsPerGroup < 1 || teamsPerGroup > 100) {
        return interaction.editReply({ embeds: [errorEmbed('Teams per group must be a number between 1 and 100, or left empty.')] });
      }
    }

    const token = stashCreation({ type, name, date: date ? date.toISOString() : null, teamLimit, tagsRequired, teamsPerGroup, createdBy: interaction.user.id });
    // NOTE: a modal submit cannot open another modal (Discord API) — the admin taps Continue, then step 2 opens.
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`admin:create:step2:${token}`).setLabel('Continue to Step 2').setStyle(ButtonStyle.Primary).setEmoji('➡️')
    );
    return interaction.editReply({
      content: `✅ Step 1 saved for **${name}**. Press Continue for step 2 (description, registration start, success message).`,
      components: [row],
    });
  }

  if (id.startsWith('admin:create:modal2:')) {
    const token = id.split(':')[3];
    const draft = pendingCreations.get(token);
    if (!draft || draft.expiresAt < Date.now()) {
      pendingCreations.delete(token);
      return interaction.reply({ embeds: [errorEmbed('This form expired. Please start again with Create Event.')], ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    pendingCreations.delete(token);
    const description = interaction.fields.getTextInputValue('e_desc').trim() || null;
    const regStartRaw = interaction.fields.getTextInputValue('e_regstart').trim();
    const successMessage = interaction.fields.getTextInputValue('e_successmsg').trim() || null;
    let regStartsAt = null;
    if (regStartRaw) {
      regStartsAt = parseDateTimeIST(regStartRaw);
      if (!regStartsAt) return interaction.editReply({ embeds: [errorEmbed('Registration start must be `YYYY-MM-DD HH:MM` in IST (e.g. 2026-10-01 18:00), or leave empty.')] });
    }

    const event = await prisma.tournament.create({
      data: {
        name: draft.name,
        description,
        type: draft.type,
        format: 'Squad',
        date: draft.date ? new Date(draft.date) : null,
        maps: [],
        teamLimit: draft.teamLimit,
        region: null,
        teamSize: draft.tagsRequired,
        tagsRequired: draft.tagsRequired,
        teamsPerGroup: draft.teamsPerGroup ?? null,
        inviteUrl: null,
        regStartsAt,
        successMessage,
        status: 'DRAFT',
        createdBy: draft.createdBy,
      },
    });
    await adminAudit(interaction, 'EVENT_CREATE', `${draft.name} (${draft.type}, ${draft.tagsRequired} tags, ${draft.teamLimit} slots)`);
    // Land directly in the registration manager so channels, role, message and
    // start time can be finished (or changed) right here during creation.
    return showRegManager(interaction, event.id, false);
  }

  if (id === 'admin:teams:search') {
    await interaction.deferReply({ ephemeral: true });
    const q = interaction.fields.getTextInputValue('q').trim();
    const teams = await prisma.team.findMany({
      where: {
        status: { not: 'DISBANDED' },
        OR: [
          { tag: { contains: q, mode: 'insensitive' } },
          { name: { contains: q, mode: 'insensitive' } },
          { teamId: { contains: q, mode: 'insensitive' } },
        ],
      },
      take: 10,
    });
    if (!teams.length) return interaction.editReply({ embeds: [errorEmbed('No teams found.')] });
    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('admin:team:pick')
        .setPlaceholder('Select a team')
        .addOptions(teams.map((t) => ({ label: `[${t.tag}] ${t.name}`.slice(0, 100), value: t.id, description: `${t.teamId} • ${t.status}`.slice(0, 100) })))
    );
    return interaction.editReply({ content: 'Select a team:', components: [row] });
  }

  if (id === 'admin:players:search') {
    await interaction.deferReply({ ephemeral: true });
    const q = interaction.fields.getTextInputValue('q').trim();
    const players = await prisma.player.findMany({
      where: { OR: [{ gameUid: q }, { ign: { contains: q, mode: 'insensitive' } }] },
      take: 10,
    });
    if (!players.length) return interaction.editReply({ embeds: [errorEmbed('No players found.')] });
    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('admin:player:pick')
        .setPlaceholder('Select a player')
        .addOptions(players.map((p) => ({ label: p.ign.slice(0, 100), value: p.id, description: `UID ${p.gameUid}`.slice(0, 100) })))
    );
    return interaction.editReply({ content: 'Select a player:', components: [row] });
  }

  if (id.startsWith('admin:team:edit:modal:')) {
    const teamId = id.split(':')[4];
    await interaction.deferReply({ ephemeral: true });
    const team = await prisma.team.findUnique({ where: { id: teamId } });
    if (!team) return interaction.editReply({ embeds: [errorEmbed('Team not found.')] });
    const name = interaction.fields.getTextInputValue('t_name').trim() || team.name;
    const tag = (interaction.fields.getTextInputValue('t_tag').trim() || team.tag).toUpperCase();
    const logo = interaction.fields.getTextInputValue('t_logo').trim();
    const region = interaction.fields.getTextInputValue('t_region').trim();
    if (tag !== team.tag) {
      const taken = await prisma.team.findFirst({ where: { tag, status: { not: 'DISBANDED' }, NOT: { id: team.id } } });
      if (taken) return interaction.editReply({ embeds: [errorEmbed(`Tag **${tag}** is already taken.`)] });
    }
    await prisma.team.update({ where: { id: team.id }, data: { name, tag, logo: logo || null, region: region || null } });
    if (team.roleId) {
      const role = await interaction.guild.roles.fetch(team.roleId).catch(() => null);
      if (role) await role.setName(`[${tag}] ${name}`.slice(0, 100)).catch(() => {});
    }
    await adminAudit(interaction, 'TEAM_EDIT', `admin edited ${team.tag} -> ${tag}`);
    return interaction.editReply({ embeds: [successEmbed(`Team updated: **${name} [${tag}]**.`)] });
  }

  if (id.startsWith('admin:announce:modal:')) {
    const channelId = id.split(':')[3];
    await interaction.deferReply({ ephemeral: true });
    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return interaction.editReply({ embeds: [errorEmbed('Channel not found.')] });
    const title = interaction.fields.getTextInputValue('a_title').trim();
    const message = interaction.fields.getTextInputValue('a_message').trim();
    await channel.send({ embeds: [new EmbedBuilder().setColor(0xf1c40f).setTitle(`📢 ${title}`).setDescription(message).setFooter({ text: `Announced by ${interaction.user.username}` })] });
    await adminAudit(interaction, 'ANNOUNCE', `#${channel.name}: ${title}`);
    return interaction.editReply({ embeds: [successEmbed(`Announcement sent to **#${channel.name}**.`)] });
  }

  if (id === 'admin:dm:modal') {
    await interaction.deferReply({ ephemeral: true });
    const title = interaction.fields.getTextInputValue('dm_title').trim();
    const message = interaction.fields.getTextInputValue('dm_message').trim();
    dmDrafts.set(interaction.user.id, { title, message });
    const count = await prisma.team.count({ where: { status: 'ACTIVE' } });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('admin:dm:yes').setLabel(`Send to ${count} team owners`).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('admin:dm:no').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    );
    return interaction.editReply({
      content: 'Preview — this will DM **every active team owner**:',
      embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`📢 ${title}`).setDescription(message)],
      components: [row],
    });
  }

  if (id === 'admin:settings:modal') {
    await interaction.deferReply({ ephemeral: true });
    const teamSize = parseInt(interaction.fields.getTextInputValue('s_teamsize').trim(), 10);
    const maxSubs = parseInt(interaction.fields.getTextInputValue('s_maxsubs').trim(), 10);
    const prefix = interaction.fields.getTextInputValue('s_prefix').trim().toUpperCase();
    const maps = interaction.fields.getTextInputValue('s_maps').trim().split(',').map((m) => m.trim()).filter(Boolean);
    const adminRoles = interaction.fields.getTextInputValue('s_adminroles').trim().split(',').map((r) => r.trim()).filter((r) => /^\d{10,25}$/.test(r));
    if (!Number.isInteger(teamSize) || teamSize < 1 || teamSize > 8) {
      return interaction.editReply({ embeds: [errorEmbed('Team size must be between 1 and 8.')] });
    }
    if (!Number.isInteger(maxSubs) || maxSubs < 0 || maxSubs > 8) {
      return interaction.editReply({ embeds: [errorEmbed('Max substitutes must be between 0 and 8.')] });
    }
    if (!maps.length) return interaction.editReply({ embeds: [errorEmbed('Provide at least one map.')] });
    await prisma.guildSettings.upsert({
      where: { guildId: interaction.guildId },
      update: { teamSize, maxSubs, teamIdPrefix: prefix || 'BR', maps, adminRoleIds: adminRoles },
      create: { guildId: interaction.guildId, teamSize, maxSubs, teamIdPrefix: prefix || 'BR', maps, adminRoleIds: adminRoles },
    });
    await adminAudit(interaction, 'SETTINGS_UPDATE', `teamSize=${teamSize} maxSubs=${maxSubs} maps=${maps.join('/')}`);
    return interaction.editReply({ embeds: [successEmbed('Settings saved.')] });
  }

  if (id === 'admin:settings:reg:modal') {
    await interaction.deferReply({ ephemeral: true });
    const groupSize = parseInt(interaction.fields.getTextInputValue('s_groupsize').trim(), 10);
    if (!Number.isInteger(groupSize) || groupSize < 1 || groupSize > 100) {
      return interaction.editReply({ embeds: [errorEmbed('Teams per group must be between 1 and 100.')] });
    }
    await prisma.guildSettings.upsert({
      where: { guildId: interaction.guildId },
      update: { groupSize },
      create: { guildId: interaction.guildId, groupSize },
    });
    await adminAudit(interaction, 'SETTINGS_UPDATE', `groupSize=${groupSize}`);
    return interaction.editReply({ embeds: [successEmbed(`Registration settings saved. New registrations will be grouped ${groupSize} teams per group.`)] });
  }
}

module.exports = { handle };
