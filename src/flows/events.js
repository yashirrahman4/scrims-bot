const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  EmbedBuilder,
} = require('discord.js');
const { prisma } = require('../db');
const {
  getOrCreateUser,
  getOwnedTeam,
  getSettings,
  starterCount,
  errorEmbed,
  successEmbed,
  formatIST,
  audit,
  sendLogEmbed,
} = require('../utils');

async function handle(interaction) {
  try {
    if (interaction.isButton()) return handleButton(interaction);
    if (interaction.isStringSelectMenu() || interaction.isUserSelectMenu?.()) return handleSelect(interaction);
  } catch (err) {
    console.error('[events] error:', err);
    try {
      if (interaction.deferred) {
        await interaction.editReply({ content: null, embeds: [errorEmbed('Something went wrong. Please try again.')], components: [] });
      } else if (!interaction.replied) {
        await interaction.reply({ embeds: [errorEmbed('Something went wrong. Please try again.')], ephemeral: true });
      }
    } catch {}
  }
}

const labelFor = (type) => (type === 'SCRIM' ? 'scrim' : 'tournament');

async function slotsTaken(eventId) {
  return prisma.tournamentRegistration.count({
    where: { tournamentId: eventId, status: { in: ['PENDING', 'APPROVED'] } },
  });
}

/** Shared eligibility check. Returns a problem string, or null when the team can register. */
async function checkEligibility(event, team) {
  if (!team) return 'Please register a team first (Team Verification panel).';
  if (team.status !== 'ACTIVE') return 'Your team is not active. Contact an admin.';
  const need = event.tagsRequired || 4;
  if (starterCount(team) < need)
    return `Your roster needs at least ${need} starters — your leader must tag ${need} teammates at registration. Add players from Team Manager.`;
  const existing = await prisma.tournamentRegistration.findFirst({
    where: { tournamentId: event.id, teamId: team.id, status: { not: 'REMOVED' } },
  });
  if (existing) return 'Your team is already registered for this event.';
  const taken = await slotsTaken(event.id);
  if (taken >= event.teamLimit) return 'All slots for this event are full.';
  return null;
}

/** Create the registration with auto-assigned slot + group numbers. Retries on slot races. */
async function createRegistrationWithSlot(event, team, dbUser, groupSize, taggedIds = []) {
  const size = Math.max(groupSize || 20, 1);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const taken = await tx.tournamentRegistration.count({
          where: { tournamentId: event.id, status: { in: ['PENDING', 'APPROVED'] } },
        });
        if (taken >= event.teamLimit) throw new Error('FULL');
        const slotNo = taken + 1;
        const groupNo = Math.ceil(slotNo / size);
        return tx.tournamentRegistration.create({
          data: { tournamentId: event.id, teamId: team.id, registeredBy: dbUser.id, status: 'PENDING', slotNo, groupNo, taggedDiscordIds: taggedIds },
        });
      });
    } catch (e) {
      if (e.message === 'FULL') throw new Error('Slots just filled up — better luck next time.');
      if (e.code === 'P2002') {
        // (tournamentId, teamId) duplicate -> already registered; (tournamentId, slotNo) -> race, retry
        const dupTeam = await prisma.tournamentRegistration.findFirst({
          where: { tournamentId: event.id, teamId: team.id, status: { not: 'REMOVED' } },
        });
        if (dupTeam) throw new Error('Your team is already registered for this event.');
        continue;
      }
      throw e;
    }
  }
  throw new Error('Could not assign a slot — please try again.');
}

/** True when the event has a scheduled registration start that hasn't arrived yet. */
function regNotStarted(event) {
  return !!(event.regStartsAt && event.regStartsAt > new Date());
}

function regStartsInMessage(event) {
  const ts = Math.floor(new Date(event.regStartsAt).getTime() / 1000);
  return `Registration for **${event.name}** opens <t:${ts}:F>.`;
}

function registrationSuccessEmbed(team, event, reg, dmOk = true) {
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('🎉 Registration Successful')
    .setDescription(
      'Your team has been successfully registered:\n\n' +
        `• Team Name: **${team.name}**\n` +
        `• Group Assigned: \`Group ${reg.groupNo}\`\n` +
        `• Slot Assigned: \`Slot ${reg.slotNo}\`` +
        (reg.taggedDiscordIds?.length ? `\n• Tagged: ${reg.taggedDiscordIds.map((id) => `<@${id}>`).join(' ')}` : '') +
        (event.successMessage && !dmOk ? `\n\n💬 ${event.successMessage}\n_(Couldn't DM you — your DMs may be closed.)_` : '')
    );
  return embed;
}

