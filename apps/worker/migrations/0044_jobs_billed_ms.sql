-- Flare Cloud metering: compute time from earlier attempts of a job
-- (retries and reruns) that the terminal-run spend must still bill.
-- The final attempt keeps using started_at/finished_at.
ALTER TABLE jobs ADD COLUMN billed_ms INTEGER NOT NULL DEFAULT 0;
