-- Slot Manager channel + IDP naming pattern + per-group roles
ALTER TABLE "Tournament" ADD COLUMN IF NOT EXISTS "idpNamePattern" TEXT;
ALTER TABLE "Tournament" ADD COLUMN IF NOT EXISTS "slotManagerChannelId" TEXT;
ALTER TABLE "IdpGroup" ADD COLUMN IF NOT EXISTS "roleId" TEXT;
