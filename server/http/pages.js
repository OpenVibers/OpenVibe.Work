'use strict';

/**
 * Public pages: the home page, the search (/jobs), one listing (/jobs/:id), companies (/companies, /companies/:slug),
 * the saved searches (/saved), the sources
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
const kit = require('openvibe-shared/kit');
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');
const { createDiscoveryRoutes, homeJsonLd } = require('./discovery');
const { sameOrigin } = require('./principal');
const { html, raw, table, notice, time } = require('../render/html');
const { foldBlock, pickBlock, pickRules } = require('../render/short');
const { send } = require('../render/layout');
const listing = require('../render/listing');
const store = require('../jobs/store');
const jobTypes = require('../jobs/job-types');
const companies = require('../jobs/companies');
const sources = require('../jobs/sources');
const applications = require('../applications');
const seo = require('openvibe-shared/seo');
const { products } = require('openvibe-contracts');

const SITE_NAME = 'OpenVibe.Work';
const TAGLINE = 'Find work on open job boards.';
const STATUS_ORDER = ['saved', 'applied', 'interviewing', 'offer', 'rejected', 'withdrawn'];
const STATUS_LABEL = { saved: 'Saved', applied: 'Applied', interviewing: 'Interviewing', offer: 'Offer', rejected: 'Rejected', withdrawn: 'Withdrawn' };

function createPageRoutes(ctx) {
    const { config, s } = ctx;
    const r = asyncRouter();
    const PUBLIC_CACHE = cache.htmlHeaders({ maxAge: 300 });
    const page = (req, res, o, status = 200) => send(res, status, { viewer: req.viewer, config, path: req.originalUrl, ...o });
    const signedIn = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const subjectOf = (req) => `user:${req.viewer.subject}`;
    const sourceOf = (row) => sources.byId(row.source);

    /**
     * Our own disclosure rate, measured from the listings we fetched: how many of the last N carried a salary. N
     * comes from configuration (WORK_DISCLOSURE_SAMPLE) and both counts are the database's own, so the line on the
     * page is never a number typed in by hand.
     */
    const disclosureLine = (d) => {
        if (!d || !d.total) return 'No listing has been fetched yet, so we cannot say what share of them state a salary.';
        const pct = Math.round((d.salaried / d.total) * 100);
        return `Of the last ${d.total} listing${d.total === 1 ? '' : 's'} we fetched, ${d.salaried} included a salary (${pct}%).`;
    };

    // ── Search: one form, one set of filters, one place they are read ──
    const filterForm = (filters, { facets = null, disclosure = null, action = '/jobs' } = {}) => html`<form class="job-search" method="get" action="${action}" role="search">
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
${facets ? facetBar(filters, facets, action, disclosure) : ''}`;

    /** The facets: what is actually in the result set, as links that set one filter and keep the rest. */
    const facetBar = (filters, facets, action, disclosure = null) => {
        const link = (patch, label, active, count) => html`<li${active ? raw(' class="on"') : ''}><a href="${withFilters(filters, { ...patch, cursor: null }, action)}">${label}${count == null ? '' : html` <span class="facet-n">${count}</span>`}</a></li>`;
        return html`<div class="job-facets">
<p class="facet-head"><strong>${facets.matches}</strong> listing${facets.matches === 1 ? '' : 's'} match${facets.matches === 1 ? 'es' : ''} this search${disclosure ? html` <span class="muted">· ${disclosureLine(disclosure)}</span>` : ''}</p>
<ul class="facets" aria-label="Remote"><li class="facet-label">Workplace</li>
${link({ remote: null }, 'Any', filters.remote === '', null)}
${link({ remote: 'true' }, 'Remote', filters.remote === 'true', facets.remote.true)}
${link({ remote: 'false' }, 'On-site', filters.remote === 'false', facets.remote.false)}
</ul>
${facets.type.length ? html`<ul class="facets" aria-label="Job type"><li class="facet-label">Type</li>
${facets.type.map((t) => link({ type: t.type }, t.label, filters.type === t.type, t.count))}
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

    /** A status's badge and its name, in the one place the pages spell them. */
    const statusBadge = (st) => html`<span class="badge${st === 'offer' ? ' ok' : st === 'rejected' || st === 'withdrawn' ? ' bad' : ''}">${STATUS_LABEL[st] || st}</span>`;
    /** An ISO instant as the YYYY-MM-DD an <input type="date"> wants ('' when there is none). */
    const dateInputValue = (iso) => (iso && typeof iso === 'string' ? iso.slice(0, 10) : '');
    /** An <input type="date"> value back to an ISO instant, or null to clear. */
    const dateFromForm = (v) => {
        if (!v) return null;
        const s = String(v).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
        const d = new Date(`${s}T00:00:00Z`);
        return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
    };

    // ── Home ─────────────────────────────────────────────────
    // Everything here is read from the live listings: the counts, the tags and places most listings carry, the
    // companies with the most openings, the newest remote jobs and the newest that state the pay. A block with nothing
    // to show is left out.
    const FAQ = ((products.get('openvibe.work') || {}).faq || []);
    const n = (v) => Number(v || 0).toLocaleString('en-US');
    const sentence = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);
    r.get('/', async (req, res) => {
        const [latest, counts, sum, salaried] = await Promise.all([store.listRecent(s, 6, { remote: true }), store.countsBySource(s), store.homeSummary(s), store.listSalaried(s, 4)]);
        const fetches = await store.sourceFetches(s);
        const total = sum.total;
        const base = String(config.baseUrl).replace(/\/+$/, '');
        const hero = showcase.hero({
            eyebrow: `${SITE_NAME} · ${TAGLINE}`,
            title: 'Find work.',
            accent: 'Every listing shows where it came from.',
            lede: `${SITE_NAME} gathers job listings from public job boards, keeps the board's own link on every one, and lets you search them. No paywall, no account needed to look. Sign in to keep searches, get alerts, track the jobs you apply to, and have your OpenVibe.Actor agent help prepare each application.`,
            // Two, so they sit side by side on a phone; where the listings come from is a section below.
            actions: [{ label: 'Search the listings', href: '#search', primary: true }, { label: 'Remote jobs', href: '/jobs?remote=true' }],
            note: 'Open source (AGPL-3.0). Listings are shown with the source named and a link to the original — read the full listing there.',
        });
        const stats = [
            { value: total, label: total === 1 ? 'open listing' : 'open listings', href: '/jobs' },
            { value: sum.day, label: 'new in the last day', href: '/jobs' },
            { value: sum.week, label: 'new this week', href: '/jobs' },
            { value: sum.companies, label: 'companies hiring', href: '#h-hiring' },
            { value: sum.remote, label: 'remote listings', href: '/jobs?remote=true' },
            { value: sources.SOURCES.length, label: 'job boards read', href: '/sources' },
        ].filter((x) => x.value);
        // The sections below the search, as the panes of one block: on a phone a row of chips picks one at a time, so
        // the home stays short (the owner's short-pages rule, 2026-10-30). Radio inputs and :has(), no script, and
        // every section stays in the page for the crawlers; a wider screen shows them all and no chips. The order is
        // the one the page had, and the newest listings are the one a phone shows first.
        const panes = [];
        if (sum.tags.length) panes.push({ id: 'fields', label: 'Fields', html: String(html`<section class="sc-sec" aria-labelledby="h-fields"><h2 id="h-fields">Browse by field</h2>
<p class="sc-lede">The labels the boards put on most listings right now. Each opens a search for it.</p>
<ul class="home-cards short">${sum.tags.map((t) => html`<li><a href="/jobs?${new URLSearchParams({ q: t.tag })}"><b>${sentence(t.tag)}</b><span>${n(t.count)} listing${t.count === 1 ? '' : 's'}</span></a></li>`)}</ul></section>`) });
        if (sum.places.length) panes.push({ id: 'cities', label: 'Cities', html: String(html`<section class="sc-sec" aria-labelledby="h-places"><h2 id="h-places">Jobs by city</h2>
<p class="sc-lede">The places most listings name. Remote jobs are <a href="/jobs?remote=true">their own search</a>.</p>
<ul class="home-chips">${sum.places.map((p) => html`<li><a href="/jobs?${new URLSearchParams({ location: p.place })}">${p.place} <span>${n(p.count)}</span></a></li>`)}</ul></section>`) });
        panes.push({ id: 'latest', label: 'Latest', html: String(html`<section class="sc-sec home-row" aria-labelledby="h-latest"><h2 id="h-latest">Latest remote jobs</h2>
${listing.listingList(latest, { sourceOf, empty: 'No listings yet — the ingest has not run.' })}
<p><a class="sc-btn" href="/jobs?remote=true">All remote listings</a></p></section>`) });
        if (salaried.length) panes.push({ id: 'pay', label: 'Pay', html: String(html`<section class="sc-sec home-row" aria-labelledby="h-pay"><h2 id="h-pay">Newest jobs that state the pay</h2>
<p class="sc-lede">${n(sum.salaried)} listing${sum.salaried === 1 ? '' : 's'} say what the job pays, in the board's own words.</p>
${listing.listingList(salaried, { sourceOf, empty: '' })}</section>`) });
        if (sum.hiring.length) panes.push({ id: 'companies', label: 'Companies', html: String(html`<section class="sc-sec" aria-labelledby="h-hiring"><h2 id="h-hiring">Companies with the most openings</h2>
<p class="sc-lede">Counted across every board. Each opens the company's page: its openings, where they are and which boards list them.</p>
<ul class="home-cards short">${sum.hiring.map((c) => { const slug = companies.slugOf(c.company); return html`<li><a href="${slug ? `/companies/${slug}` : `/jobs?${new URLSearchParams({ q: c.company })}`}"><b>${c.company}</b><span>${n(c.count)} open listing${c.count === 1 ? '' : 's'}</span></a></li>`; })}</ul>
<p><a href="/companies">Every company hiring</a></p></section>`) });
        page(req, res, {
            index: true, cache: signedIn(req) ? null : PUBLIC_CACHE,
            title: 'Jobs from open job boards, with sources',
            description: `Search ${total ? `${n(total)} ` : ''}jobs from open job boards, each with its source and date, plus saved searches, alerts through OpenVibe.Watch and an application tracker.`,
            jsonLd: [
                ...homeJsonLd(config),
                latest.length ? seo.jsonLd.itemList('Latest remote jobs on OpenVibe.Work', latest.map((row) => ({ name: row.title, url: `${base}/jobs/${row.id}` })), { url: `${base}/jobs?remote=true` }) : null,
                FAQ.length ? seo.jsonLd.faq(FAQ.map((f) => ({ q: f.question, a: f.answer }))) : null,
            ],
            styles: [showcase.STYLESHEET], localStyles: ['css/home.css'],
            // The rule that shows the picked section of the browse block is written for the page, because there is one
            // per section (CSS cannot pair a radio with a pane by index).
            inlineStyles: ['@supports selector(:has(*)){@media (max-width:640px){' + pickRules('browse', panes.map((p) => p.id)) + '}}'],
            body: html`${raw(hero)}
${stats.length ? html`<ul class="home-stats" aria-label="${SITE_NAME} in numbers">${stats.map((x) => html`<li><a href="${x.href}"><b>${n(x.value)}</b><span>${x.label}</span></a></li>`)}</ul>` : ''}
<section class="sc-sec" id="search" aria-labelledby="h-search"><h2 id="h-search">Search the listings</h2>
${filterForm({ q: '', remote: '', type: '', location: '' }, { action: '/jobs' })}
<p class="muted">${n(total)} listing${total === 1 ? '' : 's'} from ${sources.SOURCES.length} job boards, newest first.${sum.day ? ` ${n(sum.day)} arrived in the last day.` : ''}</p></section>
${raw(pickBlock({ key: 'browse', label: 'Browse the listings', head: 'Browse the listings', panes, checked: 'latest' }))}
<section class="sc-sec" aria-labelledby="h-sources"><details class="home-fold"><summary><h2 id="h-sources">Where the listings come from</h2><span>${sources.SOURCES.length} public boards, how it works</span></summary><div class="home-fold-body">
<p>Each source below is a public job board read through its own API, under its own terms. Every listing on this site names its source and links to the original; we keep a short excerpt and send you to the board for the rest.</p>
${table(['Source', 'Listings', 'Last read', 'Terms'], sources.SOURCES.map((src) => {
                const f = fetches.get(src.id);
                return [
                    html`<a href="${src.homepage}" rel="noopener">${src.name}</a>`,
                    n((counts.get(src.id) || {}).count || 0),
                    f && f.finished_at ? html`${time(f.finished_at)}${f.ok ? '' : html` <span class="muted small">(the last read failed)</span>`}` : html`<span class="muted">not read yet</span>`,
                    html`${src.attribution} — <a href="/sources#${src.id}">terms as applied</a>`,
                ];
            }))}</div>
${raw(showcase.steps({
                title: 'How it works',
                items: [
                    { title: 'Gathered from open boards', text: 'A background ingest reads each board\'s public API every few hours, keeps the listing\'s own id and URL, and stores a short excerpt — never the full description.' },
                    { title: 'Search it, with the source on it', text: 'Filter by text, workplace, job type and location. Every result names the board it came from and links back to it.' },
                    { title: 'Read it on the board', text: 'The listing page shows the excerpt and sends you to the original listing to read it in full and apply. Nothing is republished.' },
                    { title: 'Keep a search, get alerts', text: 'Sign in to save a search and see what is new since you last looked, or follow any search through OpenVibe.Watch.' },
                    { title: 'Nothing behind a paywall', text: 'Reading and searching is free and needs no account. There is no premium tier on the listings, and listings expire when a board stops showing them.' },
                    { title: 'Track your applications', text: 'Sign in and press Track this job on a listing: keep your status, notes and next steps in one place, and ask your OpenVibe.Actor agent to help prepare each application.' },
                ],
            }))}</details></section>
${FAQ.length ? raw(foldBlock({
            id: 'faq',
            bare: true,
            head: '<h2>Questions people ask</h2>',
            html: String(html`<section class="sc-sec" aria-labelledby="h-faq"><h2 id="h-faq">Questions people ask</h2>
<div class="home-faq">${FAQ.map((f) => html`<details><summary>${f.question}</summary><p>${f.answer}</p></details>`)}</div></section>`),
        })) : ''}
${raw(foldBlock({
            id: 'network',
            bare: true,
            head: '<h2>Part of OpenVibe</h2>',
            html: showcase.network({ service: 'work' }),
        }))}`,
        });
    });

    // ── Alerts: a search as an Atom feed, followed by OpenVibe.Watch ──
    const WATCH_NEW = 'https://openvibe.watch/watches/new';
    // A search is described in the same language as the facet: a canonical type is named by its label.
    const typeText = (value) => (value ? (jobTypes.label(jobTypes.canonicalKey(value)) || value) : '');
    const describe = (filters) => [filters.q ? `“${filters.q}”` : '', filters.remote === 'true' ? 'remote' : filters.remote === 'false' ? 'on-site' : '', typeText(filters.type), filters.location ? `in ${filters.location}` : ''].filter(Boolean).join(' ');
    const feedPath = (filters) => withFilters(filters, { cursor: null }, '/jobs.atom');
    /** Watch's new-watch form, filled in to follow one search's feed; the person reviews and creates it on Watch. */
    function alertHref(filters) {
        const described = describe(filters);
        const q = new URLSearchParams({ template: 'feed', url: `${config.baseUrl}${feedPath(filters)}`, name: `Jobs: ${described || 'every new listing'}`.slice(0, 80) });
        return `${WATCH_NEW}?${q}`;
    }
    const xml = (v) => String(v == null ? '' : v).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]))
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
    const isoOf = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

    r.get('/jobs.atom', async (req, res) => {
        const filters = store.filtersOf(req.query);
        const p = await store.search(s, filters, { limit: 25 });
        const described = describe(filters);
        const self = `${config.baseUrl}${feedPath(filters)}`;
        const entries = p.rows.map((row) => {
            const l = listing.meta(row);
            const at = isoOf(l.posted_at) || isoOf(row.fetched_at) || new Date().toISOString();
            const where = [l.location, l.remote ? 'Remote' : '', listing.jobTypeLabel(l.job_type)].filter(Boolean).join(' · ');
            return `<entry><id>${xml(`${config.baseUrl}/jobs/${row.id}`)}</id><title>${xml(`${l.title} at ${l.company}`)}</title>`
                + `<link rel="alternate" type="text/html" href="${xml(`${config.baseUrl}/jobs/${row.id}`)}"/><updated>${at}</updated>`
                + `<author><name>${xml(sourceOf(row).name)}</name></author>`
                + `<summary>${xml([where, listing.plainExcerpt(row).slice(0, 300)].filter(Boolean).join(' — '))}</summary></entry>`;
        });
        const updated = p.rows.length ? (isoOf(listing.meta(p.rows[0]).posted_at) || isoOf(p.rows[0].fetched_at)) : null;
        res.set('Cache-Control', 'public, max-age=300');
        res.type('application/atom+xml; charset=utf-8').send(`<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><id>${xml(self)}</id><title>${xml(`OpenVibe.Work: ${described ? `jobs ${described}` : 'new jobs'}`)}</title>`
            + `<link rel="self" href="${xml(self)}"/><link rel="alternate" type="text/html" href="${xml(`${config.baseUrl}${withFilters(filters, { cursor: null }, '/jobs')}`)}"/>`
            + `<updated>${updated || new Date().toISOString()}</updated><generator>OpenVibe.Work</generator>
${entries.join('\n')}
</feed>
`);
    });

    // ── Search ───────────────────────────────────────────────
    r.get('/jobs', async (req, res) => {
        const filters = store.filtersOf(req.query);
        const cursor = store.decodeCursor(req.query.cursor);
        // A cursor we did not write is not a position in the result set; start from the top rather than guess.
        const [p, disclosure] = await Promise.all([
            store.search(s, filters, { cursor }),
            store.disclosureRate(s, { sample: config.disclosure.sample }),
        ]);
        const nextUrl = p.next ? withFilters(filters, { cursor: store.encodeCursor(p.next) }, '/jobs') : null;
        const described = describe(filters);
        page(req, res, {
            index: true, cache: signedIn(req) ? null : PUBLIC_CACHE,
            feed: { title: described ? `Jobs ${described}` : 'New jobs', href: feedPath(filters) },
            title: described ? `Jobs: ${described}` : 'Jobs',
            description: `Job listings from open boards${described ? ` matching ${described}` : ''}, newest first, each with the source it came from and a link to the original listing.`,
            crumbs: [{ label: 'Jobs' }],
            styles: [showcase.STYLESHEET],
            body: html`<h1>Jobs</h1>
${filterForm(filters, { facets: p.facets, disclosure })}
<p class="job-alert"><a class="sc-btn" href="${alertHref(filters)}">Get alerts for this search</a> <span class="muted small">OpenVibe.Watch follows <a href="${feedPath(filters)}">its feed</a> and tells you when a new listing appears.</span></p>
${listing.listingList(p.rows, { sourceOf, empty: 'No listings match this search. Try fewer words, or clear a filter and search again.' })}
<nav class="job-pager" aria-label="Pages">
${cursor ? html`<a class="sc-btn" href="${withFilters(filters, { cursor: null }, '/jobs')}">First page</a>` : ''}
${nextUrl ? html`<a class="sc-btn sc-primary" href="${nextUrl}">Older listings</a>` : html`<span class="muted">That is every listing matching this search.</span>`}
</nav>
<p class="muted small">Each listing is a short excerpt that links to its board. You apply there; we host no descriptions, CVs or apply buttons.</p>`,
        });
    });

    // ── One listing ──────────────────────────────────────────
    r.get('/jobs/:id', async (req, res) => {
        const row = await store.getListing(s, req.params.id, { includeExpired: true });
        if (!row) {
            return page(req, res, {
                title: 'Listing not found',
                body: html`<h1>Listing not found</h1><p>No listing here with that id. A listing is removed once the board it came from stops showing it, and old links stop working.</p><p><a href="/jobs">Search the listings</a></p>`,
            }, 404);
        }
        const src = sourceOf(row);
        const l = listing.meta(row);
        const jobTypeText = listing.jobTypeLabel(l.job_type);
        const fetchedOn = row.fetched_at ? listing.dateWords(row.fetched_at) : 'a date we did not record';
        // A listing the board stopped showing is out of the search, but the old link still answers: it says the
        // listing is gone and when we last saw it, rather than pretending the row never existed.
        if (row.expired) {
            const lastSeen = row.last_seen_at ? listing.dateWords(row.last_seen_at) : '';
            return page(req, res, {
                title: 'No longer on the board',
                description: `This listing is no longer on ${src.name}. We last saw it on ${lastSeen || 'a date we did not record'}.`,
                crumbs: [{ label: 'Jobs', href: '/jobs' }, { label: 'No longer on the board' }],
                styles: [showcase.STYLESHEET],
                body: html`<h1>No longer on the board</h1>
<p class="job-gone"><span class="badge bad">Gone</span> This listing is no longer on the board.${lastSeen ? html` Last seen on ${src.name} on ${lastSeen}.` : ' We did not record the day we last saw it.'}</p>
<p>${l.title} at ${l.company} is not in our listings any more, so it is not in the search either. The board's own listing is still <a href="${l.url}" rel="nofollow noopener external" target="_blank">here</a>, but the board may have taken it down.</p>
<p><a class="sc-btn" href="/jobs">Search the listings</a></p>`,
            }, 404);
        }
        const tracked = signedIn(req) ? await applications.applicationByListing(s, subjectOf(req), row.id) : null;
        page(req, res, {
            index: true, cache: PUBLIC_CACHE,
            title: `${l.title} at ${l.company}`,
            description: listing.plainExcerpt(row).slice(0, 300) || `${l.title} at ${l.company}, from ${src.name}.`,
            crumbs: [{ label: 'Jobs', href: '/jobs' }, { label: l.title }],
            styles: [showcase.STYLESHEET, 'kit.css'],
            jsonLd: [listing.jobPosting(row, { siteUrl: config.baseUrl })],
            body: html`<article class="job">
<h1>${l.title}</h1>
<p class="job-meta"><span class="job-company">${companies.slugOf(row.company) ? html`<a href="/companies/${companies.slugOf(row.company)}">${l.company}</a>` : l.company}</span> · <span class="job-location">${l.location || 'Location not given'}</span>${l.remote ? ' · Remote' : ''}${jobTypeText ? html` · <span class="job-type">${jobTypeText}</span>` : ''}</p>
${listing.salaryLine(row, { note: true })}
${l.tags.length ? html`<p class="job-chips">${l.tags.map((t) => html`<span class="chip chip-tag">${t}</span>`)}</p>` : ''}
<section class="job-excerpt-block" aria-labelledby="h-excerpt"><h2 id="h-excerpt">Excerpt</h2>
<p>${l.excerpt}</p>
<p class="muted small">Short excerpt only. You apply on ${src.name}.</p></section>
<p class="job-apply"><a class="sc-btn sc-primary" href="${l.url}" rel="nofollow noopener external" target="_blank">Read the full listing on ${src.name}</a> <span class="muted small">Read from ${src.name} on ${fetchedOn}</span></p>
${signedIn(req)
            ? (tracked
                ? html`<p class="job-track"><span class="badge ok">Tracked: ${STATUS_LABEL[tracked.status] || tracked.status}</span> <a href="/applications/${tracked.id}">Open your application</a></p>`
                : html`<form class="inline" method="post" action="/jobs/${row.id}/track"><button class="sc-btn" type="submit">Track this job</button></form>`)
            : html`<p class="muted small"><a rel="nofollow" href="/auth/login?next=%2Fjobs%2F${row.id}">Sign in</a> to track this job and ask your agent for help applying.</p>`}
${raw(kit.fold({
                id: 'job-provenance',
                title: 'Where this listing came from',
                meta: src.name,
                body: String(html`<dl class="job-facts">
<dt>Source</dt><dd>${sourceLine(row)} — <a href="/sources#${src.id}">its terms as applied</a></dd>
${l.posted_at ? html`<dt>Posted</dt><dd>${time(l.posted_at)}</dd>` : ''}
<dt>Read from the board</dt><dd>${time(row.fetched_at)}</dd>
<dt>First seen</dt><dd>${time(row.first_seen_at)}</dd>
<dt>Last seen</dt><dd>${time(row.last_seen_at)}</dd>
<dt>Board's id</dt><dd><code>${row.source_id}</code></dd>
</dl>`),
            }))}
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
        const bits = [row.query ? `“${row.query}”` : '', row.remote === 'true' ? 'remote' : row.remote === 'false' ? 'on-site' : '', typeText(row.type), row.location ? `in ${row.location}` : ''].filter(Boolean);
        return bits.length ? bits.join(' ') : 'everything';
    };

    // ── Companies: every company with open listings, and one page each ──
    // A company page with fewer than three openings is noindex (thin); the index lists the 300 with the most and finds
    // any of them by name.
    const COMPANY_INDEX_MIN = 3;
    r.get('/companies', async (req, res) => {
        const all = await companies.list(s);
        const q = typeof req.query.q === 'string' ? req.query.q.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
        const shown = (q ? all.filter((c) => c.company.toLowerCase().includes(q.toLowerCase()) || c.slug.includes(companies.slugOf(q))) : all).slice(0, 300);
        const base = String(config.baseUrl).replace(/\/+$/, '');
        page(req, res, {
            index: !q, cache: signedIn(req) ? null : PUBLIC_CACHE,
            title: q ? `Companies matching “${q}”` : 'Companies hiring',
            description: `${n(all.length)} companies with open listings on OpenVibe.Work, most openings first, each with its jobs, where they are and which boards list them.`,
            crumbs: [{ label: 'Companies' }], styles: [showcase.STYLESHEET],
            jsonLd: q ? [] : [seo.jsonLd.itemList('Companies hiring on OpenVibe.Work', shown.slice(0, 50).map((c) => ({ name: c.company, url: `${base}/companies/${c.slug}` })), { url: `${base}/companies` })],
            body: html`<h1>Companies hiring</h1>
<p class="lede">${n(all.length)} companies have open listings on the boards OpenVibe.Work reads, most openings first.</p>
<form class="ov-form filter-form" method="get" action="/companies" role="search"><label for="cq">Company</label><input id="cq" name="q" type="search" value="${q}" maxlength="80" placeholder="A company's name"><button class="sc-btn" type="submit">Find</button>${q ? html` <a href="/companies">All companies</a>` : ''}</form>
${shown.length ? html`<ul class="home-cards">${shown.map((c) => html`<li><a href="/companies/${c.slug}"><b>${c.company}</b><span>${n(c.count)} open listing${c.count === 1 ? '' : 's'}${c.remote ? html`, ${n(c.remote)} remote` : ''}</span></a></li>`)}</ul>`
        : notice(q ? 'No company with open listings matches that name.' : 'No open listings yet.', 'warn')}
${!q && all.length > shown.length ? html`<p class="muted small">The ${n(shown.length)} with the most openings. Find any other by name above.</p>` : ''}`,
        });
    });

    r.get('/companies/:slug', async (req, res) => {
        const c = await companies.bySlug(s, req.params.slug);
        if (!c) {
            return page(req, res, {
                title: 'No open listings', crumbs: [{ label: 'Companies', href: '/companies' }, { label: 'Not found' }],
                body: html`<h1>No open listings</h1><p>No company here has open listings at that address. A company's page goes once the boards stop showing its listings.</p><p><a href="/companies">Every company hiring</a></p>`,
            }, 404);
        }
        const base = String(config.baseUrl).replace(/\/+$/, '');
        const boards = c.sources.map((x) => { const src = sources.byId(x.source); return html`<a href="/sources#${x.source}">${src ? src.name : x.source}</a> (${n(x.count)})`; });
        page(req, res, {
            index: c.count >= COMPANY_INDEX_MIN, cache: signedIn(req) ? null : PUBLIC_CACHE,
            title: `Jobs at ${c.company}`,
            description: `${n(c.count)} open listing${c.count === 1 ? '' : 's'} at ${c.company}${c.remote ? `, ${n(c.remote)} remote` : ''}${c.places.length ? `, in ${c.places.slice(0, 3).map((p) => p.place).join(', ')}` : ''}, from the boards OpenVibe.Work reads, each linking back to the original listing.`.slice(0, 300),
            crumbs: [{ label: 'Companies', href: '/companies' }, { label: c.company }], styles: [showcase.STYLESHEET],
            jsonLd: [seo.jsonLd.itemList(`Jobs at ${c.company}`, c.rows.slice(0, 50).map((row) => ({ name: `${row.title} at ${row.company}`, url: `${base}/jobs/${row.id}` })), { url: `${base}/companies/${c.slug}` })],
            body: html`<h1>Jobs at ${c.company}</h1>
<p class="lede">${n(c.count)} open listing${c.count === 1 ? '' : 's'}${c.remote ? html`, ${n(c.remote)} of them remote` : ''}${c.salaried ? html`, ${n(c.salaried)} stating the pay` : ''}. Listed on ${boards.length > 1 ? html`${boards.slice(0, -1).map((b, i) => html`${i ? ', ' : ''}${b}`)} and ${boards[boards.length - 1]}` : boards[0]}.</p>
${c.places.length ? html`<p class="small">Where: ${c.places.map((p, i) => html`${i ? ', ' : ''}<a href="/jobs?${new URLSearchParams({ q: c.company, location: p.place })}">${p.place}</a> (${n(p.count)})`)}</p>` : ''}
<p class="job-alert"><a class="sc-btn" href="${alertHref(store.filtersOf({ q: c.company }))}">Get alerts for ${c.company}</a></p>
${listing.listingList(c.rows, { sourceOf, empty: 'No open listings.' })}
${c.count > c.rows.length ? html`<p><a class="sc-btn" href="/jobs?${new URLSearchParams({ q: c.company })}">All ${n(c.count)} in the search</a></p>` : ''}
<p class="muted small">The company's name as the boards write it. Read each full listing on its board: every entry links back to it.</p>`,
        });
    });

    r.get('/saved', async (req, res) => {
        if (!signedIn(req)) {
            return page(req, res, {
                title: 'Saved searches',
                body: html`<h1>Saved searches</h1>
<p>Sign in to keep a search and see what has appeared since you last looked. Searching itself needs no account.</p>
<p><a class="sc-btn sc-primary" rel="nofollow" href="/auth/login?next=%2Fsaved">Sign in with OpenVibe</a> <a class="sc-btn" href="/jobs">Search the listings</a></p>`,
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
            title: 'Saved searches', crumbs: [{ label: 'Saved searches' }], styles: [showcase.STYLESHEET],
            body: html`<h1>Saved searches</h1>
<p>${rows.length ? html`You are keeping ${rows.length} search${rows.length === 1 ? '' : 'es'}. The count is how many listings appeared since you last opened this page.` : 'You are not keeping any search yet.'}</p>
${withCounts.length ? html`<ul class="saved-list">${withCounts.map(({ row, count }) => html`<li class="saved-item">
<p class="saved-query"><a href="${store.toSavedWire(row).search_path}">${describeSaved(row)}</a> <span class="badge${count ? ' ok' : ''}">${count ? `${count} new` : 'nothing new'}</span></p>
<p class="muted small">Saved ${time(row.created_at)} · last ran ${row.last_seen_at ? time(row.last_seen_at) : 'never'}</p>
<div class="saved-actions"><a class="sc-btn" href="${alertHref(store.filtersOf({ q: row.query, remote: row.remote, type: row.type, location: row.location }))}">Get alerts</a> <form method="post" action="/saved/${row.id}/delete" class="inline"><button class="sc-btn" type="submit">Forget it</button></form></div>
</li>`)}</ul>` : ''}
${savedForm(req, initial)}
<p class="muted small">Get alerts opens OpenVibe.Watch with the search's feed filled in: Watch checks it and tells you (or runs your agent) when a listing that fits appears. Every search has its feed at <code>/jobs.atom</code> with the same filters.</p>
<p class="muted small">Alerts for a search come from OpenVibe.Watch, on the same account.</p>
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

    // ── Applications ─────────────────────────────────────────
    const APP_STYLES = ['css/applications.css'];
    const editForm = (a) => html`<form class="app-form" method="post" action="/applications/${a.id}">
<label>Status <select name="status">${STATUS_ORDER.map((st) => html`<option value="${st}"${a.status === st ? raw(' selected') : ''}>${STATUS_LABEL[st]}</option>`)}</select></label>
<div class="app-row"><label>Applied on <input type="date" name="applied_at" value="${dateInputValue(a.applied_at)}"></label>
<label>Next step by <input type="date" name="next_step_at" value="${dateInputValue(a.next_step_at)}"></label></div>
<label>Next step <input type="text" name="next_step" maxlength="200" value="${a.next_step || ''}" placeholder="Follow up with the recruiter"></label>
<label>Notes <textarea name="notes" maxlength="5000" rows="6">${a.notes || ''}</textarea></label>
<button class="sc-btn sc-primary" type="submit">Save</button>
</form>`;
    const addForm = () => html`<section class="app-panel app-add" aria-labelledby="h-add"><h2 id="h-add">Add one by hand</h2>
<form class="app-form" method="post" action="/applications">
<div class="app-row"><label>Job title <input type="text" name="title" maxlength="500" required></label>
<label>Company <input type="text" name="company" maxlength="200" required></label></div>
<label>Link to the listing <input type="url" name="url" maxlength="2000" required placeholder="https://"></label>
<button class="sc-btn sc-primary" type="submit">Add application</button>
</form>
<p class="muted small">Or press “Track this job” on any <a href="/jobs">listing</a>.</p></section>`;

    const renderApplication = (req, res, a, { events = [], problem = null, assisted = false } = {}) => page(req, res, {
        title: `${a.title} at ${a.company}`, styles: [showcase.STYLESHEET], localStyles: APP_STYLES,
        crumbs: [{ label: 'Applications', href: '/applications' }, { label: a.title }],
        body: html`<div class="app-head"><h1>${a.title}</h1>${statusBadge(a.status)}</div>
<p class="app-company">${a.company}${a.url ? html` · <a href="${a.url}" rel="nofollow noopener external" target="_blank">the original listing</a>` : ''}${a.listing_id ? html` · <a href="/jobs/${a.listing_id}">this listing on OpenVibe.Work</a>` : ''}</p>
${problem ? notice(problem, 'warn') : ''}
${assisted && a.actor_task_id ? notice(html`Your agent is on it: <a href="${config.actor.publicUrl}/tasks/${a.actor_task_id}">open the task on OpenVibe.Actor</a>.`, 'ok') : ''}
<div class="app-detail">
<section class="app-panel" aria-labelledby="h-edit"><h2 id="h-edit">Your application</h2>${editForm(a)}</section>
<div>
<section class="app-panel app-agent" aria-labelledby="h-agent"><h2 id="h-agent">Help from your agent</h2>
<p class="small">Your OpenVibe.Actor agent reads this listing and your notes, then works on what you ask. It runs on your Actor allowance.</p>
<form class="app-form" method="post" action="/applications/${a.id}/assist">
<label>What do you want help with? <span class="muted">(optional)</span><textarea name="ask" maxlength="1000" rows="3" placeholder="${applications.DEFAULT_ASK}"></textarea></label>
<button class="sc-btn sc-primary" type="submit">Ask my agent</button>
</form>
${a.actor_task_id ? html`<p class="small">Latest task: <a href="${config.actor.publicUrl}/tasks/${a.actor_task_id}">open it on OpenVibe.Actor</a>${a.assists > 1 ? html` (${a.assists} asked so far)` : ''}.</p>` : ''}
</section>
<section class="app-panel" aria-labelledby="h-history"><h2 id="h-history">History</h2>
${events.length ? html`<ul class="app-history">${events.map((e) => html`<li>${time(e.at)} · ${STATUS_LABEL[e.from_status] || e.from_status} → ${STATUS_LABEL[e.to_status] || e.to_status}</li>`)}</ul>` : html`<p class="muted small">No status changes yet. Added ${time(a.created_at)}.</p>`}
</section>
<form class="app-danger" method="post" action="/applications/${a.id}/delete"><button type="submit">Delete this application</button></form>
</div>
</div>`,
    });

    r.get('/applications', async (req, res) => {
        if (!signedIn(req)) {
            return page(req, res, {
                title: 'Applications', styles: [showcase.STYLESHEET],
                body: html`<h1>Applications</h1>
<p>Track the jobs you apply to, keep your notes and next steps in one place, and ask your OpenVibe.Actor agent to help you prepare each application. Sign in to begin.</p>
<p><a class="sc-btn sc-primary" rel="nofollow" href="/auth/login?next=%2Fapplications">Sign in with OpenVibe</a> <a class="sc-btn" href="/jobs">Search the listings</a></p>`,
            });
        }
        const subject = subjectOf(req);
        const rows = await applications.listAllApplications(s, subject);
        const groups = STATUS_ORDER.map((st) => ({ status: st, rows: rows.filter((r) => r.status === st) }));
        const total = rows.length;
        page(req, res, {
            title: 'Applications', crumbs: [{ label: 'Applications' }], styles: [showcase.STYLESHEET], localStyles: APP_STYLES,
            body: html`<h1>Applications</h1>
<p>${total ? html`You are tracking ${total} application${total === 1 ? '' : 's'}.` : html`Nothing tracked yet. Press “Track this job” on a <a href="/jobs">listing</a>, or add one by hand below.`}</p>
${total ? html`<ul class="app-summary" aria-label="Applications by status">${groups.map((g) => html`<li>${g.rows.length ? html`<a href="#h-${g.status}">${STATUS_LABEL[g.status]} <strong>${g.rows.length}</strong></a>` : html`<span class="is-empty">${STATUS_LABEL[g.status]} <strong>0</strong></span>`}</li>`)}</ul>` : ''}
${groups.map((g) => (g.rows.length ? html`<section class="app-group" aria-labelledby="h-${g.status}">
<h2 id="h-${g.status}">${STATUS_LABEL[g.status]}</h2>
<ul class="app-list">${g.rows.map((a) => html`<li class="app-item">
<p class="app-title"><a href="/applications/${a.id}">${a.title}</a>${statusBadge(a.status)}</p>
<p class="app-co">${a.company}</p>
${a.next_step ? html`<p class="app-next">Next: ${a.next_step}${a.next_step_at ? html` · by <time datetime="${a.next_step_at}">${dateInputValue(a.next_step_at)}</time>` : ''}</p>` : ''}
<p class="muted small">Updated ${time(a.updated_at)}</p>
</li>`)}</ul>
</section>` : ''))}
${addForm()}`,
        });
    });

    r.post('/applications', require('express').urlencoded({ extended: false, limit: '8kb' }), async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!signedIn(req)) return res.redirect(303, '/auth/login?next=%2Fapplications');
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('Adding an application must come from openvibe.work itself.');
        const v = applications.validateCreate(req.body || {});
        if (v.error) {
            return page(req, res, { title: 'Applications', crumbs: [{ label: 'Applications' }], body: html`<h1>Applications</h1>${notice(v.error[2], 'warn')}<p><a href="/applications">Back to your applications</a></p>` }, 400);
        }
        const out = await applications.createApplication(s, subjectOf(req), v.fields, { id: s.newId('wap'), now: s.iso(), max: config.applications.max });
        if (out.error === 'full') {
            return page(req, res, { title: 'Applications', body: html`<h1>Applications</h1>${notice(`You can track up to ${config.applications.max} applications; delete one first.`, 'warn')}<p><a href="/applications">Back to your applications</a></p>` }, 409);
        }
        return res.redirect(303, `/applications/${out.row.id}`);
    });

    r.get('/applications/:id', async (req, res) => {
        if (!signedIn(req)) {
            return page(req, res, {
                title: 'Application', styles: [showcase.STYLESHEET],
                body: html`<h1>Application</h1><p>Sign in to see your applications.</p><p><a class="sc-btn sc-primary" rel="nofollow" href="/auth/login?next=%2Fapplications">Sign in with OpenVibe</a></p>`,
            });
        }
        const subject = subjectOf(req);
        const a = await applications.getApplication(s, subject, req.params.id);
        if (!a) {
            return page(req, res, {
                title: 'Application not found',
                body: html`<h1>Application not found</h1><p>No application here with that id. It may have been deleted.</p><p><a href="/applications">Back to your applications</a></p>`,
            }, 404);
        }
        const events = await applications.listEvents(s, a.id);
        return renderApplication(req, res, a, { events, assisted: req.query.assisted === '1' });
    });

    r.post('/applications/:id', require('express').urlencoded({ extended: false, limit: '16kb' }), async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!signedIn(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent(`/applications/${req.params.id}`)}`);
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('Editing an application must come from openvibe.work itself.');
        const subject = subjectOf(req);
        const current = await applications.getApplication(s, subject, req.params.id);
        if (!current) return res.status(404).type('text/plain').send('No such application.');
        const patch = { status: req.body.status, notes: req.body.notes || '', next_step: req.body.next_step || '', next_step_at: dateFromForm(req.body.next_step_at) };
        const applied = req.body.applied_at ? dateFromForm(req.body.applied_at) : undefined;
        if (applied !== undefined && applied !== null) patch.applied_at = applied;
        const v = applications.validatePatch(patch);
        if (v.error) {
            const a = await applications.getApplication(s, subject, req.params.id);
            const events = await applications.listEvents(s, a.id);
            return renderApplication(req, res, a, { events, problem: v.error[2] });
        }
        await applications.updateApplication(s, subject, req.params.id, v.fields, { now: s.iso() });
        return res.redirect(303, `/applications/${req.params.id}`);
    });

    r.post('/applications/:id/assist', require('express').urlencoded({ extended: false, limit: '8kb' }), async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!signedIn(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent(`/applications/${req.params.id}`)}`);
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('Asking your agent must come from openvibe.work itself.');
        const subject = subjectOf(req);
        const app = await applications.getApplication(s, subject, req.params.id);
        if (!app) return res.status(404).type('text/plain').send('No such application.');
        const a = applications.validateAsk(req.body || {});
        if (a.error) {
            const events = await applications.listEvents(s, app.id);
            return renderApplication(req, res, app, { events, problem: a.error[2] });
        }
        const actor = ctx.actor;
        if (!actor || !actor.available) {
            const events = await applications.listEvents(s, app.id);
            return renderApplication(req, res, app, { events, problem: 'The OpenVibe.Actor agent is not available right now.' });
        }
        const n = Number(app.assists || 0) + 1;
        const idempotencyKey = `work-assist:${app.id}:${n}`;
        const listing = app.listing_id ? await store.getListing(s, app.listing_id) : null;
        const text = applications.buildTaskText(app, listing, a.ask);
        let out;
        try {
            out = await actor.createTask({ subjectId: subject.slice('user:'.length), task: text, idempotencyKey });
        } catch (err) {
            const events = await applications.listEvents(s, app.id);
            if (err && (err.status === 402 || err.status === 429)) return renderApplication(req, res, app, { events, problem: (err.detail || 'The agent refused this task.') });
            return renderApplication(req, res, app, { events, problem: 'The agent could not be reached.' });
        }
        await applications.recordAssist(s, subject, app.id, out.id, s.iso());
        return res.redirect(303, `/applications/${app.id}?assisted=1`);
    });

    r.post('/applications/:id/delete', async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!signedIn(req)) return res.redirect(303, '/auth/login?next=%2Fapplications');
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('Deleting an application must come from openvibe.work itself.');
        await applications.deleteApplication(s, subjectOf(req), req.params.id);
        return res.redirect(303, '/applications');
    });

    r.post('/jobs/:id/track', async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!signedIn(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent(`/jobs/${req.params.id}`)}`);
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('Tracking must come from openvibe.work itself.');
        const listingRow = await store.getListing(s, req.params.id);
        if (!listingRow) return res.status(404).type('text/plain').send('No such listing to track.');
        const subject = subjectOf(req);
        const existing = await applications.applicationByListing(s, subject, listingRow.id);
        if (existing) return res.redirect(303, `/applications/${existing.id}`);
        const out = await applications.createApplication(s, subject, { listing_id: listingRow.id, title: listingRow.title, company: listingRow.company, url: listingRow.url }, { id: s.newId('wap'), now: s.iso(), max: config.applications.max });
        if (out.error === 'full') return res.redirect(303, '/applications');
        return res.redirect(303, `/applications/${out.row.id}`);
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
<dt>API</dt><dd>${src.viaSources ? html`read through OpenVibe.Sources from <code>${src.requests(config)[0]}</code>` : html`<code>${src.requests(config)[0]}</code>`}</dd>
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
                [html`<code>GET /api/v1/jobs/:id</code>`, 'public', html`One listing: the board's fields, the excerpt, the source, and <code>url</code>, the original listing to apply on.`],
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
        description: 'Every change deployed to OpenVibe.Work, newest first, from the OpenVibe network\'s shared update log.',
        body: raw(frame.updatesBody({ service: 'work', siteName: SITE_NAME }) + `<script src="${ovServe.url('shipped.js')}" defer></script>`),
    }));

    // ── Discovery: robots.txt, sitemap.xml, llms.txt, llms-full.txt ──
    r.use(createDiscoveryRoutes(ctx));
    return r;
}

module.exports = { createPageRoutes, SITE_NAME, TAGLINE };
