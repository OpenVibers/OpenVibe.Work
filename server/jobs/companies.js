'use strict';

/**
 * Companies: every company with open listings, and one page each (/companies, /companies/:slug). A company is its name
 * as the boards write it, grouped by its slug, so "ACME" and "Acme" are one company; the name shown is the spelling
 * most of its listings use.
 *
 * The slug is computed the same way here and in SQL (SLUG_SQL), so a page finds its rows without a stored column:
 * lower case, common accented letters to their plain ones (ä → a, ß → s), every other run of characters to one dash.
 * A name with no letter or digit left (only CJK, say) has no slug and no page; its listings stay in the search.
 */

const { mergePlaces } = require('./places');

// translate() pairs, one character each side: what the slug folds an accented letter to.
const FOLD = [['äàáâãåā', 'a'], ['çćč', 'c'], ['ďđ', 'd'], ['ëèéêē', 'e'], ['ğ', 'g'], ['ïìíîī', 'i'], ['ł', 'l'], ['ñńň', 'n'],
    ['öòóôõøō', 'o'], ['řŕ', 'r'], ['ßśšş', 's'], ['ťţ', 't'], ['üùúûůū', 'u'], ['ýÿ', 'y'], ['źżž', 'z'], ['æ', 'a'], ['œ', 'o']];
const FROM = FOLD.map(([from]) => from).join('');
const TO = FOLD.map(([from, to]) => to.repeat([...from].length)).join('');
const FOLD_MAP = new Map([...FROM].map((c, i) => [c, TO[i]]));
const MAX_SLUG = 80;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

/** A company name → its slug, or '' (the same answer as SLUG_SQL). */
function slugOf(name) {
    const folded = [...String(name == null ? '' : name).toLowerCase()].map((c) => FOLD_MAP.get(c) || c).join('');
    return folded.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_SLUG).replace(/-+$/g, '');
}

/** The same slug in SQL; $1 and $2 are FROM and TO. */
const SLUG_SQL = "rtrim(left(trim(both '-' from regexp_replace(translate(lower(company), $1, $2), '[^a-z0-9]+', '-', 'g')), 80), '-')";

const num = (v) => (v == null ? 0 : Number(v));
const TTL_MS = 10 * 60 * 1000;
const lists = new WeakMap();   // store → { at, value }

/** Every company with an open listing, most openings first: [{ slug, company, count, remote }]. Cached ten minutes. */
async function list(s, { now = Date.now() } = {}) {
    const hit = lists.get(s);
    if (hit && now - hit.at < TTL_MS) return hit.value;
    const rows = await s.db.many(
        `SELECT ${SLUG_SQL} AS slug, mode() WITHIN GROUP (ORDER BY company) AS company, count(*) AS n, count(*) FILTER (WHERE remote) AS remote
           FROM work_listings WHERE expired = false GROUP BY 1 HAVING ${SLUG_SQL} <> '' ORDER BY n DESC, slug ASC`, [FROM, TO]);
    const value = rows.map((r) => ({ slug: r.slug, company: r.company, count: num(r.n), remote: num(r.remote) }));
    lists.set(s, { at: now, value });
    return value;
}

/**
 * One company's open listings, newest first (up to `limit`), with where they are and which boards list them, or null.
 * → { slug, company, count, remote, salaried, places: [{ place, count }], sources: [{ source, count }], rows }
 */
async function bySlug(s, slug, { limit = 60 } = {}) {
    if (!SLUG_RE.test(String(slug || ''))) return null;
    const where = `expired = false AND ${SLUG_SQL} = $3`;
    const args = [FROM, TO, String(slug)];
    const totals = await s.db.maybe(
        `SELECT count(*) AS n, count(*) FILTER (WHERE remote) AS remote, count(*) FILTER (WHERE coalesce(salary, '') <> '') AS salaried,
                mode() WITHIN GROUP (ORDER BY company) AS company FROM work_listings WHERE ${where}`, args);
    if (!totals || !num(totals.n)) return null;
    const [places, bySource, rows] = await Promise.all([
        s.db.many(`SELECT trim(split_part(location, ',', 1)) AS p, count(*) AS n FROM work_listings WHERE ${where} AND coalesce(location, '') <> ''
                    GROUP BY 1 ORDER BY n DESC, p ASC LIMIT 40`, args),
        s.db.many(`SELECT source, count(*) AS n FROM work_listings WHERE ${where} GROUP BY 1 ORDER BY n DESC, source ASC`, args),
        s.db.many(`SELECT * FROM work_listings WHERE ${where} ORDER BY sort_at DESC, id DESC LIMIT ${Math.min(200, Math.max(1, Number(limit) || 60))}`, args),
    ]);
    return {
        slug: String(slug), company: totals.company, count: num(totals.n), remote: num(totals.remote), salaried: num(totals.salaried),
        // One city once, however the boards spell it (server/jobs/places.js).
        places: mergePlaces(places).slice(0, 12),
        sources: bySource.map((r) => ({ source: r.source, count: num(r.n) })),
        rows,
    };
}

function _reset() { /* WeakMap entries go with their store */ }

module.exports = { slugOf, list, bySlug, SLUG_SQL, FROM, TO, _reset };
