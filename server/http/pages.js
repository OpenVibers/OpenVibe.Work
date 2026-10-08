'use strict';

/**
 * Public pages: the home page, the search (/jobs), one listing (/jobs/:id), the saved searches (/saved), the sources
 * (/sources) and the update log (/updates). Crawl artifacts (robots.txt, sitemap.xml, llms.txt, llms-full.txt,
 * JSON-LD) are http/discovery.js.
 *
 * Every page is server-rendered through openvibe-shared/shell and works without JavaScript: the search is a GET form,
 * saving and deleting a saved search are plain POSTs. What is shown is read, never restated — the listings come from
 * the database, the sources and their terms from server/jobs/sources.js.
 */
const ovServe = require('openvibe-shared/serve');
const frame = require('openvibe-shared/frame');
const showcase = require('openvibe-shared/showcase');
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');
const { createDiscoveryRoutes, homeJsonLd } = require('./discovery');
const { sameOrigin } = require('./principal');
const { html, raw, table, notice, time } = require('../render/html');
const { send } = require('../render/layout');
const listing = require('../render/listing');
const store = require('../jobs/store');
const sources = require('../jobs/sources');

const SITE_NAME = 'OpenVibe.Work';
const TAGLINE = 'Find work, with an agent on your side.';

function createPageRoutes(ctx) {
    const { config, s } = ctx;
    const r = asyncRouter();
    const PUBLIC_CACHE = cache.htmlHeaders({ maxAge: 300 });
    const page = (req, res, o, status = 200) => send(res, status, { viewer: req.viewer, config, path: req.originalUrl, ...o });
    const signedIn = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const subjectOf = (req) => `user:${req.viewer.subject}`;
    const sourceOf = (row) => sources.byId(row.source);

    // ── Search: one form, one set of filters, one place they are read ──
    const filterForm = (filters, { facets = null, action = '/jobs' } = {}) => html`<form class="job-search" method="get" action="${action}" role="search">
<label class="sr-only" for="q">Search listings</label>
<input type="search" id="q" name="q" value="${filters.q}" placeholder="Job title, skill, company" maxlength="120">
<label class="sr-only" for="location">Location</label>
<input type="text" id="location" name="location" value="${filters.location}" placeholder="Location" maxlength="120">
<label class="sr-only" for="remote">Remote</label>
<select id="remote" name="remote">
<option value=""${filters.remote === '' ? raw(' selected') : ''}>Remote or on-site</option>
<option value="true"${filters.remote === 'true' ? raw(' selected') : ''}>Remote only</option>
<option value="false"${filters.remote === 'false' ? raw(' selected') : ''}>On-site only</option>
</select>
<label class="sr-only" for="type">Job type</label>
<input type="text" id="type" name="type" value="${filters.type}" placeholder="Job type" maxlength="60">
<button class="sc-btn sc-primary" type="submit">Search</button>
${(filters.q || filters.remote || filters.type || filters.location) ? html`<a class="job-clear" href="${action}">Clear</a>` : ''}
</form>
${facets ? facetBar(filters, facets, action) : ''}`;

    /** The facets: what is actually in the result set, as links that set one filter and keep the rest. */
    const facetBar = (filters, facets, action) => {
        const link = (patch, label, active, count) => html`<li${active ? raw(' class="on"') : ''}><a href="${withFilters(filters, { ...patch, cursor: null }, action)}">${label}${count == null ? '' : html` <span class="facet-n">${count}</span>`}</a></li>`;
        return html`<div class="job-facets">
<p class="facet-head"><strong>${facets.matches}</strong> listing${facets.matches === 1 ? '' : 's'} match${facets.matches === 1 ? 'es' : ''} this search</p>
<ul class="facets" aria-label="Remote"><li class="facet-label">Workplace</li>
${link({ remote: null }, 'Any', filters.remote === '', null)}
${link({ remote: 'true' }, 'Remote', filters.remote === 'true', facets.remote.true)}
${link({ remote: 'false' }, 'On-site', filters.remote === 'false', facets.remote.false)}
</ul>
${facets.type.length ? html`<ul class="facets" aria-label="Job type"><li class="facet-label">Type</li>
${facets.type.map((t) => link({ type: t.type }, t.type, filters.type === t.type, t.count))}
</ul>` : ''}
</div>`;
    };

    const passFilters = (f) => {
        const out = {};
        if (f.q) out.q = f.q;
        if (f.remote) out.remote = f.remote;
        if (f.type) out.type = f.type;
        if (f.location) out.location = f.location;
        return out;
    };
    /** A URL for one filter patch, over the current query string. Null removes a filter. */
    function withFilters(filters, patch, path) {
        const merged = { ...passFilters(filters), ...patch };
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(merged)) if (v != null && v !== '') params.set(k, String(v));
        const q = params.toString();
        return q ? `${path}?${q}` : path;
    }

    /** Which of the three sources a listing came from, named; the ingest keeps to these and nothing else. */
    const sourceLine = (row) => html`${listing.sourceLink(row, sourceOf(row))}`;

    // ── Home ─────────────────────────────────────────────────
    r.get('/', async (req, res) => {
        const [latest, counts, rows] = await Promise.all([store.listRecent(s, 6, { remote: true }), store.countsBySource(s), store.search(s, {}, { limit: 1 })]);
        const total = rows.facets.matches;
        const fetches = await store.sourceFetches(s);
        const hero = showcase.hero({
            eyebrow: `${SITE_NAME} · job listings with their provenance`,
            title: 'Find work.',
            accent: 'Every listing shows where it came from.',
            lede: `${SITE_NAME} gathers job listings from public job boards, keeps the board's own link on every one, and lets you search them. No paywall, no account needed to look: sign in only to keep a search. An agent that helps you apply comes next.`,
            actions: [{ label: 'Search the listings', href: '#search', primary: true }, { label: 'Where they come from', href: '/sources' }],
            note: 'Open source (AGPL-3.0). Listings are shown with the source named and a link to the original — read the full listing there.',
        });
        page(req, res, {
            index: true, cache: signedIn(req) ? null : PUBLIC_CACHE,
            jsonLd: homeJsonLd(config),
            styles: [showcase.STYLESHEET],
            body: html`${raw(hero)}
<section class="sc-sec" id="search" aria-labelledby="h-search"><h2 id="h-search">Search the listings</h2>
${filterForm({ q: '', remote: '', type: '', location: '' }, { action: '/jobs' })}
<p class="muted">${total} listing${total === 1 ? '' : 's'} from ${sources.SOURCES.length} sources, newest first.</p></section>
<section class="sc-sec" aria-labelledby="h-latest"><h2 id="h-latest">Latest remote jobs</h2>
${listing.listingList(latest, { sourceOf, empty: 'No listings yet — the ingest has not run.' })}
<p><a class="sc-btn" href="/jobs?remote=true">All remote listings</a></p></section>
<section class="sc-sec" aria-labelledby="h-sources"><h2 id="h-sources">Where the listings come from</h2>
<p>Each source below is a public job board read through its own API, under its own terms. Every listing on this site names its source and links to the original; we keep a short excerpt and send you to the board for the rest.</p>
${table(['Source', 'Listings', 'Last read', 'Terms'], sources.SOURCES.map((src) => {
                const f = fetches.get(src.id);
                return [
                    html`<a href="${src.homepage}" rel="noopener">${src.name}</a>`,
                    String((counts.get(src.id) || {}).count || 0),
                    f && f.finished_at ? html`${time(f.finished_at)}${f.ok ? '' : html` <span class="muted small">(the last read failed)</span>`}` : html`<span class="muted">not read yet</span>`,
                    html`${src.attribution} — <a href="/sources#${src.id}">terms as applied</a>`,
                ];
            }))}</section>
${raw(showcase.steps({
                title: 'How it works',
                items: [
                    { title: 'Gathered from open boards', text: 'A background ingest reads each board\'s public API every few hours, keeps the listing\'s own id and URL, and stores a short excerpt — never the full description.' },
                    { title: 'Search it, with the source on it', text: 'Filter by text, workplace, job type and location. Every result names the board it came from and links back to it.' },
                    { title: 'Read it on the board', text: 'The listing page shows the excerpt and sends you to the original listing to read it in full and apply. Nothing is republished.' },
                    { title: 'Keep a search', text: 'Sign in to save a search; /saved shows each one with the count of listings that appeared since you last looked.' },
                    { title: 'Nothing behind a paywall', text: 'Reading and searching is free and needs no account. There is no premium tier on the listings, and listings expire when a board stops showing them.' },
                    { title: 'An agent, next', text: 'The agent that drafts and tracks applications is the next pillar; alerts through OpenVibe.Watch come with it.' },
                ],
            }))}
${raw(showcase.cta({ title: 'Prefer the API?', text: 'The same search, the sources and their terms, and your saved searches over HTTP. Reading is public.', actions: [{ label: 'The API', href: '/docs' }, { label: 'The sources', href: '/sources' }] }))}`,
        });
    });

    // ── Search ───────────────────────────────────────────────
    r.get('/jobs', async (req, res) => {
        const filters = store.filtersOf(req.query);
        const cursor = store.decodeCursor(req.query.cursor);
        // A cursor we did not write is not a position in the result set; start from the top rather than guess.
        const p = await store.search(s, filters, { cursor });
        const nextUrl = p.next ? withFilters(filters, { cursor: store.encodeCursor(p.next) }, '/jobs') : null;
        const described = [filters.q ? `“${filters.q}”` : '', filters.remote === 'true' ? 'remote' : filters.remote === 'false' ? 'on-site' : '', filters.type ? filters.type : '', filters.location ? `in ${filters.location}` : ''].filter(Boolean).join(' ');
        page(req, res, {
            index: true, cache: signedIn(req) ? null : PUBLIC_CACHE,
            title: described ? `Jobs: ${described}` : 'Jobs',
            description: `Job listings from open boards${described ? ` matching ${described}` : ''}, newest first, each with the source it came from and a link to the original listing.`,
            crumbs: [{ label: 'Jobs' }],
            styles: [showcase.STYLESHEET],
            body: html`<h1>Jobs</h1>
${filterForm(filters, { facets: p.facets })}
${listing.listingList(p.rows, { sourceOf, empty: 'No listings match this search. Try fewer words, or clear a filter and search again.' })}
<nav class="job-pager" aria-label="Pages">
${cursor ? html`<a class="sc-btn" href="${withFilters(filters, { cursor: null }, '/jobs')}">First page</a>` : ''}
${nextUrl ? html`<a class="sc-btn sc-primary" href="${nextUrl}">Older listings</a>` : html`<span class="muted">That is every listing matching this search.</span>`}
</nav>
<p class="muted small">Read the full listing on its source: each entry links back to the board it came from.</p>`,
        });
    });

    // ── One listing ──────────────────────────────────────────
    r.get('/jobs/:id', async (req, res) => {
        const row = await store.getListing(s, req.params.id);
        if (!row) {
            return page(req, res, {
                title: 'Listing not found',
                body: html`<h1>Listing not found</h1><p>No listing here with that id. A listing is removed once the board it came from stops showing it, and old links stop working.</p><p><a href="/jobs">Search the listings</a></p>`,
            }, 404);
        }
        const src = sourceOf(row);
        const l = listing.meta(row);
        page(req, res, {
            index: true, cache: PUBLIC_CACHE,
            title: `${l.title} at ${l.company}`,
            description: listing.plainExcerpt(row).slice(0, 300) || `${l.title} at ${l.company}, from ${src.name}.`,
            crumbs: [{ label: 'Jobs', href: '/jobs' }, { label: l.title }],
            styles: [showcase.STYLESHEET],
            jsonLd: [listing.jobPosting(row, { siteUrl: config.baseUrl })],
            body: html`<article class="job">
<h1>${l.title}</h1>
<p class="job-meta"><span class="job-company">${l.company}</span> · <span class="job-location">${l.location || 'Location not given'}</span>${l.remote ? ' · Remote' : ''}${l.job_type ? html` · <span class="job-type">${l.job_type}</span>` : ''}</p>
${l.salary ? html`<p class="job-salary"><strong>Salary:</strong> ${l.salary} <span class="muted small">(as the board gives it)</span></p>` : ''}
${l.tags.length ? html`<ul class="job-tags">${l.tags.map((t) => html`<li>${t}</li>`)}</ul>` : ''}
<section class="job-excerpt-block" aria-labelledby="h-excerpt"><h2 id="h-excerpt">Excerpt</h2>
<p>${l.excerpt}</p>
<p class="muted small">This is a short excerpt only. The full listing stays on the board.</p></section>
<p class="job-apply"><a class="sc-btn sc-primary" href="${l.url}" rel="nofollow noopener external" target="_blank">Read the full listing on ${src.name}</a></p>
<dl class="job-facts">
<dt>Source</dt><dd>${sourceLine(row)} — <a href="/sources#${src.id}">its terms as applied</a></dd>
${l.posted_at ? html`<dt>Posted</dt><dd>${time(l.posted_at)}</dd>` : ''}
<dt>Read from the board</dt><dd>${time(row.fetched_at)}</dd>
<dt>Board's id</dt><dd><code>${row.source_id}</code></dd>
</dl>
<p class="muted small">Found a problem with this listing, or want it gone? It is the board's listing, not ours — the source above is where it lives. In code: <code>GET /api/v1/jobs/${row.id}</code>.</p>
</article>`,
        });
    });

    // ── Saved searches ───────────────────────────────────────
    function savedForm(req, filters, { problem = null } = {}) {
        return html`${problem ? notice(problem, 'warn') : ''}
<form class="saved-form" method="post" action="/saved">
<fieldset><legend>Keep this search</legend>
<label>Words <input type="text" name="q" value="${filters.q}" maxlength="120" placeholder="Job title, skill, company"></label>
<label>Location <input type="text" name="location" value="${filters.location}" maxlength="120"></label>
<label>Job type <input type="text" name="type" value="${filters.type}" maxlength="60"></label>
<label>Workplace <select name="remote">
<option value=""${filters.remote === '' ? raw(' selected') : ''}>Any</option>
<option value="true"${filters.remote === 'true' ? raw(' selected') : ''}>Remote only</option>
<option value="false"${filters.remote === 'false' ? raw(' selected') : ''}>On-site only</option>
</select></label>
<button class="sc-btn sc-primary" type="submit">Save this search</button>
</fieldset>
</form>`;
    }

    const describeSaved = (row) => {
        const bits = [row.query ? `“${row.query}”` : '', row.remote === 'true' ? 'remote' : row.remote === 'false' ? 'on-site' : '', row.type ? row.type : '', row.location ? `in ${row.location}` : ''].filter(Boolean);
        return bits.length ? bits.join(' ') : 'everything';
    };

    r.get('/saved', async (req, res) => {
        if (!signedIn(req)) {
            return page(req, res, {
                title: 'Saved searches',
                body: html`<h1>Saved searches</h1>
<p>Sign in to keep a search and see what has appeared since you last looked. Searching itself needs no account.</p>
<p><a class="sc-btn sc-primary" href="/auth/login?next=%2Fsaved">Sign in with OpenVibe</a> <a class="sc-btn" href="/jobs">Search the listings</a></p>`,
            });
        }
        const subject = subjectOf(req);
        const rows = await store.listSaved(s, subject);
        // The counts are read before last_seen_at moves: opening this page is what "looking" means.
        const withCounts = await Promise.all(rows.map(async (row) => ({ row, count: await store.newCount(s, row) })));
        const now = s.iso();
        for (const row of rows) await store.touchSaved(s, subject, row.id, now);
        const initial = store.filtersOf(req.query);
        page(req, res, {
            title: 'Saved searches', crumbs: [{ label: 'Saved searches' }],
            body: html`<h1>Saved searches</h1>
<p>${rows.length ? html`You are keeping ${rows.length} search${rows.length === 1 ? '' : 'es'}. The count is how many listings appeared since you last opened this page.` : 'You are not keeping any search yet.'}</p>
${withCounts.length ? html`<ul class="saved-list">${withCounts.map(({ row, count }) => html`<li class="saved-item">
<p class="saved-query"><a href="${store.toSavedWire(row).search_path}">${describeSaved(row)}</a> <span class="badge${count ? ' ok' : ''}">${count ? `${count} new` : 'nothing new'}</span></p>
<p class="muted small">Saved ${time(row.created_at)} · last looked ${row.last_seen_at ? time(row.last_seen_at) : 'never'}</p>
<form method="post" action="/saved/${row.id}/delete" class="inline"><button class="sc-btn" type="submit">Forget it</button></form>
</li>`)}</ul>` : ''}
${savedForm(req, initial)}
<p class="muted small">Alerts — being told when a listing that fits appears — come later, through OpenVibe.Watch. For now a saved search is a search you do not have to type again, and a count of what is new.</p>
<p class="muted small">In code: <code>GET /api/v1/saved-searches</code>.</p>`,
        });
    });

    r.post('/saved', require('express').urlencoded({ extended: false, limit: '8kb' }), async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!signedIn(req)) return res.redirect(303, '/auth/login?next=%2Fsaved');
        // A signed-in write must come from this site, as everywhere else in this service.
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('Saving a search must come from openvibe.work itself.');
        const filters = store.filtersOf(req.body || {});
        // A search with nothing in it is the whole board, which is not something worth keeping (the API refuses it
        // too). Say so on the page rather than saving it.
        if (!filters.q && !filters.remote && !filters.type && !filters.location) {
            return page(req, res, {
                title: 'Saved searches', crumbs: [{ label: 'Saved searches' }],
                body: html`<h1>Saved searches</h1>
${notice('Give the search at least one thing to look for — words, a location, a job type or a workplace — or there is nothing to save.', 'warn')}
<p><a href="/saved">Back to your saved searches</a></p>`,
            }, 422);
        }
        const out = await store.createSaved(s, subjectOf(req), filters, { id: s.newId('ssc'), now: s.iso() });
        if (out.error === 'too_many') {
            const rows = await store.listSaved(s, subjectOf(req));
            return page(req, res, { title: 'Saved searches', body: html`<h1>Saved searches</h1>${notice(`You can keep ${store.MAX_SAVED} saved searches. Forget one below, then save this again.`, 'warn')}<p><a href="/saved">Back to your saved searches</a> (${rows.length})</p>` }, 429);
        }
        return res.redirect(303, '/saved');
    });

    r.post('/saved/:id/delete', async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!signedIn(req)) return res.redirect(303, '/auth/login?next=%2Fsaved');
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('Forgetting a search must come from openvibe.work itself.');
        await store.deleteSaved(s, subjectOf(req), req.params.id);
        res.redirect(303, '/saved');
    });

    // ── The sources and their terms ──────────────────────────
    r.get('/sources', async (req, res) => {
        const [fetches, counts] = await Promise.all([store.sourceFetches(s), store.countsBySource(s)]);
        page(req, res, {
            index: true, cache: PUBLIC_CACHE,
            title: 'Sources',
            description: 'The public job boards OpenVibe.Work gathers listings from, the terms each one is used under as applied here, and when each was last read.',
            crumbs: [{ label: 'Sources' }],
            body: html`<h1>Sources</h1>
<p>Every listing here comes from one of these boards, read through its public API. We keep the board's own id and URL for each listing, show a short excerpt, and link to the original on every page that shows it. Nothing is republished, and no board is read more often than its terms allow.</p>
${sources.SOURCES.map((src) => {
                const f = fetches.get(src.id);
                return html`<section class="source-block" id="${src.id}" aria-labelledby="h-${src.id}">
<h2 id="h-${src.id}"><a href="${src.homepage}" rel="noopener">${src.name}</a></h2>
<p class="muted small">${(counts.get(src.id) || {}).count || 0} live listing(s) from this board right now.</p>
<h3>Its terms, as applied here</h3>
<p>${src.terms}</p>
<p class="source-attribution">Every listing from this board is shown as: <strong>${src.attribution}</strong>, linked back to the original. On this site that means:</p>
<ul class="source-links"><li>List and detail pages name ${src.name} and link the listing to the original URL on the board.</li>
<li>The listing page carries a <em>“Read the full listing on ${src.name}”</em> link, and the full description is not stored or shown.</li>
<li>${src.name} listings also carry their source in the JSON-LD on the listing page.</li></ul>
<h3>What each read does</h3>
<dl class="job-facts">
<dt>API</dt><dd><code>${src.requests(config)[0]}</code></dd>
<dt>Last read</dt><dd>${f && f.started_at ? html`${time(f.started_at)}${f.ok ? ' — succeeded' : ' — failed'}${f.error ? html` <span class="muted small">(${f.error})</span>` : ''}` : html`<span class="muted">not read yet</span>`}</dd>
<dt>Reads every</dt><dd>${Math.round(config.ingest.intervalMs / 3_600_000)} hours ${src.id === 'remotive' ? '(its terms allow about four a day)' : ''}</dd>
<dt>Listings kept</dt><dd>${(counts.get(src.id) || {}).count || 0}, retired when the board stops showing one for ${config.ingest.retentionDays} days</dd>
</dl>
</section>`;
            })}
<p class="muted">Machine-readable, with each source's terms and last fetch: <a href="/api/v1/sources"><code>GET /api/v1/sources</code></a>.</p>`,
        });
    });

    // ── The API reference ────────────────────────────────────
    r.get('/docs', (req, res) => {
        const b = config.baseUrl;
        const search = `curl -s '${b}/api/v1/jobs?q=engineer&remote=true'
# → { "jobs": [ { "id": "job_…", "title": "…", "company": "…", "url": "https://…", "source": "remotive", "source_name": "Remotive", "posted_at": "…", "excerpt": "…" } ], "next": null, "facets": { … } }`;
        page(req, res, {
            index: true, cache: PUBLIC_CACHE,
            title: 'API',
            description: 'The OpenVibe.Work API: search the listings, read one with its provenance, list the sources and their terms, and keep saved searches. Reading is public.',
            crumbs: [{ label: 'API' }],
            body: html`<h1>The API</h1>
<p>Everything the site does is this API. Reading is public; a saved search is a person's.</p>
<h2 id="who">Who can call it</h2>
<ul>
<li><strong>Anyone</strong>: <code>GET /api/v1/jobs</code>, <code>GET /api/v1/jobs/:id</code> and <code>GET /api/v1/sources</code> need no token.</li>
<li><strong>A person</strong>: the saved searches need a signed-in person — their Network token as <code>Authorization: Bearer</code>, or this site's sign-in. They belong to that person alone.</li>
</ul>
${table(['Route', 'Who', 'What it does'], [
                [html`<code>GET /api/v1/jobs</code>`, 'public', html`Search: <code>?q=</code>, <code>?remote=true|false</code>, <code>?type=</code>, <code>?location=</code>, <code>?limit=</code> (to ${store.MAX_PAGE}), <code>?cursor=</code> (the <code>next</code> the previous page returned). Newest first, ${store.PAGE_SIZE} a page, with facets for remote and job type.`],
                [html`<code>GET /api/v1/jobs/:id</code>`, 'public', 'One listing: the board\'s fields, the excerpt, the source, and <code>url</code> — the original listing to apply on.'],
                [html`<code>GET /api/v1/sources</code>`, 'public', 'The boards, each one\'s terms as applied, its listing count and when it was last read.'],
                [html`<code>GET /api/v1/saved-searches</code>`, 'person', 'Your saved searches, each with <code>new_count</code> — listings that appeared since you last looked.'],
                [html`<code>POST /api/v1/saved-searches</code>`, 'person', html`Save one: <code>{ q?, remote?, type?, location? }</code>. At least one filter. 201 with the saved search.`],
                [html`<code>DELETE /api/v1/saved-searches/:id</code>`, 'person', 'Forget one. 204.'],
            ])}
${raw(showcase.code({ title: 'Search, then read one', samples: [{ label: 'bash', lang: 'bash', code: search }] }))}
<h2 id="terms">The terms we apply</h2>
<p>Each source is read under its own terms, which are stated on <a href="/sources">/sources</a> and in <code>GET /api/v1/sources</code>: the source is named, the original listing is linked, and only a short excerpt is stored. If you build on this API, carry the attribution and the link back with the listing.</p>
<h2 id="limits">Limits</h2>
<p>Search is limited per caller (per person, per app, else per address); past it the API answers 429 <code>rate_limited</code> with <code>Retry-After</code>. Errors are RFC 9457 <code>application/problem+json</code> with a stable <code>code</code>.</p>`,
        });
    });

    // ── The update log ───────────────────────────────────────
    r.get('/updates', (req, res) => page(req, res, {
        index: true, cache: PUBLIC_CACHE,
        title: `What shipped on ${SITE_NAME}`,
        body: raw(frame.updatesBody({ service: 'work', siteName: SITE_NAME }) + `<script src="${ovServe.url('shipped.js')}" defer></script>`),
    }));

    // ── Discovery: robots.txt, sitemap.xml, llms.txt, llms-full.txt ──
    r.use(createDiscoveryRoutes(ctx));
    return r;
}

module.exports = { createPageRoutes, SITE_NAME, TAGLINE };
