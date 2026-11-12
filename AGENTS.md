# AGENTS.md — OpenVibe.Work

## Project overview

OpenVibe.Work (`https://openvibe.work`) is the network's job-listings service: it gathers listings from
public job boards, keeps provenance and a short plain-text excerpt, makes them searchable without an
account, and lets a signed-in person save searches, track applications and ask their OpenVibe.Actor
agent for help preparing one. It does not republish a board's listing: every listing links back to the
board, where the reader applies.

- **Entry:** `server/index.js`; app `server/app.js`; port `4960`, service id `work`, env prefix `WORK`.
- **API/pages:** `server/http/` — `api.js` (`/api/v1`), `pages.js`, `discovery.js`, `principal.js`,
  `caller-limits.js`, `router.js`; rendering `server/render/` (`listing.js`, `markdown.js`,
  `layout.js`, `html.js`, `short.js`); CSS in `public/css`.
- **Ingest:** `server/ingest/` (`index.js`, `from-sources.js`) and `server/jobs/` (`sources.js`,
  `store.js`, `text.js`, `hiring-line.js`, `job-types.js`, `places.js`, `companies.js`,
  `rederive-hn-titles.js`); run it with `npm run ingest` or the in-process interval.
- **Sources:** Arbeitnow, Remotive, RemoteOK and Hacker News "Who is hiring", each through its own
  public API and each with its terms applied on every page (`/sources`, `GET /api/v1/sources`);
  Arbeitnow can instead be read from OpenVibe.Sources (`WORK_ARBEITNOW_FROM=sources`).
- **Docs/config:** README "Data sources and their terms", `SECURITY.md`, `.env.example`.

## Owns, does not own

Owns its PostgreSQL tables and nothing else: `work_listings` (upserted on `(source, source_id)`, the
board's id, original `url`, its fields, a short plain-text excerpt; expired listings kept but hidden),
`work_saved_searches` (`subject = user:usr_…`, last looked), `work_source_fetches`,
`work_applications` (`subject_id`, status/notes/dates/next step/last Actor task, one per person per
listing), `work_application_events` (append-only history), `account_data_events` and
`work_ingest_cursor`.

Does not own: identity/accounts (Network — OAuth client `work`, PKCE S256, JWKS, canonical subject);
event delivery (Events — Work creates its two account subscriptions at boot); the listings themselves
(the boards; Work keeps an excerpt and a link back, and reads each board only on its terms).

## Who calls it, what it calls

Anyone can search and read the public API (`/api/v1/ping`, `/jobs`, `/jobs/:id`, `/sources`) and the
Atom feed (`/jobs.atom`); a signed-in person uses Network SSO for saved searches, applications and the
Actor assist. SDK `openvibe-sdk/work` is the public client (`jobs.search`, `jobs.get`, `sources`, and
the person's `savedSearches`/`applications`). Work calls Network (SSO/JWKS), Events (subscriptions and
the outbox), the board APIs (only configured base URLs, this service's User-Agent, a timeout and a size
cap, storing only http(s) listing URLs) and OpenVibe.Actor (help prepare an application from the
person's own agent). "Get alerts" hands a saved search to OpenVibe.Watch's feed form; Watch owns the
watching.

## Database and migrations

PostgreSQL `ov_work` through `openvibe-sdk/db` (PgBouncer for the app, direct owner role for
migrations): `0001` creates nothing, `0002` listings/saved searches/fetches, `0003` account data,
`0004` the search index, `0005` applications, plus telemetry, ingest cursor, company slug index, config
and the outbox rejection index. Applied at boot; never edit a migration that has run. The database is
the only required readiness check; Network/JWKS/Valkey are optional and reported per check.

## Auth and exposure

Session tokens are httpOnly cookies; a FedCM assertion or an app/service token is never a session.
Public pages/API are anonymous and cacheable; saved searches and applications are the person's own
(`user:usr_…`), and an application is one per person per listing. `/internal/events` is signed and
loopback-only; account export/deletion covers saved searches and applications, and a redelivery changes
nothing. Request bodies are never logged; secrets live only in the env file.

## Deploy

`sudo ovhost deploy work`: checkout `/opt/openvibe.work`, unit `openvibe-work.service` on
`127.0.0.1:4960`, env `/etc/openvibe/work.env`, database `ov_work`; nginx
`deploy/nginx/openvibe.work.conf`. **Set `WORK_INGEST=on` in `/etc/openvibe/work.env` or no listing
will ever arrive.** Rollback with `sudo ovhost rollback work --to <sha>`.

## Commands and tests

```bash
npm ci
npm run dev                  # http://127.0.0.1:4960
npm test                     # every test/*.test.js, temp PGlite + mock Network
npm test -- ingest login     # only matching files
npm run test:pg              # the same on PostgreSQL
npm run ingest               # fetch the boards once (needs WORK_INGEST=on)
```

`test/run.js` uses `openvibe-shared/test-runner`; temp PGlite and an in-process Network mock, never the
network. Coverage includes the board adapters and terms, the Hacker News line split/rederive, search
and facets, saved searches, applications and their history, Actor assist, auth/JWKS/limits, discovery,
account data and the pages.

## Conventions and pitfalls

- CommonJS, 4-space indent, single quotes, semicolons; problem+json errors; escaped HTML, and a listing's
  excerpt is plain text (never Markdown/HTML from the board).
- **Never republish a board's listing:** keep a short excerpt and link back to the original; name the
  source and apply its terms on every page. A board that asks to be named or linked must stay named.
- **The ingest only fetches configured base URLs**, never a URL chosen by a request, with this
  service's User-Agent, a timeout and a size cap; only http(s) listing URLs are stored.
- **Ingest is off unless `WORK_INGEST=on`** — a dev/test run must never call a board; the test suite
  runs with it off.
- **A saved search is keyed by the canonical subject**, and "new since you last looked" is computed
  from that row, not from a client-supplied timestamp.
- **One application per person per listing**, with an append-only event history; a status change is a
  new event, not an overwritten field.
- **Work does not watch:** "Get alerts" opens Watch with the Atom feed; only Watch runs the check and
  the action.
