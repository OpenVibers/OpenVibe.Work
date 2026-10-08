'use strict';

/**
 * The job boards OpenVibe.Work gathers from, one entry each: where it fetches, the terms it must apply, and how its
 * payload becomes a listing. Nothing here is invented: a field a board does not give stays empty, and every listing
 * keeps the board's own id and the original URL to link back to.
 *
 * Adding a source is adding an entry here and nothing else — the ingest, the search and the pages read this list.
 * Each entry is:
 *
 *   id          the short name stored on every listing, and shown to the reader
 *   name        the board's name, as it wants to be attributed
 *   homepage    the board itself
 *   terms       its terms of use for the API, in the board's own terms, as applied here
 *   attribution the line every page that shows one of its listings must carry
 *   requests(config)  the URLs to fetch, in order
 *   parse(json)       the payload → normalized listings (see normalize below)
 *   remoteDefault     what a listing from this board is when the board says nothing
 *
 * A normalized listing is:
 *   { source_id, url, title, company, location, remote, tags[], job_type, salary, posted_at, description_html }
 */

const { excerpt } = require('./text');

const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const list = (v, n = 12) => (Array.isArray(v) ? v : [v]).filter((x) => x != null && String(x).trim()).map((x) => clip(x, 60)).slice(0, n);

/** An ISO 8601 UTC instant, or null. Boards mix Unix seconds, Unix milliseconds and date strings. */
function instant(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number' || /^\d+$/.test(String(v))) {
        const n = Number(v);
        // Seconds, milliseconds or microseconds since the epoch — whichever lands in a sane range.
        const ms = n > 1e14 ? n / 1000 : n > 1e11 ? n : n * 1000;
        const d = new Date(ms);
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    const d = new Date(String(v));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * The listing's URL, or null. Only http(s) is kept: anything else (a javascript: URL, a data: URL) is not a link
 * back to a listing and is dropped with the listing rather than shown.
 */
function httpUrl(v) {
    try {
        const u = new URL(String(v));
        return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString().slice(0, 2000) : null;
    } catch { return null; }
}

const money = (n) => (n == null || n === '' || !Number.isFinite(Number(n)) || Number(n) <= 0 ? null : Math.round(Number(n)));

const SOURCES = [
    {
        id: 'arbeitnow',
        name: 'Arbeitnow',
        homepage: 'https://www.arbeitnow.com/',
        terms: 'Arbeitnow publishes its job board API free of charge. We attribute Arbeitnow by name and link every listing back to its page on arbeitnow.com.',
        attribution: 'Listing from Arbeitnow',
        remoteDefault: false,
        requests(config) {
            const pages = [];
            for (let page = 1; page <= config.ingest.pages; page++) {
                const u = new URL(config.sources.arbeitnow.url);
                u.searchParams.set('page', String(page));
                pages.push(u.toString());
            }
            return pages;
        },
        // { data: [ { slug, company_name, title, description (HTML), remote, url, tags[], job_types[], location, created_at } ] }
        parse(json) {
            const rows = (json && Array.isArray(json.data)) ? json.data : [];
            return rows.map((r) => ({
                source_id: clip(r.slug || r.url, 200),
                url: httpUrl(r.url),
                title: clip(r.title, 300),
                company: clip(r.company_name, 200),
                location: clip(r.location, 200),
                remote: r.remote === true,
                tags: list(r.tags),
                job_type: list(r.job_types).join(', ') || null,
                salary: null,                       // this board gives no salary
                posted_at: instant(r.created_at),
                description_html: r.description,
            }));
        },
    },
    {
        id: 'remotive',
        name: 'Remotive',
        homepage: 'https://remotive.com/',
        terms: 'To use the Remotive API you must mention Remotive as the source and link to the listing. The API is read at most about four times a day, which is what the six-hour ingest interval is.',
        attribution: 'Listing from Remotive',
        remoteDefault: true,                        // every Remotive listing is remote by definition
        requests(config) {
            const u = new URL(config.sources.remotive.url);
            u.searchParams.set('limit', String(config.ingest.limit));
            return [u.toString()];
        },
        // { jobs: [ { id, url, title, company_name, category, tags[], job_type, publication_date, candidate_required_location, salary, description (HTML) } ] }
        parse(json) {
            const rows = (json && Array.isArray(json.jobs)) ? json.jobs : [];
            return rows.map((j) => ({
                source_id: clip(j.id, 200),
                url: httpUrl(j.url),
                title: clip(j.title, 300),
                company: clip(j.company_name, 200),
                location: clip(j.candidate_required_location, 200),
                remote: true,
                // Remotive labels a job with both tags and one category; a listing row has one labels column, so both
                // are kept there, in the board's own words rather than our reading of them.
                tags: list([].concat(j.tags || [], j.category || [])),
                job_type: clip(j.job_type, 80) || null,
                salary: clip(j.salary, 200) || null,
                posted_at: instant(j.publication_date),
                description_html: j.description,
            }));
        },
    },
    {
        id: 'remoteok',
        name: 'RemoteOK',
        homepage: 'https://remoteok.com/',
        terms: 'RemoteOK asks that a use of its API names RemoteOK as the source and links back to the listing. The response\'s first element is a legal notice, not a listing, and is skipped.',
        attribution: 'Listing from RemoteOK',
        remoteDefault: true,
        requests(config) { return [config.sources.remoteok.url]; },
        // The response is an array whose first element is the legal notice; every later element is a listing.
        parse(json) {
            const all = Array.isArray(json) ? json : [];
            const rows = all.filter((r) => r && (r.id != null || r.slug) && r.position);
            return rows.map((r) => {
                const min = money(r.salary_min);
                const max = money(r.salary_max);
                return {
                    source_id: clip(r.id != null ? r.id : r.slug, 200),
                    url: httpUrl(r.url || (r.slug ? `https://remoteok.com/remote-jobs/${r.slug}` : null)),
                    title: clip(r.position, 300),
                    company: clip(r.company, 200),
                    location: clip(r.location, 200),
                    remote: true,
                    tags: list(r.tags),
                    job_type: clip(r.job_type || r.type, 80) || null,
                    salary: min && max ? `$${min.toLocaleString('en-US')}–$${max.toLocaleString('en-US')} a year` : null,
                    posted_at: instant(r.date),
                    description_html: r.description,
                };
            });
        },
    },
];

const byId = (id) => SOURCES.find((s) => s.id === id) || null;
const ids = () => SOURCES.map((s) => s.id);

/**
 * A parsed row → the columns of work_listings, or null when it is not a listing we may keep. What we refuse: a row
 * with no id, no title, no company or no http(s) URL to link back to — without those a listing has no provenance and
 * must not be published. The excerpt is what is stored; the board keeps the full description.
 */
function toRow(raw, { sourceId, fetchedAt, idOf }) {
    // The URL is checked again here even though each parse does it: this is the last gate before anything is stored,
    // and a listing without an http(s) link back to its board has no provenance and is not published.
    const url = raw && httpUrl(raw.url);
    if (!raw || !raw.source_id || !raw.title || !raw.company || !url) return null;
    const tags = list(raw.tags);
    const row = {
        id: idOf(sourceId, raw.source_id),
        source: sourceId,
        source_id: String(raw.source_id),
        url,
        title: String(raw.title),
        company: String(raw.company),
        location: raw.location || null,
        remote: !!raw.remote,
        tags: tags.join(', '),
        job_type: raw.job_type || null,
        salary: raw.salary || null,
        excerpt: excerpt(raw.description_html).slice(0, 400),
        posted_at: raw.posted_at || null,
        sort_at: raw.posted_at || fetchedAt,
        fetched_at: fetchedAt,
    };
    row.search_text = [row.title, row.company, row.tags, row.location, row.excerpt, row.salary].filter(Boolean).join(' ').toLowerCase().slice(0, 4000);
    return row;
}

module.exports = { SOURCES, byId, ids, toRow };
