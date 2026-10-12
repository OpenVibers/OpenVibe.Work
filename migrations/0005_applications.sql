-- phase: expand
-- OpenVibe.Work: the job applications a signed-in person tracks (server/applications.js), and the append-only
-- history of their status changes. An application is either tracked from a Work listing (listing_id, from which its
-- title, company and url are copied) or given by hand. Nothing here is ever a credential, a key or a token.

CREATE TABLE work_applications (
    id            text COLLATE "C" PRIMARY KEY,              -- wap_<ULID>
    subject_id    text COLLATE "C" NOT NULL,                 -- user:usr_… — the person tracking it
    listing_id    text COLLATE "C",                          -- job_<base32> when it came from a listing
    title         text NOT NULL,
    company       text NOT NULL,
    url           text NOT NULL,                             -- the listing's own URL, or the one given by hand
    status        text COLLATE "C" NOT NULL DEFAULT 'saved', -- saved|applied|interviewing|offer|rejected|withdrawn
    notes         text NOT NULL DEFAULT '',
    applied_at    text COLLATE "C",                          -- ISO 8601 UTC
    next_step_at  text COLLATE "C",                          -- ISO 8601 UTC
    next_step     text NOT NULL DEFAULT '',
    actor_task_id text COLLATE "C",                          -- the last OpenVibe.Actor task this application asked for
    assists       integer NOT NULL DEFAULT 0,                -- how many times the person asked their agent (idempotency n)
    created_at    text COLLATE "C" NOT NULL,
    updated_at    text COLLATE "C" NOT NULL,
    CONSTRAINT work_applications_notes_len CHECK (char_length(notes) <= 5000),
    CONSTRAINT work_applications_next_step_len CHECK (char_length(next_step) <= 200)
);
-- The API lists an application's rows newest-first and pages on this.
CREATE INDEX work_applications_by_subject ON work_applications (subject_id, updated_at);

-- Append-only: one row per status change, never updated. When an application is erased its events go with it.
CREATE TABLE work_application_events (
    application_id text COLLATE "C" NOT NULL REFERENCES work_applications (id) ON DELETE CASCADE,
    at             text COLLATE "C" NOT NULL,                -- ISO 8601 UTC
    from_status    text COLLATE "C" NOT NULL,
    to_status      text COLLATE "C" NOT NULL
);
CREATE INDEX work_application_events_by_app ON work_application_events (application_id, at);
