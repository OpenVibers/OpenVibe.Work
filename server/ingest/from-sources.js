'use strict';

/**
 * Job boards read through OpenVibe.Sources (plan 2026-10-22, track F; We Work Remotely added 2026-10-30, RemoteOK
 * 2026-11-12).
 *
 * Sources fetches a board (under its robots and terms checks) and keeps each job as an item. Work follows Sources'
 * change feed (openvibe-publishing/ingest: the cursor in work_ingest_cursor, one transaction per page) and keeps one
 * listing per job in work_listings, the row the board's own fetch made (the same id, so the same listing id and URL).
 *
 * Every board that comes this way is one entry of SOURCES below: the Sources key it arrives under, the id Work stores
 * it with, and how a Sources item becomes the parsed row that board's own parse (server/jobs/sources.js) would make.
 * The thin-listing gate (sources.toRow) is the same for all of them: no id, no title, no company or no http(s) link
 * back means the listing is not published.
 *
 * A job Sources retires (the board has not shown it for its own window: retire_after_sec) or removes is expired here,
 * like a listing a board stopped showing. Work's own expiry sweep leaves these listings alone: an unchanged job is no
 * change in Sources' feed, so Work never hears it was seen again, and Sources' retirement is what says it is gone.
 *
 * Pulls 30 seconds after start and then hourly. Remotive is the one board still read by Work itself: its robots.txt
 * disallows /api/*, so Sources may not fetch it, while its API terms explicitly grant a named, linked use.
 */
const ingest = require('openvibe-publishing/ingest');
const sources = require('../jobs/sources');
const { parseHiringLine, TITLE_RULE } = require('../jobs/hiring-line');
const store = require('../jobs/store');

const SOURCE_ID = 'arbeitnow';
const SOURCE_KEY = 'arbeitnow-job-board';
const CURSOR = 'sources.jobs.after';
const EVERY_MS = 60 * 60 * 1000;
const FIRST_MS = 30 * 1000;

const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);

/** A Sources item → the parsed row Work's own Arbeitnow parse makes (server/jobs/sources.js), or null. */
function rawOf(item) {
    const f = (item && item.fields) || {};
    return {
        source_id: item.identity,
        url: item.canonical_url,
        title: item.title,
        company: typeof f.company === 'string' ? f.company.trim() : null,
        location: typeof f.location === 'string' ? f.location.trim() || null : null,
        remote: f.remote === true,
        // Lists arrive with Sources' extra_lists (openvibe-contracts 0.212.0); until then a listing has none.
        tags: list(f.tags),
        job_type: list(f.job_types).join(', ') || null,
        salary: null,                               // this board gives no salary
        posted_at: item.published_at || null,
        description_html: item.summary || '',       // Sources keeps a plain-text excerpt of the description
    };
}

/** The labels We Work Remotely writes in a listing's description, in the order they appear. */
const WWR_LABELS = ['Salary/Compensation', 'Compensation', 'Working Hours', 'Job Title', 'Headquarters', 'Duration', 'Location', 'Responsibilities', 'Requirements', 'Qualifications', 'Benefits', 'Salary', 'About', 'Apply', 'URL'];
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The value of one labelled line in a We Work Remotely description ("Location: Mexico (Remote)"), or null when the
 * listing does not carry it. Sources keeps a plain-text excerpt of the description, so a line further down may simply
 * not be there: an empty value then means "the board did not say", never a guess.
 */
function labelled(text, label) {
    const body = String(text || '');
    const at = new RegExp(`(?:^|[\\s>])${escapeRe(label)}\\s*:`).exec(body);
    if (!at) return null;
    let rest = body.slice(at.index + at[0].length).replace(/^\s*/, '');
    let cut = rest.length;
    for (const other of WWR_LABELS) {
        const m = new RegExp(`\\s${escapeRe(other)}\\s*:`).exec(rest);
        if (m && m.index > 0 && m.index < cut) cut = m.index;
    }
    const value = rest.slice(0, cut).replace(/\s+/g, ' ').trim().replace(/[.;,]$/, '').trim();
    return value ? value.slice(0, 160) : null;
}