/** DM the event's custom success message to the registering user. Returns true when sent. Never throws. */
async function dmSuccessMessage(interaction, event) {
  if (!event.successMessage) return true;
  try {
    await interaction.user.send({
      embeds: [
        new EmbedBuilder().setColor(0x57f287).setTitle(`🎉 ${event.name}`).setDescription(event.successMessage),
      ],
    });
    return true;
  } catch (e) {
    console.error('[events] success DM failed:', e.message);
    return false;
  }
}

/** Success-role grant + log-channel post after a registration. Never throws. */
async function applyRegistrationExtras(interaction, event, team, reg) {
  const guild = interaction.guild;
  if (!guild) return;
  if (event.successRoleId) {
    try {
      const member = await guild.members.fetch(interaction.user.id);
      if (member) await member.roles.add(event.successRoleId);
    } catch (e) {
      console.error('[events] success-role assign failed:', e.message);
    }
  }
  if (event.logChannelId) {
    try {
      const ch = await guild.channels.fetch(event.logChannelId).catch(() => null);
      if (ch && ch.isTextBased()) {
        await ch.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0x57f287)
              .setTitle('✅ New Registration')
              .setDescription(
                `**[${team.tag}] ${team.name}** registered for **${event.name}**\nGroup ${reg.groupNo} · Slot ${reg.slotNo} · <@${interaction.user.id}>` +
                  (reg.taggedDiscordIds?.length ? `\n🏷️ Tagged: ${reg.taggedDiscordIds.map((id) => `<@${id}>`).join(' ')}` : '')
              ),
          ],
        });
      }
    } catch (e) {
      console.error('[events] registration log failed:', e.message);
    }
  } else {
    // Fall back to the global scrim/tournament registration log channels from Logs setup.
    const settings = await getSettings(interaction.guildId);
    const channelId = event.type === 'SCRIM' ? settings.logScrimReg : settings.logTourneyReg;
    await sendLogEmbed(
      interaction.client,
      interaction.guildId,
      channelId,
      new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('✅ New Registration')
        .setDescription(
          `**[${team.tag}] ${team.name}** registered for **${event.name}**\nGroup ${reg.groupNo} · Slot ${reg.slotNo} · <@${interaction.user.id}>` +
            (reg.taggedDiscordIds?.length ? `\n🏷️ Tagged: ${reg.taggedDiscordIds.map((id) => `<@${id}>`).join(' ')}` : '')
        )
    );
  }
}

/** Tag-teammates picker shown before a registration is finalized. */
async function askForTags(interaction, eventId, useUpdate) {
  if (useUpdate && !interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  const event = await prisma.tournament.findUnique({ where: { id: eventId } });
  if (!event || event.status !== 'OPEN') {
    const p = { content: 'This event is no longer open.', embeds: [], components: [] };
    if (interaction.deferred) return interaction.editReply(p);
    return interaction.reply({ ...p, ephemeral: true });
  }
  if (regNotStarted(event)) {
    const p = { embeds: [errorEmbed(regStartsInMessage(event))], components: [] };
    if (interaction.deferred) return interaction.editReply(p);
    return interaction.reply({ ...p, ephemeral: true });
  }
  const dbUser = await getOrCreateUser(interaction.user);
  const team = await getOwnedTeam(dbUser.id);
  const problem = await checkEligibility(event, team);
  if (problem) {
    const p = { embeds: [errorEmbed(problem)], components: [] };
    if (interaction.deferred) return interaction.editReply(p);
    return interaction.reply({ ...p, ephemeral: true });
  }
  const tags = event.tagsRequired || 4;
  const row = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(`event:tags:${event.id}`)
      .setPlaceholder(`Tag your ${tags} teammates`)
      .setMinValues(tags)
      .setMaxValues(tags)
  );
  const payload = {
    content: `🏷️ **${team.name} [${team.tag}]** — tag the **${tags}** teammates playing this ${labelFor(event.type)}:`,
    embeds: [],
    components: [row],
  };
  if (interaction.deferred) return interaction.editReply(payload);
  return useUpdate ? interaction.update(payload) : interaction.reply({ ...payload, ephemeral: true });
}

