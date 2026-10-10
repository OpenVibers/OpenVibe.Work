'use strict';

/**
 * Work's listing pages in OpenVibe.Search (openvibe-publishing/search-feed): one search.index-document@1 per job page
 * (/jobs/<id>), sent as work.index_document.upserted|deleted through this service's events outbox. A listing that
 * expired (its page answers 404) becomes a tombstone. The document carries what the page shows of a listing (title,
 * company, location, tags, salary text, the short excerpt) and names the board it came from as provenance, with the
 * original listing's URL: the attribution the boards' terms ask for travels with the document.
 *
 * Listings change in bulk (an ingest run upserts a board's whole page), so Search is brought level by a sweep: after
 * every ingest run, once a few seconds after boot and every hour. The sweep re-sends only what changed (the sequencer
 * in work_index_revisions gives an unchanged document its old revision), so a quiet hour sends nothing.
 *
 *   const search = createSearchIndex({ config, s, log });   // outbox: the relay is off until the events URL and the
 *   search.start(); search.sweep(); search.stop();            // OAuth client secret are set; rows wait meanwhile
 */
const { createServiceOutbox } = require('openvibe-sdk/events');
const { createSearchFeed } = require('openvibe-publishing/search-feed');
const sources = require('./jobs/sources');
const listing = require('./render/listing');

const EVENT_TYPES = ['work.index_document.upserted', 'work.index_document.deleted'];
const START_DELAY_MS = 60_000;
const INTERVAL_MS = 3_600_000;

/** One listing row → what its page shows, as search-feed's document description. */
function describe(row) {
    const l = listing.meta(row);
    const src = sources.byId(row.source);
    const where = [l.location, l.remote ? 'remote' : '', l.job_type].filter(Boolean).join(' · ');
    const excerpt = listing.plainExcerpt(row);
    return {
        listed: !row.expired,
        title: `${l.title} at ${l.company}`,
        summary: [where, l.salary].filter(Boolean).join(' · ') || excerpt.slice(0, 200) || null,
        body: [l.title, l.company, where, l.tags.join(', '), l.salary, excerpt].filter(Boolean).join('\n'),
        facets: { source: row.source, remote: l.remote, type: l.job_type || null, location: l.location || null },
        authorship: { mode: 'imported' },
        provenance: [{
            service: 'work', type: 'board_listing', id: `${row.source}:${row.source_id}`.slice(0, 128),
            label: src ? src.name : row.source, url: row.url, retrievedAt: row.fetched_at,
        }],
        publishedAt: row.posted_at || row.first_seen_at,
        updatedAt: row.fetched_at,
    };
}

function createSearchIndex({ config, s, log = console, outbox = null }) {
    const out = outbox || createServiceOutbox({
        db: s.db, source: 'work', eventsUrl: config.events.url || null, networkInternalUrl: config.networkInternalUrl,
        clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, log, eventTypes: EVENT_TYPES,
    });
    const feed = createSearchFeed({
        owner: 'work', db: s.db, outbox: out, baseUrl: config.baseUrl, now: s.now, log,
        types: {
            job: {
                page: (row) => `/jobs/${row.id}`,
                document: describe,
                rows: (after, limit) => s.db.many('SELECT * FROM work_listings WHERE id > $1 ORDER BY id LIMIT $2', [after, limit]),
                exists: async (ids) => (await s.db.many('SELECT id FROM work_listings WHERE id = ANY($1)', [ids])).map((r) => r.id),
            },
        },
    });
    const timers = [];

    async function sweep() {
        const res = await feed.sweep();
        const j = res.job;
        if (j.sent || j.removed || j.failed) log.log(`[Search] listings: ${j.sent} sent, ${j.removed} removed, ${j.failed} failed of ${j.seen}`);
        out.kick && out.kick().catch(() => {});
        return res;
    }
    const quietly = () => { sweep().catch((err) => log.warn(`[Search] sweep failed: ${(err && err.message) || err}`)); };

    function start() {
        if (timers.length) return false;
        out.start();
        const kick = setTimeout(quietly, START_DELAY_MS);
        kick.unref();
        const tick = setInterval(quietly, INTERVAL_MS);
        tick.unref();
        timers.push(kick, tick);
        return true;
    }

    function stop() {
        for (const t of timers.splice(0)) { clearTimeout(t); clearInterval(t); }
        out.stop();
    }

    return { feed, outbox: out, describe, sweep, afterIngest: quietly, start, stop, status: () => out.status() };
}

module.exports = { createSearchIndex, describe, EVENT_TYPES };
