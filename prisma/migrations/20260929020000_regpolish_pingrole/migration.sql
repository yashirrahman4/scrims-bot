-- Registration polish: optional ping role announced once when registration starts
ALTER TABLE "Tournament" ADD COLUMN IF NOT EXISTS "pingRoleId" TEXT;
