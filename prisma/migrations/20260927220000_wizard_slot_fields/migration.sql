-- Team verification wizard: contact fields
ALTER TABLE "Team" ADD COLUMN "email" TEXT;
ALTER TABLE "Team" ADD COLUMN "phone" TEXT;

-- Tournament: invite link + registration announcement tracking
ALTER TABLE "Tournament" ADD COLUMN "inviteUrl" TEXT;
ALTER TABLE "Tournament" ADD COLUMN "announceChannelId" TEXT;
ALTER TABLE "Tournament" ADD COLUMN "announceMsgId" TEXT;

-- Registrations: auto-assigned slot + group numbers
ALTER TABLE "TournamentRegistration" ADD COLUMN "slotNo" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TournamentRegistration" ADD COLUMN "groupNo" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "TournamentRegistration_tournamentId_slotNo_key" ON "TournamentRegistration"("tournamentId", "slotNo");

-- Guild settings: teams per group for auto group assignment
ALTER TABLE "GuildSettings" ADD COLUMN "groupSize" INTEGER NOT NULL DEFAULT 20;
