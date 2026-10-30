'use strict';

/**
 * Job boards read through OpenVibe.Sources (plan 2026-10-22, track F2; We Work Remotely added 2026-10-30).
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
 * A job Sources retires (the board has not shown it for a week: retire_after_sec) or removes is expired here, like a
 * listing a board stopped showing. Work's own expiry sweep leaves these listings alone: an unchanged job is no change in
 * Sources' feed, so Work never hears it was seen again, and Sources' retirement is what says it is gone.
 *
 * Pulls 30 seconds after start and then hourly. Each board has its own switch (WORK_ARBEITNOW_FROM=sources,
 * WORK_WWR_FROM=sources); a board that is not switched on is left to its own fetch, as before.
 */
const ingest = require('openvibe-publishing/ingest');
const sources = require('../jobs/sources');
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
 * The boards Work reads through OpenVibe.Sources: the Sources key an item arrives under, the id the listing is
 * stored with, the kind of item that source keeps, and how the item becomes a listing.
 */
const SOURCES = {
    [SOURCE_KEY]: { source_id: SOURCE_ID, kind: 'job', rawOf },
    'weworkremotely': { source_id: 'weworkremotely', kind: 'article', rawOf: rawOfWwr },
};

/** The switch that says a board comes from Sources instead of from its own fetch. */
const SWITCH = {
    arbeitnow: (config) => (config.sources && config.sources.arbeitnowFrom) === 'sources',
    weworkremotely: (config) => (config.sources && config.sources.weworkremotelyFrom) === 'sources',
};

function createFromSources({ config, s, fetchImpl = globalThis.fetch, log = console, source = null, afterRun = null, indexnow = null }) {
    const url = String((config.sources && config.sources.internalUrl) || '').replace(/\/+$/, '');
    // The boards that are switched on and therefore read through Sources. Each keeps its own listing id.
    const active = Object.entries(SOURCES).filter(([, e]) => (SWITCH[e.source_id] || (() => false))(config));
    const activeByKey = Object.fromEntries(active);
    const on = active.length > 0;
    const client = source || (on && url && config.oauth.clientSecret
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

module.exports = { createFromSources, rawOf, rawOfWwr, SOURCES, SOURCE_ID, SOURCE_KEY };
