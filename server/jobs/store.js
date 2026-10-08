'use strict';

/**
 * The listings, the searches a person saved and what each source's last fetch did (migrations/0002_listings.sql).
 * Every function takes the store (server/db.js createStore) first, as everywhere else in this service.
 *
 * A listing is never restated: the row holds the board's own fields, a short excerpt and the original URL. Search is
 * a plain case-insensitive substring over one lowercased column — a job board of this size does not need a text
 * index, and the LIKE pattern is a bound parameter, never built from what a caller typed.
 */
const crypto = require('crypto');

const PAGE_SIZE = 30;
const MAX_PAGE = 100;
const TYPE_FACETS = 12;

// ── ids ─────────────────────────────────────────────────────
// A listing's id is derived from (source, source_id), so the same listing keeps the same URL on this site however
// often the board is re-read, and two sources can never collide. 26 base32 characters, the shape of a ULID.
const B32 = '0123456789abcdefghjkmnpqrstvwxyz';
function idOf(source, sourceId) {
    const digest = crypto.createHash('sha256').update(`${source}:${sourceId}`).digest();
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of digest) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5 && out.length < 26) {
            out += B32[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
        if (out.length >= 26) break;
    }
    return `job_${out}`;
}
const LISTING_ID = /^job_[0-9abcdefghjkmnpqrstvwxyz]{26}$/;

// ── search ──────────────────────────────────────────────────
const lower = (s) => String(s == null ? '' : s).trim().toLowerCase().slice(0, 120);
/** A LIKE pattern that matches the term literally: % and _ a caller typed are characters, not wildcards. */
const like = (term) => `%${term.replace(/[\\%_]/g, '\\$&')}%`;

/** The four filters a search takes, from anything (a query string, an API call, a saved search row). */
function filtersOf(input = {}) {
    const remote = String((input.remote == null ? '' : input.remote)).toLowerCase();
    return {
        // A search comes from a query string (`q`), an API body or a saved search row (`query`).
        q: lower(input.q == null ? input.query : input.q),
        remote: remote === 'true' || remote === 'yes' || remote === '1' ? 'true' : remote === 'false' || remote === 'no' || remote === '0' ? 'false' : '',
        type: lower(input.type),
        location: lower(input.location),
    };
}

const num = (v) => (v == null ? 0 : Number(v));
const parseTags = (s) => String(s || '').split(',').map((t) => t.trim()).filter(Boolean);

/** A row → the listing as the pages and the API see it. `url` is always the board's own. */
function toWire(row, { source } = {}) {
    return {
        id: row.id,
        source: row.source,
        source_name: (source && source.name) || row.source,
        source_url: (source && source.homepage) || null,
        url: row.url,
        title: row.title,
        company: row.company,
        location: row.location || null,
        remote: !!row.remote,
        tags: parseTags(row.tags),
        job_type: row.job_type || null,
        salary: row.salary || null,
        excerpt: row.excerpt,
        posted_at: row.posted_at || null,
        fetched_at: row.fetched_at,
        first_seen_at: row.first_seen_at,
        attribution: (source && source.attribution) || null,
    };
}

// The filters a caller set, as bound parameters — never string-built. Everything is a LIKE on a lowercased column,
// and the term's own % and _ are literal characters.
const PARAM = {
    q: (n) => `($${n} = '' OR search_text LIKE $${n} ESCAPE '\\')`,
    remote: (n) => `($${n} = '' OR remote = ($${n} = 'true'))`,
    type: (n) => `($${n} = '' OR lower(coalesce(job_type, '')) LIKE $${n} ESCAPE '\\')`,
    location: (n) => `($${n} = '' OR lower(coalesce(location, '')) LIKE $${n} ESCAPE '\\')`,
};
const valueOf = { q: (f) => (f.q ? like(f.q) : ''), remote: (f) => f.remote, type: (f) => (f.type ? like(f.type) : ''), location: (f) => (f.location ? like(f.location) : '') };

/**
 * One page of listings, newest first, plus the facets for the current scope. The cursor is the position of the last
 * row (sort_at, id); a page is the rows strictly after it, so a listing that arrives mid-scroll does not shift it.
 */
async function search(s, filters, { limit = PAGE_SIZE, cursor = null } = {}) {
    const f = filtersOf(filters);
    const n = Math.min(MAX_PAGE, Math.max(1, Number(limit) || PAGE_SIZE));
    const args = [];
    const where = ['expired = false'];
    for (const name of ['q', 'remote', 'type', 'location']) {
        args.push(valueOf[name](f));
        where.push(PARAM[name](args.length));
    }
    const scope = where.join(' AND ');
    // How many listings the reader's filters actually match, counted exactly rather than inferred from the page.
    const matches = Number(await s.db.value(`SELECT count(*) AS n FROM work_listings WHERE ${scope}`, args));
    const at = cursor && cursor.sort_at && cursor.id ? cursor : null;
    if (at) {
        args.push(at.sort_at, at.id);
        where.push(`(sort_at, id) < ($${args.length - 1}, $${args.length})`);
    }
    const rows = await s.db.many(
        `SELECT * FROM work_listings WHERE ${where.join(' AND ')} ORDER BY sort_at DESC, id DESC LIMIT ${n + 1}`, args);
    const pageRows = rows.slice(0, n);
    const last = pageRows[pageRows.length - 1];
    return {
        rows: pageRows,
        next: rows.length > n && last ? { sort_at: last.sort_at, id: last.id } : null,
        facets: { matches, ...(await facets(s, f)) },
    };
}

