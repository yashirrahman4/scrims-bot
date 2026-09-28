-- tagsRequired on Tournament (replaces team-size input at creation) + taggedDiscordIds on TournamentRegistration
ALTER TABLE "Tournament" ADD COLUMN IF NOT EXISTS "tagsRequired" INTEGER NOT NULL DEFAULT 4;
ALTER TABLE "TournamentRegistration" ADD COLUMN IF NOT EXISTS "taggedDiscordIds" TEXT[] NOT NULL DEFAULT '{}';
