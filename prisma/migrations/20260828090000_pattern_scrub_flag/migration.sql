-- The deterministic pattern pass became optional for cloud runs.
--
-- Defaulted true, so every row written before the switch existed records what
-- was actually true of it: the pattern pass ran.
ALTER TABLE "AuditLog" ADD COLUMN "patternScrub" BOOLEAN NOT NULL DEFAULT true;
