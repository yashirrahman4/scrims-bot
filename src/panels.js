const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

/** Mirrors the reference "Scrims Team Verification" panel. */
function teamVerificationPanel() {
  const embed = new EmbedBuilder()
    .setColor(0x0b7a4b)
    .setTitle('🛡️ Scrims Team Verification')
    .setDescription(
      'Register your squad to get verified for scrims.\n\n' +
        '🧾 **Register Team** — create your team & get the verified role\n' +
        '✏️ **My Team** — team owners can edit their roster/info\n' +
        '🚪 **Leave Team** — teammates can leave a team they joined\n\n' +
        'Only one Discord account per player, no fake/duplicate tags. UIDs are automatically checked against the in-game name.'
    );
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('team:register').setLabel('Register Team').setStyle(ButtonStyle.Success).setEmoji('🧾'),
    new ButtonBuilder().setCustomId('team:my').setLabel('My Team').setStyle(ButtonStyle.Primary).setEmoji('✏️')
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('team:leave').setLabel('Leave Team').setStyle(ButtonStyle.Secondary).setEmoji('🚪'),
    new ButtonBuilder().setCustomId('team:manage').setLabel('Team Manager').setStyle(ButtonStyle.Secondary).setEmoji('🛠️')
  );
  return { embeds: [embed], components: [row1, row2] };
}

function scrimRegistrationPanel() {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🎯 Scrims Registration')
    .setDescription(
      'Register your verified team for upcoming scrims.\n\n' +
        '✅ **Register for Scrim** — pick an open scrim & lock your slot\n' +
        '📋 **My Scrims** — view your team\'s scrim registrations\n' +
        '❌ **Cancel Registration** — withdraw from a scrim\n\n' +
        'Only team owners can register. Slots are limited — first come, first served.'
    );
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('scrim:register').setLabel('Register for Scrim').setStyle(ButtonStyle.Success).setEmoji('✅'),
    new ButtonBuilder().setCustomId('scrim:my').setLabel('My Scrims').setStyle(ButtonStyle.Primary).setEmoji('📋')
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('scrim:unregister').setLabel('Cancel Registration').setStyle(ButtonStyle.Secondary).setEmoji('❌')
  );
  return { embeds: [embed], components: [row1, row2] };
}

function tournamentRegistrationPanel() {
  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('🏆 Tournament Registration')
    .setDescription(
      'Register your verified team for tournaments.\n\n' +
        '✅ **Register for Tournament** — pick an open tournament & lock your slot\n' +
        '📋 **My Tournaments** — view your team\'s tournament registrations\n' +
        '❌ **Cancel Registration** — withdraw from a tournament\n\n' +
        'Only team owners can register. Check the tournament rules before registering.'
    );
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tournament:register').setLabel('Register for Tournament').setStyle(ButtonStyle.Success).setEmoji('✅'),
    new ButtonBuilder().setCustomId('tournament:my').setLabel('My Tournaments').setStyle(ButtonStyle.Primary).setEmoji('📋')
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tournament:unregister').setLabel('Cancel Registration').setStyle(ButtonStyle.Secondary).setEmoji('❌')
  );
  return { embeds: [embed], components: [row1, row2] };
}

function adminPanel() {
  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('⚙️ Admin Control Panel')
    .setDescription(
      'Tournament & scrims operations — admins only.\n\n' +
        '🗓️ **Create Event** — new scrim / tournament\n' +
        '🎛️ **Manage Events** — open, lock, go live, complete\n' +
        '📝 **View Registrations** — approve / disqualify teams\n' +
        '👥 **Manage Teams** — view, edit, suspend, disband\n' +
        '🎮 **Manage Players** — look up & manage players'
    );
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin:create').setLabel('Create Event').setStyle(ButtonStyle.Primary).setEmoji('🗓️'),
    new ButtonBuilder().setCustomId('admin:events').setLabel('Manage Events').setStyle(ButtonStyle.Primary).setEmoji('🎛️'),
    new ButtonBuilder().setCustomId('admin:regs').setLabel('View Registrations').setStyle(ButtonStyle.Primary).setEmoji('📝'),
    new ButtonBuilder().setCustomId('admin:teams').setLabel('Manage Teams').setStyle(ButtonStyle.Secondary).setEmoji('👥'),
    new ButtonBuilder().setCustomId('admin:players').setLabel('Manage Players').setStyle(ButtonStyle.Secondary).setEmoji('🎮')
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin:announce').setLabel('Announce').setStyle(ButtonStyle.Secondary).setEmoji('📢'),
    new ButtonBuilder().setCustomId('admin:lock').setLabel('Lock / Unlock').setStyle(ButtonStyle.Secondary).setEmoji('🔒'),
    new ButtonBuilder().setCustomId('admin:dm').setLabel('DM Owners').setStyle(ButtonStyle.Secondary).setEmoji('✉️'),
    new ButtonBuilder().setCustomId('admin:logs').setLabel('Logs').setStyle(ButtonStyle.Secondary).setEmoji('🧾'),
    new ButtonBuilder().setCustomId('admin:settings').setLabel('Settings').setStyle(ButtonStyle.Secondary).setEmoji('⚙️')
  );
  return { embeds: [embed], components: [row1, row2] };
}

module.exports = {
  teamVerificationPanel,
  scrimRegistrationPanel,
  tournamentRegistrationPanel,
  adminPanel,
};