/** Finalize a registration after the leader tagged their teammates. */
async function confirmRegistrationWithTags(interaction, eventId) {
  await interaction.deferUpdate();
  const event = await prisma.tournament.findUnique({ where: { id: eventId } });
  if (!event || event.status !== 'OPEN') {
    return interaction.editReply({ content: 'This event is no longer open.', embeds: [], components: [] });
  }
  if (regNotStarted(event)) {
    return interaction.editReply({ content: null, embeds: [errorEmbed(regStartsInMessage(event))], components: [] });
  }
  const dbUser = await getOrCreateUser(interaction.user);
  const team = await getOwnedTeam(dbUser.id);
  const problem = await checkEligibility(event, team);
  if (problem) {
    return interaction.editReply({ content: null, embeds: [errorEmbed(problem)], components: [] });
  }
  const tags = event.tagsRequired || 4;
  const taggedIds = [...new Set(interaction.values || [])];
  if (taggedIds.length !== tags) {
    return interaction.editReply({ content: null, embeds: [errorEmbed(`Please tag exactly ${tags} teammates.`)] , components: [] });
  }
  const settings = await getSettings(interaction.guildId);
  let reg;
  try {
    reg = await createRegistrationWithSlot(event, team, dbUser, event.teamsPerGroup || settings.groupSize, taggedIds);
  } catch (e) {
    return interaction.editReply({ content: null, embeds: [errorEmbed(e.message)], components: [] });
  }
  await audit('EVENT_REGISTER', interaction.user.id, `${team.tag} registered for ${event.name} (${event.type}) — Group ${reg.groupNo}, Slot ${reg.slotNo}, tagged ${taggedIds.length}`);
  // The custom success message goes to the user's DMs; if DMs are closed it
  // falls back to the ephemeral reply so it is never lost.
  const dmOk = await dmSuccessMessage(interaction, event);
  await interaction.editReply({
    content: null,
    embeds: [registrationSuccessEmbed(team, event, reg, dmOk)],
    components: [],
  });
  await applyRegistrationExtras(interaction, event, team, reg);
}

/** Public announcement post for an event's registration channel (mirrors the reference style). */
function registrationPostPayload(event, taken) {
  const left = Math.max(event.teamLimit - taken, 0);
  const tags = event.tagsRequired || 4;
  const embed = new EmbedBuilder()
    .setColor(event.type === 'SCRIM' ? 0x5865f2 : 0x9b59b6)
    .setTitle(`${event.type === 'SCRIM' ? '🎯' : '🏆'} ${event.name}`)
    .setDescription(
      (event.description || `Tap the Register button below to register for ${event.name}.`) +
        `\n\nDate: ${formatIST(event.date)}\nSlots: **${taken}/${event.teamLimit}** (${left} left)\n🏷️ Tag your ${tags} teammates when you register.`
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`event:registerpost:${event.id}`)
      .setLabel('Register')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('✅')
      .setDisabled(left <= 0)
  );
  return { embeds: [embed], components: [row] };
}

/** Post (or refresh) the registration announcement in a channel; records the message id on the event. */
async function postRegistrationAnnouncement(client, guildId, channelId, eventId) {
  const event = await prisma.tournament.findUnique({ where: { id: eventId } });
  if (!event) throw new Error('Event not found.');
  const guild = await client.guilds.fetch(guildId);
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) throw new Error('Channel not found.');
  const taken = await slotsTaken(event.id);
  // delete the old announcement if we posted one before
  if (event.announceMsgId && event.announceChannelId) {
    const oldCh = await guild.channels.fetch(event.announceChannelId).catch(() => null);
    if (oldCh && oldCh.isTextBased()) {
      const oldMsg = await oldCh.messages.fetch(event.announceMsgId).catch(() => null);
      if (oldMsg) await oldMsg.delete().catch(() => {});
    }
  }
  const msg = await channel.send(registrationPostPayload(event, taken));
  await prisma.tournament.update({
    where: { id: event.id },
    data: { announceChannelId: channel.id, announceMsgId: msg.id, regChannelId: channel.id },
  });
  return msg;
}

function eventCardEmbed(event, taken) {
  const left = Math.max(event.teamLimit - taken, 0);
  return new EmbedBuilder()
    .setColor(event.type === 'SCRIM' ? 0x5865f2 : 0x9b59b6)
    .setTitle(`${event.type === 'SCRIM' ? '🎯' : '🏆'} ${event.name}`)
    .setDescription(event.description || '—')
    .addFields(
      { name: 'Date', value: formatIST(event.date), inline: true },
      { name: 'Tags Required', value: String(event.tagsRequired || 4), inline: true },
      { name: 'Slots', value: `${taken}/${event.teamLimit} (${left} left)`, inline: true }
    );
}

// ---------- registration entry points ----------

