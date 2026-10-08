-- phase: expand
-- OpenVibe.Work: the job listings gathered from the open job boards (server/jobs/sources.js), the searches a person
-- saved and when they last looked at each, and what each source's last fetch did.
--
-- A listing keeps its provenance: the source it came from and the original URL it must always link back to. Only a
-- short plain-text excerpt is stored — never the board's full description, which stays on the board. Nothing here is
-- ever a credential, a key or a token.

CREATE TABLE work_listings (
    id            text COLLATE "C" PRIMARY KEY,             -- job_<base32>, derived from (source, source_id): stable
    source        text COLLATE "C" NOT NULL,                -- arbeitnow | remotive | remoteok
    source_id     text COLLATE "C" NOT NULL,                -- the board's own id for it
    url           text NOT NULL,                            -- the original listing; always linked, never rehosted
    title         text NOT NULL,
    company       text NOT NULL,
    location      text,
    remote        boolean NOT NULL DEFAULT false,
    tags          text NOT NULL DEFAULT '',                 -- comma-joined, for display
    job_type      text COLLATE "C",                         -- the board's own words, lowercased where it repeats one
    salary        text,                                     -- the board's own salary text, when it gives one
    excerpt       text NOT NULL,                            -- first ~300 characters of the description, plain text
    search_text   text NOT NULL,                            -- lower(title, company, tags, location, excerpt)
    posted_at     text COLLATE "C",                         -- ISO 8601 UTC, when the board says so
    sort_at       text COLLATE "C" NOT NULL,                -- posted_at, or fetched_at when the board gave none
    fetched_at    text COLLATE "C" NOT NULL,                -- when the ingest read the board
    first_seen_at text COLLATE "C" NOT NULL,
    last_seen_at  text COLLATE "C" NOT NULL,                -- touched on every fetch that still lists it
    expired       boolean NOT NULL DEFAULT false            -- not seen for the retention window: hidden, kept
);
-- One row per (source, its id): the ingest upserts on this.
CREATE UNIQUE INDEX work_listings_by_source ON work_listings (source, source_id);
CREATE INDEX work_listings_latest ON work_listings (expired, sort_at DESC, id DESC);
CREATE INDEX work_listings_by_last_seen ON work_listings (last_seen_at);

-- A saved search belongs to the person who saved it (user:usr_…). The filters are the same four the search takes.
CREATE TABLE work_saved_searches (
    id           text COLLATE "C" PRIMARY KEY,              -- ssc_<ULID>
    subject      text COLLATE "C" NOT NULL,
    query        text NOT NULL DEFAULT '',
    remote       text COLLATE "C" NOT NULL DEFAULT '',      -- '' (any) | 'true' | 'false'
    type         text COLLATE "C" NOT NULL DEFAULT '',
    location     text NOT NULL DEFAULT '',
    created_at   text COLLATE "C" NOT NULL,
    last_seen_at text COLLATE "C" NOT NULL                  -- listings first seen after this are "new"
);
CREATE INDEX work_saved_searches_by_subject ON work_saved_searches (subject, created_at DESC);

-- What each source's last fetch did, so /sources can say when it last ran and how it went.
CREATE TABLE work_source_fetches (
    source      text COLLATE "C" PRIMARY KEY,
    started_at  text COLLATE "C" NOT NULL,
    finished_at text COLLATE "C",
    ok          boolean NOT NULL DEFAULT false,
    listings    integer NOT NULL DEFAULT 0,
    error       text
);
