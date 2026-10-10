-- Speculative stacked trains: up to lanes.speculation_depth train groups
-- may be in flight per repo, each stacked on the previous group's
-- speculative head. Active trains form one chain ordered by
-- (group_seq, lane); `lane` is the lane-ref slot (forge/lane-0..31).
-- Rows from before this migration keep group_seq 0 (one group).
ALTER TABLE trains ADD COLUMN group_seq INTEGER NOT NULL DEFAULT 0;