/**
 * The counts the filter bar shows: how many are remote and not, and the job types present, for the text and location
 * in force. The remote and type filters are deliberately left out of their own facet — applied, they would show only
 * the answer the reader already chose.
 */
async function facets(s, f) {
    const args = [valueOf.q(f), valueOf.location(f)];
    const scope = `expired = false AND ${PARAM.q(1)} AND ${PARAM.location(2)}`;
    const remoteRows = await s.db.many(`SELECT remote, count(*) AS n FROM work_listings WHERE ${scope} GROUP BY remote`, args);
    const typeRows = await s.db.many(
        `SELECT lower(job_type) AS t, count(*) AS n FROM work_listings
         WHERE ${scope} AND coalesce(job_type, '') <> ''
         GROUP BY lower(job_type) ORDER BY n DESC, t ASC LIMIT ${TYPE_FACETS}`, args);
    const remote = { true: 0, false: 0 };
    for (const r of remoteRows) remote[r.remote ? 'true' : 'false'] = num(r.n);
    // `scope` counts the words and the location only — the population each facet below divides up.
    return { remote, type: typeRows.map((r) => ({ type: r.t, count: num(r.n) })), scope: remote.true + remote.false };
}

const getListing = (s, id) => (LISTING_ID.test(String(id)) ? s.db.maybe('SELECT * FROM work_listings WHERE id = $1 AND expired = false', [id]) : Promise.resolve(null));

/** How many live listings each source has, and when one was last seen — the home page's provenance line. */
async function countsBySource(s) {
    const rows = await s.db.many(
        `SELECT source, count(*) AS n, max(last_seen_at) AS last_seen_at
         FROM work_listings WHERE expired = false GROUP BY source`);
    const out = new Map(rows.map((r) => [r.source, { count: num(r.n), last_seen_at: r.last_seen_at }]));
    return out;
}

/** The newest live listings; `remote: true` is the remote-only selection the home page shows. */
const listRecent = (s, limit = 5, { remote = false } = {}) => s.db.many(
    `SELECT * FROM work_listings WHERE expired = false${remote ? ' AND remote = true' : ''} ORDER BY sort_at DESC, id DESC LIMIT $1`,
    [Math.min(50, Math.max(1, limit))]);

/** The ids of the newest live listings, for the sitemap: its own cap, so a big board cannot bloat the file. */
const recentIds = (s, limit = 1000) => s.db.many(
    `SELECT id FROM work_listings WHERE expired = false ORDER BY sort_at DESC, id DESC LIMIT $1`, [Math.min(1000, Math.max(1, limit))]);

/** The listings first seen after a saved search's last look — what "new since you last looked" counts. */
function newCountSql() {
    return `SELECT count(*) AS n FROM work_listings
            WHERE expired = false AND first_seen_at > $1
              AND ${PARAM.q(2)} AND ${PARAM.remote(3)} AND ${PARAM.type(4)} AND ${PARAM.location(5)}`;
}

// ── ingest writes ───────────────────────────────────────────
/**
 * Upsert one source's listings. A listing the board still shows is updated in place and its last_seen_at moves; one
 * that reappears after expiring comes back (expired = false). Returns { seen, added, updated }.
 */
async function upsertListings(s, rows, { sourceId, fetchedAt }) {
    let added = 0;
    let updated = 0;
    await s.tx(async () => {
        for (const row of rows) {
            const out = await s.db.maybe(
                `INSERT INTO work_listings (id, source, source_id, url, title, company, location, remote, tags, job_type, salary, excerpt, search_text, posted_at, sort_at, fetched_at, first_seen_at, last_seen_at, expired)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16, $16, false)
                 ON CONFLICT (source, source_id) DO UPDATE SET
                     url = EXCLUDED.url, title = EXCLUDED.title, company = EXCLUDED.company, location = EXCLUDED.location,
                     remote = EXCLUDED.remote, tags = EXCLUDED.tags, job_type = EXCLUDED.job_type, salary = EXCLUDED.salary,
                     excerpt = EXCLUDED.excerpt, search_text = EXCLUDED.search_text, posted_at = EXCLUDED.posted_at,
                     sort_at = EXCLUDED.sort_at, fetched_at = EXCLUDED.fetched_at, last_seen_at = EXCLUDED.last_seen_at,
                     expired = false
                 RETURNING (xmax = 0) AS inserted`,
                [row.id, row.source, row.source_id, row.url, row.title, row.company, row.location, row.remote, row.tags, row.job_type, row.salary, row.excerpt, row.search_text, row.posted_at, row.sort_at, fetchedAt]);
            if (out && out.inserted) added++; else updated++;
        }
    });
    return { seen: rows.length, added, updated };
}

