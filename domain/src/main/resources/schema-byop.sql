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

-- Problems captured by the on-screen agent (docs/BYOP.md "screen problems").
-- source: 'form' (typed in), 'screen' (read off the student's screen), or
-- 'curated'. insights holds the in-depth analysis as one JSON object:
--   function_signature, time_complexity, space_complexity, output_format,
--   screen_language, test_inputs [{input, expected_output, why}], analysed_by
ALTER TABLE app.problems ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'form';
ALTER TABLE app.problems ADD COLUMN IF NOT EXISTS source_site TEXT NOT NULL DEFAULT '';
ALTER TABLE app.problems ADD COLUMN IF NOT EXISTS insights JSONB NOT NULL DEFAULT '{}'::jsonb;
UPDATE app.problems SET source = 'curated' WHERE kind = 'curated' AND source = 'form';

-- Every distinct version of the student's code the agent saw while they solved
-- a problem (written outside this app, e.g. on a practice site). Never run.
CREATE TABLE IF NOT EXISTS app.solve_snapshots (
  id BIGSERIAL PRIMARY KEY,
  problem_id TEXT NOT NULL REFERENCES app.problems(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL,
  code_sha TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (problem_id, owner_id, code_sha)
);
CREATE INDEX IF NOT EXISTS solve_snapshots_problem_idx ON app.solve_snapshots (problem_id, captured_at);
