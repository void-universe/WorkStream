-- Compaction watermark: how much of the context budget the history window may take before the round
-- folds the older part into a summary. Nullable with no default because the migration API only
-- accepts ADD COLUMN in that shape; code writes 95 whenever a row is created, and a null row reads
-- as 95 (the same 0.8-then-summary behaviour, now explicit and per employee).
ALTER TABLE app.agents ADD COLUMN compact_at integer;