/**
 * A Sources item → the parsed row Work's own We Work Remotely parse makes, or null. The board's RSS title is
 * "Company: Position", so the company and the position come from it; the description carries a few labelled lines
 * (location, duration, salary). What the feed does not carry is not invented: a listing without a company is not a
 * listing Work may publish.
 */
function rawOfWwr(item) {
    const f = (item && item.fields) || {};
    const title = String((item && item.title) || '').trim();
    const at = title.indexOf(':');
    const company = at > 0 ? title.slice(0, at).trim() : '';
    const position = at > 0 ? title.slice(at + 1).trim() : title;
    const summary = String((item && item.summary) || '');
    return {
        source_id: item.identity,
        url: item.canonical_url,
        title: position,
        company,
        location: labelled(summary, 'Location'),
        remote: true,                               // the board carries remote work only
        tags: list(f.categories),                  // the feed's <category>, e.g. "Full-Stack Programming"
        job_type: labelled(summary, 'Duration'),
        salary: labelled(summary, 'Salary/Compensation'),
        posted_at: item.published_at || null,
        description_html: summary,
    };
}

/**
 * A Sources item → the row a Hacker News "Who is hiring" comment makes. The resolver's title is the comment's first
 * line, which posters usually write as "Company | Role | Place | Terms | Pay" (or "Company is hiring a role"). Work
 * splits that line into the company, the role(s), the place, the terms and the pay (server/jobs/hiring-line.js), and
 * keeps the line at the front of the description so nothing the poster wrote is lost. A comment that names no company
 * is held by the same thin-listing gate as any other board. The excerpt is Sources' plain-text excerpt, already
 * stripped of email addresses and phone numbers; the full comment is its link.
 */
function rawOfHn(item) {
    const f = (item && item.fields) || {};
    const first = String((item && item.title) || '').replace(/\s+/g, ' ').trim();
    const parsed = parseHiringLine(first);
    const summary = String((item && item.summary) || '');
    // The original line is the listing's description too: Sources starts its excerpt with it, but an excerpt that was
    // cut before the first newline, or a board that sends the fields apart, must not lose it.
    const plain = excerptLines(summary);
    const description = plain.startsWith(first) ? summary : `${first}\n${summary}`;
    return {
        source_id: item.identity,
        url: item.canonical_url,
        title: parsed.title,
        company: parsed.company,
        location: parsed.location,
        remote: parsed.remote,
        tags: list([...list(f.tags), ...parsed.tags]),
        job_type: parsed.job_type,
        salary: parsed.salary,
        posted_at: item.published_at || null,
        description_html: description,
        title_rule: TITLE_RULE,
    };
}

/** The start of a plain-text summary, with whitespace collapsed, for comparing it with the comment's first line. */
const excerptLines = (text) => String(text || '').replace(/\s+/g, ' ').trim();

/** A salary bound as RemoteOK gives it (a number), or null; never a guess from a missing field. */
const amount = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

/**
 * A Sources item → the parsed row Work's own RemoteOK parse makes (server/jobs/sources.js): the board's id and URL,
 * its position as the title, and its salary bounds written the way the board's own fetch wrote them. Sources has
 * already turned the HTML description into a short plain-text excerpt, which is all Work stores.
 */
function rawOfRemoteOk(item) {
    const f = (item && item.fields) || {};
    const min = amount(f.salary_min);
    const max = amount(f.salary_max);
    return {
        source_id: item.identity,
        url: item.canonical_url,
        title: item.title,
        company: typeof f.company === 'string' ? f.company.trim() : null,
        location: typeof f.location === 'string' ? f.location.trim() || null : null,
        remote: true,                               // the board carries remote work only
        tags: list(f.tags),
        job_type: typeof f.job_type === 'string' ? f.job_type.trim() || null : null,
        salary: min && max ? `$${min.toLocaleString('en-US')}–$${max.toLocaleString('en-US')} a year` : null,
        posted_at: item.published_at || null,
        description_html: item.summary || '',
    };
}

/**
 * The boards Work reads through OpenVibe.Sources: the Sources key an item arrives under, the id the listing is
 * stored with, the kind of item that source keeps, and how the item becomes a listing.
 */
