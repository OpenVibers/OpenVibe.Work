# OpenVibe.Work

> Find work, with an agent on your side.

**Status:** the listings and the search are live (listings gathered from three public job boards, search, saved
searches, an API and the pages around them). The agent pillar — help preparing and tracking an application — is not
written yet.
**Domain:** `openvibe.work` · **Port:** 4960 · **Service id:** `work` · **Env prefix:** `WORK`
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

OpenVibe.Work is the network's job-listings service: it gathers listings from public job boards, keeps each one's
provenance and a short plain-text excerpt, and makes them searchable without an account. A signed-in person can keep a
search and see how many listings have appeared since they last looked. Nothing is republished — every listing links
back to the board, where the reader reads the full listing and applies. The agent pillar (helping prepare and track an
application) is not written yet.

## What it does

Job listings gathered from public job boards, each one carrying its provenance — the board it came from and a link
back to the original listing — searchable, filterable, and readable without an account. A signed-in person can keep a
search and see how many listings have appeared since they last looked. Nothing is republished: Work stores a short
plain-text excerpt and sends the reader to the board for the full listing and to apply.

## What is here

| Piece | Where | What it does |
|---|---|---|
| Config | [server/config.js](server/config.js) | Every value from the environment; `load(env)` is pure so tests build a config without touching `process.env` |
| App | [server/app.js](server/app.js) | helmet (CSP, frame-ancestors none), the Network session middleware, `/auth`, the legal pages, static assets, the `/api/v1` mount, the 404 and the error handler |
| Sign-in | [server/auth/sso.js](server/auth/sso.js) | OAuth 2 authorization code with PKCE (S256) against OpenVibe.Network; httpOnly `work_at` / `work_rt` cookies; `/auth/me` for the shared navbar |
| Sources | [server/jobs/sources.js](server/jobs/sources.js) | The three boards: where each is fetched, its terms, how its payload becomes a listing, and what is refused |
| Ingest | [server/ingest/](server/ingest/) | The background read (timer, User-Agent, 15 s timeout, upsert by source + the board's id, expiry) |
| Listings | [server/jobs/store.js](server/jobs/store.js), [migrations/0002_listings.sql](migrations/0002_listings.sql) | Search, facets, the cursor, saved searches, the fetch record |
| Text | [server/jobs/text.js](server/jobs/text.js) | HTML → plain text, and the ~300-character excerpt that is all we keep |
| API | [server/http/api.js](server/http/api.js) | `/api/v1`: jobs, one job, the sources, saved searches; problem+json errors |
| Pages | [server/http/pages.js](server/http/pages.js), [server/render/](server/render/) | `/`, `/jobs`, `/jobs/:id`, `/saved`, `/sources`, `/docs`, `/updates` — server-rendered, no JavaScript needed |
| Discovery | [server/http/discovery.js](server/http/discovery.js) | `robots.txt`, `sitemap.xml` (the newest listings too), `llms.txt`, `llms-full.txt`, JSON-LD |
| Limits | [server/http/caller-limits.js](server/http/caller-limits.js), [deploy/nginx/](deploy/nginx/) | Per-caller limits at the API (the search and the saved-search writes have their own) and per-address limits at nginx |
| Health | [server/observability.js](server/observability.js) | `/api/health`, a truthful `/api/ready` (the database is required) and Prometheus metrics on loopback only |
| Database | [server/db.js](server/db.js), [migrations/](migrations/) | PostgreSQL through `openvibe-sdk/db`; `NNNN_*.sql` applied at boot; PGlite in development |
| Process | [server/index.js](server/index.js) | Listens on `PORT`, starts the ingest when it is on, and stops gracefully through `openvibe-sdk/service` |
| Deploy | [deploy/nginx/openvibe.work.conf](deploy/nginx/openvibe.work.conf), [deploy/systemd/openvibe-work.service](deploy/systemd/openvibe-work.service) | nginx vhost and systemd unit (port 4960, `/opt/openvibe.work`, `/etc/openvibe/work.env`) |
| Tests | [test/](test/) | `npm test`: every `test/*.test.js` in its own process, on a temp PGlite database, with a mock OpenVibe.Network and a stand-in for each job board |

## Owns

Its own PostgreSQL tables, created by [migrations/](migrations/) and written by nothing else:

- `work_listings` (0002) — one row per listing, upserted on `(source, source_id)`, with the board's own id, the
  original `url` to link back to, the fields the board gives, and a short plain-text excerpt. Expired listings are
  kept but hidden.
- `work_saved_searches` (0002) — a search a person saved, keyed `subject = user:usr_…`, with when they last looked.
- `work_source_fetches` (0002) — what each board's last fetch did, so `/sources` can say when it last ran and how.
- `account_data_events` (0003) — the receipts of the ADR-033 export and deletion deliveries this service applied, so a
  redelivered event changes nothing.

0001 creates no tables. The service is the authority for these rows and for nothing else.

## Does not own

- **Identity and accounts** — OpenVibe.Network: sign-in (OAuth client `work`, PKCE S256), the signing keys (JWKS) and
  the canonical subject. Work holds only `user:usr_…` on its own rows.
- **Event delivery** — OpenVibe.Events: Work receives `network.account.export_requested` and `network.account.deleted`
  and creates its two subscriptions at boot; it does not own the topics or the delivery.
- **The listings themselves** — the boards (Arbeitnow, Remotive, RemoteOK): Work keeps a short excerpt and a link back,
  never the full description, and reads each board only on the terms it publishes.

## Depends on

- **OpenVibe.Network** — SSO sign-in and JWKS verification, and the internal routes an export part or a deletion
  confirmation is pushed to (`OV_NETWORK_URL`, `OV_NETWORK_INTERNAL_URL`, `OV_OAUTH_CLIENT_ID`,
  `OV_OAUTH_CLIENT_SECRET`, `OV_NETWORK_ISSUER`, `OV_SESSION_AUDIENCE`, `WORK_AUDIENCE`).
- **OpenVibe.Events** — the two account subscriptions created at boot and the delivery posted to this service's
  loopback `/internal/events` (`WORK_EVENTS_URL` or `EVENTS_URL`, `WORK_EVENTS_SECRET`, `WORK_EVENTS_ENDPOINT`,
  `WORK_EVENTS_SUBSCRIBE`).
- **The three job boards** — the only hosts the ingest fetches: Arbeitnow, Remotive and RemoteOK's public APIs
  (`WORK_ARBEITNOW_URL`, `WORK_REMOTIVE_URL`, `WORK_REMOTEOK_URL`, `WORK_USER_AGENT`).
- **PostgreSQL** (`DATABASE_URL`, `DATABASE_DIRECT_URL`; an embedded PGlite database in development via
  `WORK_PGLITE_DIR`) and **Valkey** for shared limit counters (`VALKEY_URL`, `VALKEY_PREFIX`).
- **Packages**: `openvibe-contracts` v0.122.1, `openvibe-sdk` v0.37.2 (`db`, `auth`, `account-data`, `limits`,
  `valkey`, `service`) and `openvibe-shared` v2.21.0 (`frame`, `legal`, `serve`, `release`, `metrics`, `ready`,
  `seo`, `shell`, `cache-policy`, `showcase`, `app-icon`).

## Capabilities

The service manifest (`work`, openvibe-contracts) lists none, and [server/http/principal.js](server/http/principal.js)
declares none either (`CAPABILITIES` is empty): no route names a capability, so an app, agent or service token cannot
call the person-only saved-search routes (403) and the public reads need no token. Work calls no capability on another
service.

It does use two machine-to-machine surfaces: OpenVibe.Events' subscription API (scope `events.subscription.manage`)
to create its two account-event subscriptions at boot ([server/events-consumer.js](server/events-consumer.js)), and
OpenVibe.Network's internal account export/deletion routes, pushed with this service's own client-credentials token
([server/identity/account-data.js](server/identity/account-data.js)).

## API

| Route | Who | |
|---|---|---|
| `GET /api/v1/ping` | anyone | `{ ok: true, service: "work" }` |
| `GET /api/v1/jobs` | anyone | Search: `q`, `remote`, `type`, `location`, `limit` (to 100), `cursor` (the `next` of the previous page). Newest first, 30 a page, with facets |
| `GET /api/v1/jobs/:id` | anyone | One listing: the board's fields, the excerpt, the source, and `url` — the original to apply on |
| `GET /api/v1/sources` | anyone | The boards, each one's terms as applied, its listing count and its last fetch |
| `GET /api/v1/saved-searches` | a person | Your saved searches, each with `new_count` — new since you last looked |
| `POST /api/v1/saved-searches` | a person | `{ q?, remote?, type?, location? }` (at least one). 201 with the saved search |
| `DELETE /api/v1/saved-searches/:id` | a person | Forget one. 204 |

**Who can call it:** reading the listings is public. A saved search belongs to a person, so those three routes need a
signed-in person — their Network token as a Bearer, or this site's session — and answer 401 otherwise. An app or agent
token cannot hold one (403): a saved search is not a project's. A write made with the session cookie must come from
`openvibe.work` itself (`request.cross_site` otherwise).

**Errors** are RFC 9457 `application/problem+json` with a stable `code` (`work.jobs.not_found`,
`work.saved_searches.empty`, `work.saved_searches.limit`, `rate_limited`, …).

## Data sources and their terms

Each board is read through its own public API, and its terms are applied on every page that shows one of its listings
— they are also served by `GET /api/v1/sources` and written out on [/sources](server/http/pages.js).

| Source | API | Terms, as applied here |
|---|---|---|
| **Arbeitnow** | `GET https://www.arbeitnow.com/api/job-board-api?page=N` | Free to use. Arbeitnow is named on every listing and the listing links to its page on arbeitnow.com. Its first pages (configurable) are read. |
| **Remotive** | `GET https://remotive.com/api/remote-jobs?limit=100` | Remotive must be named as the source and the listing linked. The API is called about four times a day — the six-hour interval is exactly that. |
| **RemoteOK** | `GET https://remoteok.com/api` | RemoteOK must be named as the source and the listing linked. The response's first element is a legal notice, not a listing, and is skipped. |

What is stored per listing: `source`, the board's own id, the original `url`, title, company, location, the remote
flag, tags, job type, salary text when the board gives one, when it was posted, when we fetched it, when it was first
seen and last seen, and a **short plain-text excerpt** — never the full description. The listing page says *"Read the
full listing on &lt;source&gt;"* and links there; that is where a reader applies.

Listings are upserted on `(source, source_id)` and **expire** — hidden from the search, the pages and the sitemap —
when no board has shown one for 30 days. An ingest never invents a listing: one without a title, a company, an id or
an http(s) URL to link back to is refused.

## Configuration

See [.env.example](.env.example). Required in production: `OV_OAUTH_CLIENT_SECRET` (the `work` OAuth client on the
Network), `BASE_URL`, `DATABASE_URL` and `DATABASE_DIRECT_URL`. The database is the only required readiness check; the
Network signing key, the OAuth client and Valkey are optional (the service says so, per check, on `/api/ready`).

The ingest is **off** unless `WORK_INGEST=on`, so a development run and the test suite never call a job board. When it
is on, `WORK_INGEST_INTERVAL_HOURS` (6), `WORK_INGEST_PAGES` (3), `WORK_INGEST_LIMIT` (100), `WORK_INGEST_TIMEOUT_MS`
(15000), `WORK_RETENTION_DAYS` (30) and the per-source base URLs (`WORK_ARBEITNOW_URL`, `WORK_REMOTIVE_URL`,
`WORK_REMOTEOK_URL`) decide what it does.

## Development

```bash
npm install
fnm exec --using=22 npm test        # every test/*.test.js, on temp PGlite databases with a mock Network and stand-in boards
fnm exec --using=22 npm run dev     # http://localhost:4960 (no ingest unless WORK_INGEST=on)
fnm exec --using=22 npm run ingest  # read every board once, then exit
```

Without `DATABASE_URL` development uses an embedded PGlite database in `data/pglite` (one process only). `npm run
test:pg` runs the same suite through PostgreSQL and PgBouncer (see [.github/workflows/ci.yml](.github/workflows/ci.yml)).

## Acceptance

`npm test` runs every `test/*.test.js` in its own process on a temp PGlite database with a mock OpenVibe.Network and a
stand-in for each job board ([test/helpers/boards.js](test/helpers/boards.js)); `npm run test:pg` runs the same suite
through PostgreSQL and PgBouncer. No test reaches the internet. The main files:

- [test/ingest.test.js](test/ingest.test.js) — the three stand-in boards end to end: what is kept and what is refused,
  a re-read updating rather than duplicating, a failing board recorded without stopping the others, the
  ~300-character excerpt only, and expiry after the retention window.
- [test/jobs.test.js](test/jobs.test.js) — search, filters, facets and the cursor, one listing with its provenance and
  JSON-LD, escaping of a hostile title, and the discovery files that carry the listings and the sources.
- [test/saved.test.js](test/saved.test.js) — a saved search belongs to a person: anonymous is 401, an app token is
  403, a signed-in write from another site is refused, and nobody sees anybody else's.
- [test/account-data.test.js](test/account-data.test.js) — ADR-033 export and deletion through `/internal/events` with
  a stand-in Network: only that person's rows, applied once, a bad signature and a forwarded request refused.
- [test/auth-ops.test.js](test/auth-ops.test.js) — PKCE sign-in, truthful readiness, `/release.json`, loopback-only
  `/metrics` and pages useful without JavaScript.
- [test/auth-jwks.test.js](test/auth-jwks.test.js) — the Network signing key fetched and verified, an outage survived
  on cached keys, and a rotation honoured.
- [test/caller-limits.test.js](test/caller-limits.test.js) — per-caller limits, the 429 `rate_limited` before any
  work, and the product's own route budgets.
- and the rest: [test/security-session.test.js](test/security-session.test.js),
  [test/security-secrets.test.js](test/security-secrets.test.js), [test/discovery.test.js](test/discovery.test.js),
  [test/layout.test.js](test/layout.test.js), [test/open-redirect.test.js](test/open-redirect.test.js),
  [test/no-internal-key.test.js](test/no-internal-key.test.js),
  [test/nginx-auth-limit.test.js](test/nginx-auth-limit.test.js),
  [test/asset-cache.test.js](test/asset-cache.test.js), [test/perf-budget.test.js](test/perf-budget.test.js),
  [test/service-kit.test.js](test/service-kit.test.js).

## Deploy (for the lead)

- **Deploy:** `sudo ovhost deploy work` on the host (git checkout at `/opt/openvibe.work`, unit
  `openvibe-work.service` on 127.0.0.1:4960, env `/etc/openvibe/work.env`, database `ov_work` on the data role).
  Set `WORK_INGEST=on` in `/etc/openvibe/work.env` or no listing will ever arrive.
- **nginx:** [deploy/nginx/openvibe.work.conf](deploy/nginx/openvibe.work.conf), installed with `ov-vhost-install`.
- **Rollback:** ovhost puts the previous sha back by itself when `/api/ready` does not answer after the restart.
- Register the service and its capabilities in **OpenVibe.Contracts** (`contracts-service: work` in CI) and with
  **OpenVibe.Services** before the first deploy.

## Account export and deletion

A person's account at OpenVibe.Network can be exported and deleted, and every service holding their rows answers its
part (ADR-033). Work receives `network.account.export_requested` and `network.account.deleted` at `POST /internal/events`
(loopback only) — the one table is mapped in [server/identity/account-data.js](server/identity/account-data.js), and the
boot-time subscriptions are created by [server/events-consumer.js](server/events-consumer.js):

- **Exported:** the searches a person saved (`saved_searches.json`), pushed to
  `POST /internal/account-exports/:id/parts` with this service's own token. Nothing here is a secret — Work stores no
  token, key or credential.
- **Erased:** a saved search is the person's own and nothing anyone else's page hangs under it, so it is deleted whole
  and nothing is kept. Work then confirms with `POST /internal/account-deletions/:id/confirmations` and the counts.
- **Anonymized:** nothing. There is no row Work keeps that was written by this person for another person to read.

The listings (`work_listings`) and the per-source fetch record (`work_source_fetches`) hold no person's rows: neither
has a subject column, so neither is exported nor erased.

Environment: `WORK_EVENTS_SECRET` (comma-separated for rotation, 32+ characters each; unset makes the route answer
503), `WORK_EVENTS_URL` (or `EVENTS_URL`) is where the two subscriptions are created at boot (off when unset), and
`WORK_EVENTS_ENDPOINT` overrides the loopback endpoint; `WORK_EVENTS_SUBSCRIBE=0` turns the boot-time subscription off.

## Security (threat notes)

Reporting a vulnerability: [SECURITY.md](SECURITY.md).

- Session tokens are httpOnly cookies; a FedCM assertion or an app or service token is never a session.
- Secrets live only in the env file; only environment variable names appear in code and docs, and no secret is logged.
- Request bodies are never logged.
- Nothing in a request may decide a URL this service fetches: the ingest fetches only the three base URLs from the
  configuration, with this service's User-Agent, a timeout and a size cap, and stores only http(s) listing URLs.
- A board's text is data, never markup: every value goes through the `html` tagged template, and a listing URL that
  is not http(s) is refused rather than linked.

## Not yet

- **The agent**: drafting, tailoring and tracking an application, with the person's approval at each step.
- **Alerts**: being told when a listing that fits appears — that comes through OpenVibe.Watch with the agent pillar.
  Today a saved search is a search you do not have to type again, plus a count of what is new.
- More boards, and a per-source schedule finer than "the same six hours for everyone".

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).

<!-- versions:start -->
- openvibe-contracts: v0.128.0
- openvibe-sdk: v0.37.2
- openvibe-shared: v2.21.0
- openvibe-publishing: v1.4.0
<!-- versions:end -->
