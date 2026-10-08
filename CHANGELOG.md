# Changelog

What changed in OpenVibe.Work, newest first. Each site also publishes its patch notes at /updates.

## 0.2.0 — 2026-10-08

**Job listings, searchable, with their provenance — and saved searches.**

- **Listings, gathered from open boards.** A background ingest reads Arbeitnow, Remotive and RemoteOK through their
  public APIs (server/jobs/sources.js, server/ingest/). Each board's terms are applied as written: the source is named
  and the original listing is linked on every page that shows it, and only a short plain-text excerpt is stored — never
  the full description. Every listing keeps the board's own id and URL, and a listing without both a title, a company,
  an id and an http(s) link back is refused rather than published. The ingest is off unless `WORK_INGEST=on`, calls a
  source at most every six hours (exactly the four a day Remotive's terms allow), upserts on `(source, source_id)`, and
  expires a listing no board has shown for 30 days.
- **Search** at `/jobs` (`q`, `remote`, `type`, `location`), newest first, 30 a page with a cursor, with facets for
  remote and job type. One listing at `/jobs/:id`, with a schema.org `JobPosting` whose `url` is the original.
- **Saved searches** for a signed-in person: save the search you are looking at, and `/saved` shows each one with the
  count of listings that appeared since you last looked (opening the page is what clears it).
- **The API** at `/api/v1`: `GET /jobs`, `GET /jobs/:id`, `GET /sources` (each board's terms as applied and its last
  fetch), and `POST`/`GET`/`DELETE /saved-searches`. Reading is public; a saved search is a person's.
- **Pages**: a home page with the search box, the latest remote listings and each source with its count; `/sources`,
  which states each board's terms as applied; and `/docs` for the API. A sitemap carrying the newest listings, and
  `llms.txt` pointing a crawler at the listings and the sources.
- **Limits**: the search and the saved-search writes have per-caller budgets of their own
  (`work.jobs.search`, `work.saved_searches.write`).
- **New tables**: `work_listings`, `work_saved_searches`, `work_source_fetches` (`migrations/0002_listings.sql`).
- **New tools**: `npm run ingest` reads every board once and exits.
- Also: `test/skeleton.test.js` now skips itself in a generated service (this repository, whose skeleton placeholders
  were already rewritten), saying so, rather than asserting against a rewrite that can no longer happen.

## 0.1.0 — 2026-10-08

- **First release:** the service starts from the OpenVibe skeleton — sign-in with OpenVibe.Network (OAuth 2 + PKCE), server-rendered pages through the OpenVibe Frame, the `/api/v1` mount with per-caller limits, crawl artifacts, PostgreSQL migrations, the deploy files and the test suite.
