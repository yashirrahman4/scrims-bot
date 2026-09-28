-- Registration management panel fields (mirror of the reference tournament manager)
ALTER TABLE "Tournament" ADD COLUMN IF NOT EXISTS "regStartsAt" TIMESTAMP(3);
ALTER TABLE "Tournament" ADD COLUMN IF NOT EXISTS "regChannelId" TEXT;
ALTER TABLE "Tournament" ADD COLUMN IF NOT EXISTS "logChannelId" TEXT;
ALTER TABLE "Tournament" ADD COLUMN IF NOT EXISTS "successRoleId" TEXT;
ALTER TABLE "Tournament" ADD COLUMN IF NOT EXISTS "successMessage" TEXT;
