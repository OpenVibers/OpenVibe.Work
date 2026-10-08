'use strict';

/**
 * The background ingest: every six hours, read each job board's public API (server/jobs/sources.js), keep what it
 * shows and retire what it stopped showing.
 *
 * It is off unless WORK_INGEST=on, so neither a test nor a development run ever calls a job board; when it is on,
 * each source keeps its own timer, its own last-fetch row and its own failures — one board being down never stops the
 * others, and the failure is recorded and shown on /sources rather than hidden.
 *
 * Every outbound request goes to a base URL from the configuration (never to a URL anyone typed), with this
 * service's User-Agent, a 15-second timeout and a size cap, and only http(s).
 */
const sources = require('../jobs/sources');
const store = require('../jobs/store');

const MAX_BYTES = 8 * 1024 * 1024;
const START_DELAY_MS = 5_000;

async function fetchJson(url, { fetchImpl, timeoutMs, userAgent }) {
    let res;
    try {
        res = await fetchImpl(url, {
            headers: { 'user-agent': userAgent, accept: 'application/json' },
            redirect: 'follow',
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (err) {
        throw new Error(err && err.name === 'TimeoutError' ? `no answer in ${Math.round(timeoutMs / 1000)}s` : 'could not be reached');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} from the board`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error('the board answered with more than 8 MB');
    try { return JSON.parse(text); } catch { throw new Error('the board answered with something that is not JSON'); }
}

function createIngest({ config, s, fetchImpl = globalThis.fetch, log = console }) {
    const timers = new Map();
    let running = false;

    /** Read one source end to end and record what happened. Never throws: the caller is a timer. */
    async function runSource(sourceId) {
        const source = sources.byId(sourceId);
        if (!source) throw new Error(`no source ${sourceId}`);
        const startedAt = s.iso();
        const fetchedAt = startedAt;
        await store.beginFetch(s, source.id, startedAt);
        let listings = 0;
        try {
            const seen = new Map();
            for (const url of source.requests(config)) {
                const json = await fetchJson(url, { fetchImpl, timeoutMs: config.ingest.timeoutMs, userAgent: config.ingest.userAgent });
                for (const raw of source.parse(json)) {
                    const row = sources.toRow(raw, { sourceId: source.id, fetchedAt, idOf: store.idOf });
                    // Two pages can carry the same listing; the later one wins, exactly as the board would show it.
                    if (row) seen.set(row.source_id, row);
                }
            }
            const rows = [...seen.values()];
            const out = await store.upsertListings(s, rows, { sourceId: source.id, fetchedAt });
            listings = out.seen;
            await store.finishFetch(s, source.id, { ok: true, listings, error: null, finishedAt: s.iso() });
            log.log(`[Ingest] ${source.name}: ${listings} listings (${out.added} new, ${out.updated} updated)`);
            return { ok: true, listings, added: out.added, updated: out.updated, rows };
        } catch (err) {
            const detail = (err && err.message) || String(err);
            await store.finishFetch(s, source.id, { ok: false, listings, error: detail, finishedAt: s.iso() });
            log.warn(`[Ingest] ${source.name} failed: ${detail}`);
            return { ok: false, error: detail, listings };
        }
    }

    /** Every source, then the expiry sweep: a listing no board has shown for the retention window goes. */
    async function runAll() {
        if (running) return [];
        running = true;
        try {
            const out = [];
            for (const source of sources.SOURCES) out.push({ source: source.id, ...(await runSource(source.id)) });
            try {
                const gone = await store.expire(s, config.ingest.retentionDays, s.now());
                if (gone) log.log(`[Ingest] expired ${gone} listings not seen for ${config.ingest.retentionDays} days`);
            } catch (err) {
                log.warn(`[Ingest] expiry failed: ${(err && err.message) || err}`);
            }
            return out;
        } finally { running = false; }
    }

    /**
     * Start the timers: one per source, so a slow board delays only itself. The first run waits a few seconds so it
     * never competes with the process starting up or with a deploy's readiness check.
     */
    function start() {
        if (!config.ingest.enabled || timers.size) return false;
        for (const source of sources.SOURCES) {
            const timer = setInterval(() => { runSource(source.id).catch(() => {}); }, config.ingest.intervalMs);
            timer.unref();
            timers.set(source.id, timer);
        }
        const kick = setTimeout(() => { runAll().catch(() => {}); }, START_DELAY_MS);
        kick.unref();
        timers.set('start', kick);
        log.log(`[Ingest] on: ${sources.ids().join(', ')} every ${Math.round(config.ingest.intervalMs / 3_600_000)}h`);
        return true;
    }

    function stop() {
        for (const timer of timers.values()) clearInterval(timer);
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
    }

    return { start, stop, runSource, runAll, timers };
}

module.exports = { createIngest };