const SOURCES = {
    [SOURCE_KEY]: { source_id: SOURCE_ID, kind: 'job', rawOf },
    'weworkremotely': { source_id: 'weworkremotely', kind: 'article', rawOf: rawOfWwr },
    'hn-whoishiring': { source_id: 'hn-whoishiring', kind: 'job', rawOf: rawOfHn },
    'remoteok-job-board': { source_id: 'remoteok', kind: 'job', rawOf: rawOfRemoteOk },
};

function createFromSources({ config, s, fetchImpl = globalThis.fetch, log = console, source = null, afterRun = null, indexnow = null }) {
    const url = String((config.sources && config.sources.internalUrl) || '').replace(/\/+$/, '');
    // Every board in SOURCES is read through Sources; each keeps its own listing id.
    const active = Object.entries(SOURCES);
    const activeByKey = Object.fromEntries(active);
    const client = source || (url && config.oauth.clientSecret
        ? ingest.createSourcesClient({ config: { ...config, sources: { internalUrl: url, category: 'jobs' } }, fetchImpl })
        : null);
    const cursor = ingest.createChangeCursor(s.db, { prefix: 'work', now: s.now });
    let timer = null;
    let first = null;
    let running = false;
    let addedIds = [];

    async function apply(item, t) {
        const entry = item && activeByKey[item.source_key];
        if (!entry || item.kind !== entry.kind) return 'hold';
        if (item.removed) {
            await store.expireListing(t, entry.source_id, item.identity);
            return 'removed';
        }
        const fetchedAt = (item.provenance && item.provenance.retrieved_at) || s.iso();
        const row = sources.toRow(entry.rawOf(item), { sourceId: entry.source_id, fetchedAt, idOf: store.idOf });
        if (!row) return 'hold';
        if (await store.upsertListing(t, row, fetchedAt)) addedIds.push(row.id);
        return 'applied';
    }

    /** Follow Sources' change feed to its end and record it as each board's fetch. Never throws. */
    async function pull() {
        if (!client || running) return { skipped: true };
        running = true;
        const startedAt = s.iso();
        addedIds = [];
        const ids = active.map(([, e]) => e.source_id);
        try {
            for (const id of ids) await store.beginFetch(s, id, startedAt);
            const out = await ingest.pullChanges({ db: s.db, cursor, source: client, name: CURSOR, apply });
            for (const id of ids) {
                const listings = await store.liveCount(s, id);
                await store.finishFetch(s, id, { ok: true, listings, error: null, finishedAt: s.iso() });
            }
            if (out.applied || out.removed) {
                for (const id of ids) {
                    const name = (sources.byId(id) || {}).name || id;
                    log.log(`[Ingest] ${name} through OpenVibe.Sources: ${out.applied} listings updated, ${out.removed} gone (cursor ${out.after})`);
                }
                // As after a board read: search engines hear about new listing pages, and Search catches up.
                if (indexnow && addedIds.length) indexnow.pingSoon([...addedIds.map((id) => `${config.baseUrl}/jobs/${encodeURIComponent(id)}`), `${config.baseUrl}/sitemap.xml`]);
                if (afterRun) afterRun();
            }
            return out;
        } catch (err) {
            const detail = String((err && err.message) || err).slice(0, 300);
            for (const id of ids) {
                await store.finishFetch(s, id, { ok: false, listings: await store.liveCount(s, id).catch(() => 0), error: detail, finishedAt: s.iso() }).catch(() => {});
            }
            log.warn(`[Ingest] Jobs through OpenVibe.Sources failed: ${detail}`);
            return { error: detail };
        } finally { running = false; }
    }

    function start() {
        if (!client || timer) return false;
        first = setTimeout(() => { pull().catch(() => {}); }, FIRST_MS);
        first.unref();
        timer = setInterval(() => { pull().catch(() => {}); }, EVERY_MS);
        timer.unref();
        log.log(`[Ingest] Jobs come from OpenVibe.Sources (${active.map(([, e]) => e.source_id).join(', ')})`);
        return true;
    }

    function stop() {
        clearTimeout(first);
        clearInterval(timer);
        first = null;
        timer = null;
    }

    return { enabled: Boolean(client), pull, start, stop, apply, SOURCE_ID, sourceIds: active.map(([, e]) => e.source_id) };
}

module.exports = { createFromSources, rawOf, rawOfWwr, rawOfHn, rawOfRemoteOk, SOURCES, SOURCE_ID, SOURCE_KEY, TITLE_RULE };
