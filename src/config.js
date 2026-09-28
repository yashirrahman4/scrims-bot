require('dotenv').config();

module.exports = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  guildId: process.env.GUILD_ID,

  // Defaults used when a server has no saved settings yet.
  defaultMaps: ['Erangel', 'Miramar', 'Rondo'],
  defaultTeamSize: 4,
  defaultMaxSubs: 2,
  teamIdPrefix: 'BR',

  scrimFormats: ['Scrims — Points Table'],
  tournamentFormats: ['Points Table / League', 'Single Elimination', 'Round Robin'],
};
