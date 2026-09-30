-- scrimport-1: Black Raven scrims port — new tables (purely additive).
-- Mirrors the same DDL in src/scrimselfheal.js (HeavenCloud startup self-heal).

CREATE TABLE IF NOT EXISTS "ScrimsVerification" (
  "id" TEXT NOT NULL,
  "ownerDiscordId" TEXT NOT NULL,
  "teamName" TEXT NOT NULL,
  "ownerFullName" TEXT,
  "whatsappNumber" TEXT,
  "ownerEmail" TEXT,
  "city" TEXT,
  "playersJson" TEXT NOT NULL,
  "messageId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'verified',
  "verifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ScrimsVerification_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ScrimsVerification_ownerDiscordId_key" ON "ScrimsVerification"("ownerDiscordId");

CREATE TABLE IF NOT EXISTS "ScrimFormSession" (
  "id" TEXT NOT NULL,
  "userDiscordId" TEXT NOT NULL,
  "flowType" TEXT NOT NULL,
  "payload" TEXT NOT NULL DEFAULT '{}',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScrimFormSession_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ScrimFormSession_userDiscordId_flowType_idx" ON "ScrimFormSession"("userDiscordId", "flowType");

CREATE TABLE IF NOT EXISTS "ScrimGroup" (
  "id" TEXT NOT NULL,
  "groupNo" INTEGER NOT NULL,
  "groupType" TEXT NOT NULL,
  "matchDate" TIMESTAMP(3),
  "channelId" TEXT NOT NULL,
  "roleId" TEXT,
  "categoryId" TEXT,
  "panelMsgId" TEXT,
  "createdBy" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "isOpen" BOOLEAN NOT NULL DEFAULT true,
  "resultPublishedAt" TIMESTAMP(3),
  "cleanedAt" TIMESTAMP(3),
  "slotListAutoPublishedAt" TIMESTAMP(3),
  "matchDayPingedAt" TIMESTAMP(3),
  "resultSsRemindedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScrimGroup_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ScrimGroup_channelId_key" ON "ScrimGroup"("channelId");
CREATE UNIQUE INDEX IF NOT EXISTS "ScrimGroup_groupType_groupNo_key" ON "ScrimGroup"("groupType", "groupNo");

CREATE TABLE IF NOT EXISTS "ScrimMatch" (
  "id" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "matchNo" INTEGER NOT NULL,
  "map" TEXT,
  "idpAt" TIMESTAMP(3),
  "startAt" TIMESTAMP(3),
  "idpReminder30SentAt" TIMESTAMP(3),
  "idpReminder5SentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScrimMatch_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ScrimMatch_groupId_matchNo_key" ON "ScrimMatch"("groupId", "matchNo");
-- Idempotent: the startup self-heal may already have created this FK.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ScrimMatch_groupId_fkey') THEN
    ALTER TABLE "ScrimMatch" ADD CONSTRAINT "ScrimMatch_groupId_fkey"
      FOREIGN KEY ("groupId") REFERENCES "ScrimGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "ScrimSlot" (
  "id" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "slotNo" INTEGER NOT NULL,
  "teamId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'EMPTY',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScrimSlot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ScrimSlot_groupId_slotNo_key" ON "ScrimSlot"("groupId", "slotNo");
-- Idempotent: the startup self-heal may already have created this FK.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ScrimSlot_groupId_fkey') THEN
    ALTER TABLE "ScrimSlot" ADD CONSTRAINT "ScrimSlot_groupId_fkey"
      FOREIGN KEY ("groupId") REFERENCES "ScrimGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "ScrimRegistration" (
  "id" TEXT NOT NULL,
  "teamId" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "slotNo" INTEGER NOT NULL,
  "registrationType" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "registeredBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScrimRegistration_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ScrimRegistration_teamId_status_idx" ON "ScrimRegistration"("teamId", "status");
CREATE INDEX IF NOT EXISTS "ScrimRegistration_groupId_status_idx" ON "ScrimRegistration"("groupId", "status");

CREATE TABLE IF NOT EXISTS "ScrimsBan" (
  "id" TEXT NOT NULL,
  "discordId" TEXT NOT NULL,
  "teamId" TEXT,
  "reason" TEXT,
  "expiresAt" TIMESTAMP(3),
  "bannedBy" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScrimsBan_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ScrimsBan_discordId_active_idx" ON "ScrimsBan"("discordId", "active");

CREATE TABLE IF NOT EXISTS "SlotWarningCount" (
  "id" TEXT NOT NULL,
  "teamId" TEXT NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SlotWarningCount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SlotWarningCount_teamId_key" ON "SlotWarningCount"("teamId");

CREATE TABLE IF NOT EXISTS "SlotWarningLog" (
  "id" TEXT NOT NULL,
  "teamId" TEXT NOT NULL,
  "groupId" TEXT,
  "slotNo" INTEGER,
  "ownerDiscordId" TEXT,
  "staffId" TEXT,
  "warningNo" INTEGER NOT NULL,
  "reason" TEXT,
  "action" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SlotWarningLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "SlotWarningLog_teamId_idx" ON "SlotWarningLog"("teamId");

CREATE TABLE IF NOT EXISTS "SlotReminder" (
  "id" TEXT NOT NULL,
  "userDiscordId" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "notified" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SlotReminder_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SlotReminder_userDiscordId_groupId_key" ON "SlotReminder"("userDiscordId", "groupId");

CREATE TABLE IF NOT EXISTS "ScrimConfirmationPost" (
  "id" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "teamId" TEXT NOT NULL,
  "slotNo" INTEGER NOT NULL,
  "serial" INTEGER NOT NULL,
  "messageId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScrimConfirmationPost_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ScrimConfirmationPost_groupId_idx" ON "ScrimConfirmationPost"("groupId");

CREATE TABLE IF NOT EXISTS "LiveLobbyPanel" (
  "id" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "messageId" TEXT,
  "panelType" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LiveLobbyPanel_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DeletedTeamBackup" (
  "id" TEXT NOT NULL,
  "ownerDiscordId" TEXT NOT NULL,
  "teamName" TEXT NOT NULL,
  "backupJson" TEXT NOT NULL,
  "restored" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeletedTeamBackup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "MessageTemplate" (
  "name" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("name")
);
