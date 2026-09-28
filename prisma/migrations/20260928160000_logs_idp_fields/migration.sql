-- Log channels per action, IDP groups, per-tournament teams-per-group, registration qualified flag
ALTER TABLE "GuildSettings" ADD COLUMN IF NOT EXISTS "logTeamVerify" TEXT;
ALTER TABLE "GuildSettings" ADD COLUMN IF NOT EXISTS "logTourneyReg" TEXT;
ALTER TABLE "GuildSettings" ADD COLUMN IF NOT EXISTS "logScrimReg" TEXT;
ALTER TABLE "GuildSettings" ADD COLUMN IF NOT EXISTS "logAdminActivity" TEXT;

ALTER TABLE "Tournament" ADD COLUMN IF NOT EXISTS "teamsPerGroup" INTEGER;
ALTER TABLE "Tournament" ADD COLUMN IF NOT EXISTS "idpCategoryId" TEXT;
ALTER TABLE "TournamentRegistration" ADD COLUMN IF NOT EXISTS "qualified" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "IdpGroup" (
  "id" TEXT NOT NULL,
  "tournamentId" TEXT NOT NULL,
  "groupNo" INTEGER NOT NULL,
  "channelId" TEXT NOT NULL,
  "categoryId" TEXT,
  "panelMsgId" TEXT,
  "locked" BOOLEAN NOT NULL DEFAULT true,
  "matchesDate" TIMESTAMP(3),
  "totalMatches" INTEGER NOT NULL DEFAULT 1,
  "idpRoleHolderId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IdpGroup_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "IdpGroup_channelId_key" ON "IdpGroup"("channelId");
CREATE UNIQUE INDEX IF NOT EXISTS "IdpGroup_tournamentId_groupNo_key" ON "IdpGroup"("tournamentId", "groupNo");
ALTER TABLE "IdpGroup" ADD CONSTRAINT "IdpGroup_tournamentId_fkey"
  FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "IdpMatch" (
  "id" TEXT NOT NULL,
  "idpGroupId" TEXT NOT NULL,
  "matchNo" INTEGER NOT NULL,
  "map" TEXT NOT NULL DEFAULT 'Erangel',
  "idpAt" TEXT,
  "startAt" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IdpMatch_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "IdpMatch_idpGroupId_matchNo_key" ON "IdpMatch"("idpGroupId", "matchNo");
ALTER TABLE "IdpMatch" ADD CONSTRAINT "IdpMatch_idpGroupId_fkey"
  FOREIGN KEY ("idpGroupId") REFERENCES "IdpGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
