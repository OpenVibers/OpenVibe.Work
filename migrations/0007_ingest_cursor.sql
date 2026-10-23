-- phase: expand
-- Where OpenVibe.Work is in OpenVibe.Sources' change feed (server/ingest/from-sources.js: Arbeitnow through Sources, plan
-- 2026-10-22 track F2; openvibe-publishing/ingest, prefix work). The DDL is openvibe-publishing lib/ingest.js schema('work').
CREATE TABLE IF NOT EXISTS work_ingest_cursor (
    name       text COLLATE "C" NOT NULL,
    cursor     bigint NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (name)
);