async function openEventPicker(interaction, type) {
  // Acknowledge FIRST — the queries below can take a while on a remote DB.
  await interaction.deferReply({ ephemeral: true });
  const events = await prisma.tournament.findMany({
    where: {
      type,
      status: 'OPEN',
      // hide events whose scheduled registration start is still in the future
      AND: [{ OR: [{ regStartsAt: null }, { regStartsAt: { lte: new Date() } }] }],
      OR: [{ date: null }, { date: { gte: new Date() } }],
    },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    take: 25,
  });
  if (!events.length) {
    return interaction.editReply({
      embeds: [errorEmbed(`No open ${labelFor(type)}s right now. Check back later.`)],
    });
  }
  // Single grouped query instead of one count per event.
  const counts = await prisma.tournamentRegistration.groupBy({
    by: ['tournamentId'],
    where: { tournamentId: { in: events.map((e) => e.id) }, status: { in: ['PENDING', 'APPROVED'] } },
    _count: { _all: true },
  });
  const takenById = new Map(counts.map((c) => [c.tournamentId, c._count._all]));
  const options = events.map((e) => {
    const taken = takenById.get(e.id) || 0;
    return {
      label: e.name.slice(0, 100),
      value: e.id,
      description: `${formatIST(e.date)} • ${Math.max(e.teamLimit - taken, 0)} slots left`.slice(0, 100),
    };
  });
  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`event:pick:${type}`)
      .setPlaceholder(`Select a ${labelFor(type)}`)
      .addOptions(options)
  );
  return interaction.editReply({
    content: `Select a ${labelFor(type)} to register for:`,
    components: [row],
  });
}

async function showEventDetail(interaction, eventId) {
  await interaction.deferUpdate();
  const event = await prisma.tournament.findUnique({ where: { id: eventId } });
  if (!event || event.status !== 'OPEN') {
    return interaction.editReply({ content: 'This event is no longer open for registration.', embeds: [], components: [] });
  }
  if (regNotStarted(event)) {
    return interaction.editReply({ content: null, embeds: [errorEmbed(regStartsInMessage(event))], components: [] });
  }
  const dbUser = await getOrCreateUser(interaction.user);
  const team = await getOwnedTeam(dbUser.id);

  const problem = await checkEligibility(event, team);
  if (problem) {
    return interaction.editReply({ content: null, embeds: [errorEmbed(problem)], components: [] });
  }

  const taken = await slotsTaken(event.id);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`event:confirm:${event.id}`).setLabel('Confirm Registration').setStyle(ButtonStyle.Success).setEmoji('✅'),
    new ButtonBuilder().setCustomId('event:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
  );
  return interaction.editReply({
    content: `Register **${team.name} [${team.tag}]** for this ${labelFor(event.type)}?`,
    embeds: [eventCardEmbed(event, taken)],
    components: [row],
  });
}

/** Direct registration from the announcement post's Register button — leader tags teammates first. */
async function registerFromPost(interaction, eventId) {
  await interaction.deferReply({ ephemeral: true });
  return askForTags(interaction, eventId, false);
}

// ---------- my registrations / cancel ----------

const statusEmoji = { PENDING: '⏳', APPROVED: '✅', DISQUALIFIED: '⛔', REMOVED: '—' };

async function listMyRegs(interaction, type) {
  await interaction.deferReply({ ephemeral: true });
  const dbUser = await getOrCreateUser(interaction.user);
  const team = await getOwnedTeam(dbUser.id);
  if (!team) return interaction.editReply({ embeds: [errorEmbed('You do not own a team.')] });
  const regs = await prisma.tournamentRegistration.findMany({
    where: { teamId: team.id, status: { not: 'REMOVED' }, tournament: { type } },
    include: { tournament: true },
    orderBy: { registeredAt: 'desc' },
    take: 20,
  });
  if (!regs.length) {
    return interaction.editReply({ embeds: [errorEmbed(`No ${labelFor(type)} registrations yet.`)] });
  }
  const lines = regs.map(
    (r) => `${statusEmoji[r.status] || '•'} **${r.tournament.name}** — Group ${r.groupNo} · Slot ${r.slotNo} — ${formatIST(r.tournament.date)} — \`${r.status}\``
  );
  return interaction.editReply({
    embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`My ${type === 'SCRIM' ? 'Scrims' : 'Tournaments'} — ${team.tag}`).setDescription(lines.join('\n'))],
  });
}

