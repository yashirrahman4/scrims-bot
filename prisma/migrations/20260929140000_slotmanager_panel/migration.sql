-- Track the single merged slot-manager panel message so it can be refreshed
-- and legacy two-panel messages can be cleaned up.
ALTER TABLE "Tournament" ADD COLUMN IF NOT EXISTS "slotManagerPanelMsgId" TEXT;
