-- Bring-your-own-problem columns on app.problems (docs/BYOP.md).
--
-- Run by Spring at every startup (spring.sql.init), so every statement must be
-- idempotent. This is deliberately NOT in db/init/: those scripts only run on an
-- empty volume, and the demo volume must never be wiped (CLAUDE.md D3-T4).
--
-- Curated rows (two-sum) keep working untouched: every new column has a default
-- that describes exactly what they already were.
ALTER TABLE app.problems ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'curated';
ALTER TABLE app.problems ADD COLUMN IF NOT EXISTS owner_id TEXT;
ALTER TABLE app.problems ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'python';
ALTER TABLE app.problems ADD COLUMN IF NOT EXISTS constraints_text TEXT NOT NULL DEFAULT '';
ALTER TABLE app.problems ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS problems_owner_idx ON app.problems (owner_id, created_at);
