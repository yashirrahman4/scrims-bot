-- DM broadcast opt-out: team owners can mute update DMs instead of reporting them
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "dmOptOut" BOOLEAN NOT NULL DEFAULT false;
