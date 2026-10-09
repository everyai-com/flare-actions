-- CI profiles: a schedule pins the profile it fires with (nightly full
-- suite vs per-push smoke). NULL = the pipeline's schedule default,
-- else every job. Validated against flare.yml at fire time.
ALTER TABLE schedules ADD COLUMN profile TEXT;