/** A source's fetch record: started now, finished when it finished, with what happened. */
const beginFetch = (s, sourceId, startedAt) => s.db.query(
    `INSERT INTO work_source_fetches (source, started_at, finished_at, ok, listings, error) VALUES ($1, $2, NULL, false, 0, NULL)
     ON CONFLICT (source) DO UPDATE SET started_at = EXCLUDED.started_at, finished_at = NULL, ok = false, listings = 0, error = NULL`,
    [sourceId, startedAt]);

const finishFetch = (s, sourceId, { ok, listings, error, finishedAt }) => s.db.query(
    'UPDATE work_source_fetches SET finished_at = $2, ok = $3, listings = $4, error = $5 WHERE source = $1',
    [sourceId, finishedAt, ok, listings, error ? String(error).slice(0, 300) : null]);

async function sourceFetches(s) {
    const rows = await s.db.many('SELECT * FROM work_source_fetches');
    return new Map(rows.map((r) => [r.source, r]));
}

/**
 * Listings the boards stopped showing go. A listing not seen for `days` is expired rather than deleted: the row keeps
 * its history, the search and the pages stop offering it, and a board that shows it again brings it back.
 */
async function expire(s, days, now) {
    const cutoff = new Date(now - days * 86_400_000).toISOString();
    return s.db.exec('UPDATE work_listings SET expired = true WHERE expired = false AND last_seen_at < $1', [cutoff]);
}

// ── saved searches ──────────────────────────────────────────
const SAVED_ID = /^ssc_[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_SAVED = 50;

const listSaved = (s, subject) => s.db.many('SELECT * FROM work_saved_searches WHERE subject = $1 ORDER BY created_at DESC, id DESC', [subject]);

function toSavedWire(row, { newCount = 0 } = {}) {
    const query = queryOf(row);
    return {
        id: row.id,
        query: row.query || '',
        filters: { remote: row.remote || '', type: row.type || '', location: row.location || '' },
        created_at: row.created_at,
        last_seen_at: row.last_seen_at,
        new_count: Number(newCount) || 0,
        // Where to run it again: the person's own search, reproducible from the saved row alone.
        search_path: `/jobs${query ? `?${query}` : ''}`,
    };
}

async function createSaved(s, subject, filters, { id, now }) {
    const f = filtersOf(filters);
    const count = await s.db.value('SELECT count(*) AS n FROM work_saved_searches WHERE subject = $1', [subject]);
    if (Number(count) >= MAX_SAVED) return { error: 'too_many' };
    const row = await s.db.maybe(
        `INSERT INTO work_saved_searches (id, subject, query, remote, type, location, created_at, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING *`,
        [id, subject, f.q, f.remote, f.type, f.location, now]);
    return { row };
}

const getSaved = (s, subject, id) => (SAVED_ID.test(String(id)) ? s.db.maybe('SELECT * FROM work_saved_searches WHERE id = $1 AND subject = $2', [id, subject]) : Promise.resolve(null));
const deleteSaved = (s, subject, id) => (SAVED_ID.test(String(id)) ? s.db.exec('DELETE FROM work_saved_searches WHERE id = $1 AND subject = $2', [id, subject]) : Promise.resolve(0));

/** The count of listings that first appeared after the saved search was last looked at. */
async function newCount(s, row) {
    const f = filtersOf(row);
    return Number(await s.db.value(newCountSql(), [row.last_seen_at, valueOf.q(f), valueOf.remote(f), valueOf.type(f), valueOf.location(f)]));
}

/** Mark a saved search as looked at (the moment its count stops being "new"). */
const touchSaved = (s, subject, id, at) => s.db.query('UPDATE work_saved_searches SET last_seen_at = $3 WHERE id = $1 AND subject = $2', [id, subject, at]);

/** The query string a saved search runs, for the "run it again" link and the API's search_url. */
function queryOf(row) {
    const params = new URLSearchParams();
    if (row.query) params.set('q', row.query);
    if (row.remote) params.set('remote', row.remote);
    if (row.type) params.set('type', row.type);
    if (row.location) params.set('location', row.location);
    return params.toString();
}

// ── the cursor ──────────────────────────────────────────────
const encodeCursor = (c) => (c ? Buffer.from(JSON.stringify([c.sort_at, c.id]), 'utf8').toString('base64url') : null);
function decodeCursor(v) {
    if (typeof v !== 'string' || !v || v.length > 200) return null;
    try {
        const [at, id] = JSON.parse(Buffer.from(v, 'base64url').toString('utf8'));
        // Both parts go into a SQL comparison; only the two shapes this service writes are accepted.
        if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(at) || !LISTING_ID.test(String(id))) return null;
        return { sort_at: at, id: String(id) };
    } catch { return null; }
}

module.exports = {
    search, facets, getListing, countsBySource, listRecent, recentIds, upsertListings, beginFetch, finishFetch, sourceFetches,
    expire, listSaved, createSaved, getSaved, deleteSaved, newCount, touchSaved, toWire, toSavedWire, filtersOf,
    idOf, encodeCursor, decodeCursor, PAGE_SIZE, MAX_PAGE, MAX_SAVED, LISTING_ID,
};