async function openUnregisterPicker(interaction, type) {
  await interaction.deferReply({ ephemeral: true });
  const dbUser = await getOrCreateUser(interaction.user);
  const team = await getOwnedTeam(dbUser.id);
  if (!team) return interaction.editReply({ embeds: [errorEmbed('You do not own a team.')] });
  const regs = await prisma.tournamentRegistration.findMany({
    where: { teamId: team.id, status: { in: ['PENDING', 'APPROVED'] }, tournament: { type } },
    include: { tournament: true },
    take: 25,
  });
  if (!regs.length) return interaction.editReply({ embeds: [errorEmbed('Nothing to cancel.')] });
  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`event:unreg:pick:${type}`)
      .setPlaceholder('Select a registration to cancel')
      .addOptions(
        regs.map((r) => ({
          label: r.tournament.name.slice(0, 100),
          value: r.id,
          description: `${formatIST(r.tournament.date)} • ${r.status}`.slice(0, 100),
        }))
      )
  );
  return interaction.editReply({ content: 'Select a registration to cancel:', components: [row] });
}

// ---------- routers ----------

async function handleButton(interaction) {
  const id = interaction.customId;
  if (id === 'scrim:register') return openEventPicker(interaction, 'SCRIM');
  if (id === 'tournament:register') return openEventPicker(interaction, 'TOURNAMENT');
  if (id === 'scrim:my') return listMyRegs(interaction, 'SCRIM');
  if (id === 'tournament:my') return listMyRegs(interaction, 'TOURNAMENT');
  if (id === 'scrim:unregister') return openUnregisterPicker(interaction, 'SCRIM');
  if (id === 'tournament:unregister') return openUnregisterPicker(interaction, 'TOURNAMENT');
  if (id === 'event:cancel') return interaction.update({ content: 'Cancelled.', embeds: [], components: [] });
  if (id.startsWith('event:confirm:')) return askForTags(interaction, id.split(':')[2], true);
  if (id.startsWith('event:registerpost:')) return registerFromPost(interaction, id.split(':')[2]);
  if (id.startsWith('event:unreg:yes:')) {
    await interaction.deferUpdate();
    const regId = id.split(':')[3];
    const dbUser = await getOrCreateUser(interaction.user);
    const team = await getOwnedTeam(dbUser.id);
    const reg = await prisma.tournamentRegistration.findFirst({
      where: { id: regId, teamId: team?.id, status: { in: ['PENDING', 'APPROVED'] } },
      include: { tournament: true },
    });
    if (!reg) return interaction.editReply({ content: 'Registration not found.', embeds: [], components: [] });
    await prisma.tournamentRegistration.update({ where: { id: reg.id }, data: { status: 'REMOVED' } });
    await audit('EVENT_UNREGISTER', interaction.user.id, `${team.tag} withdrew from ${reg.tournament.name}`);
    {
      const settings = await getSettings(interaction.guildId);
      const logChannelId = reg.tournament.logChannelId || (reg.tournament.type === 'SCRIM' ? settings.logScrimReg : settings.logTourneyReg);
      await sendLogEmbed(
        interaction.client,
        interaction.guildId,
        logChannelId,
        new EmbedBuilder()
          .setColor(0xf1c40f)
          .setTitle('❌ Registration Withdrawn')
          .setDescription(`**[${team.tag}] ${team.name}** withdrew from **${reg.tournament.name}** (was Group ${reg.groupNo} · Slot ${reg.slotNo}) · <@${interaction.user.id}>`)
      );
    }
    return interaction.editReply({ content: `✅ Registration for **${reg.tournament.name}** cancelled.`, embeds: [], components: [] });
  }
  if (id === 'event:unreg:no') return interaction.update({ content: 'Cancelled.', embeds: [], components: [] });
}

async function handleSelect(interaction) {
  const id = interaction.customId;
  if (id.startsWith('event:tags:')) return confirmRegistrationWithTags(interaction, id.split(':')[2]);
  if (id.startsWith('event:pick:')) return showEventDetail(interaction, interaction.values[0]);
  if (id.startsWith('event:unreg:pick:')) {
    await interaction.deferUpdate();
    const regId = interaction.values[0];
    const reg = await prisma.tournamentRegistration.findUnique({ where: { id: regId }, include: { tournament: true } });
    if (!reg) return interaction.editReply({ content: 'Registration not found.', embeds: [], components: [] });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`event:unreg:yes:${reg.id}`).setLabel('Yes, cancel it').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('event:unreg:no').setLabel('Keep it').setStyle(ButtonStyle.Secondary)
    );
    return interaction.editReply({
      content: `Cancel registration for **${reg.tournament.name}**?`,
      embeds: [],
      components: [row],
    });
  }
}

module.exports = { handle, postRegistrationAnnouncement, registrationPostPayload, slotsTaken, createRegistrationWithSlot, checkEligibility };
