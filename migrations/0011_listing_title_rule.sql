-- phase: expand
-- The rule that split a one-line board post into the listing's title (server/jobs/hiring-line.js). A listing is
-- re-derived once (scripts/rederive-hn-titles.js) and the marker means a later run never reads its own new title back
-- as if it were the board's original line. NULL for every board that never needed a split.
ALTER TABLE work_listings ADD COLUMN IF NOT EXISTS title_rule text;
