'use strict';

/**
 * Arbeitnow through OpenVibe.Sources (plan 2026-10-22, track F2). With WORK_ARBEITNOW_FROM=sources, Work stops reading
 * Arbeitnow's board itself: Sources fetches it (pages 1-3 every six hours, under its robots and terms checks) and keeps
 * each job as an item (source arbeitnow-job-board, category jobs). Work follows Sources' change feed
 * (openvibe-publishing/ingest: the cursor in work_ingest_cursor, one transaction per page) and keeps one listing per job
 * in work_listings, source 'arbeitnow', the row its own fetch made (the same slug, so the same listing id and URL).
 *
 * A job Sources retires (the board has not shown it for a week: retire_after_sec) or removes is expired here, like a
 * listing a board stopped showing. Work's own expiry sweep leaves these listings alone: an unchanged job is no change in
 * Sources' feed, so Work never hears it was seen again, and Sources' retirement is what says it is gone.
 *
 * Pulls 30 seconds after start and then hourly. Off unless WORK_ARBEITNOW_FROM=sources with OV_SOURCES_INTERNAL_URL and
 * the OAuth client secret (a test passes its own source).
 */
const ingest = require('openvibe-publishing/ingest');
const sources = require('../jobs/sources');
const store = require('../jobs/store');

const SOURCE_ID = 'arbeitnow';
const SOURCE_KEY = 'arbeitnow-job-board';
const CURSOR = 'sources.jobs.after';
const EVERY_MS = 60 * 60 * 1000;
const FIRST_MS = 30 * 1000;

/** A Sources item → the parsed row Work's own Arbeitnow parse makes (server/jobs/sources.js), or null. */
function rawOf(item) {
    const f = (item && item.fields) || {};
    const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);
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

function createFromSources({ config, s, fetchImpl = globalThis.fetch, log = console, source = null, afterRun = null, indexnow = null }) {
    const url = String((config.sources && config.sources.internalUrl) || '').replace(/\/+$/, '');
    const on = config.sources && config.sources.arbeitnowFrom === 'sources';
    const client = source || (on && url && config.oauth.clientSecret
        ? ingest.createSourcesClient({ config: { ...config, sources: { internalUrl: url, category: 'jobs' } }, fetchImpl })
        : null);
    const cursor = ingest.createChangeCursor(s.db, { prefix: 'work', now: s.now });
    let timer = null;
    let first = null;
    let running = false;
    let addedIds = [];

    async function apply(item, t) {
        if (!item || item.source_key !== SOURCE_KEY || item.kind !== 'job') return 'hold';
        if (item.removed) {
            await store.expireListing(t, SOURCE_ID, item.identity);
            return 'removed';
        }
        const fetchedAt = (item.provenance && item.provenance.retrieved_at) || s.iso();
        const row = sources.toRow(rawOf(item), { sourceId: SOURCE_ID, fetchedAt, idOf: store.idOf });
        if (!row) return 'hold';
        if (await store.upsertListing(t, row, fetchedAt)) addedIds.push(row.id);
        return 'applied';
    }

    /** Follow Sources' change feed to its end and record it as Arbeitnow's fetch. Never throws. */
    async function pull() {
        if (!client || running) return { skipped: true };
        running = true;
        const startedAt = s.iso();
        addedIds = [];
        try {
            await store.beginFetch(s, SOURCE_ID, startedAt);
            const out = await ingest.pullChanges({ db: s.db, cursor, source: client, name: CURSOR, apply });
            const listings = await store.liveCount(s, SOURCE_ID);
            await store.finishFetch(s, SOURCE_ID, { ok: true, listings, error: null, finishedAt: s.iso() });
            if (out.applied || out.removed) {
                log.log(`[Ingest] Arbeitnow through OpenVibe.Sources: ${out.applied} listings updated, ${out.removed} gone (cursor ${out.after})`);
                // As after a board read: search engines hear about new listing pages, and Search catches up.
                if (indexnow && addedIds.length) indexnow.pingSoon([...addedIds.map((id) => `${config.baseUrl}/jobs/${encodeURIComponent(id)}`), `${config.baseUrl}/sitemap.xml`]);
                if (afterRun) afterRun();
            }
            return out;
        } catch (err) {
            const detail = String((err && err.message) || err).slice(0, 300);
            await store.finishFetch(s, SOURCE_ID, { ok: false, listings: await store.liveCount(s, SOURCE_ID).catch(() => 0), error: detail, finishedAt: s.iso() }).catch(() => {});
            log.warn(`[Ingest] Arbeitnow through OpenVibe.Sources failed: ${detail}`);
            return { error: detail };
        } finally { running = false; }
    }

    function start() {
        if (!client || timer) return false;
        first = setTimeout(() => { pull().catch(() => {}); }, FIRST_MS);
        first.unref();
        timer = setInterval(() => { pull().catch(() => {}); }, EVERY_MS);
        timer.unref();
        log.log('[Ingest] Arbeitnow comes from OpenVibe.Sources (arbeitnow-job-board)');
        return true;
    }

    function stop() {
        clearTimeout(first);
        clearInterval(timer);
        first = null;
        timer = null;
    }

    return { enabled: Boolean(client), pull, start, stop, apply, SOURCE_ID };
}

module.exports = { createFromSources, rawOf, SOURCE_ID, SOURCE_KEY };
