#!/usr/bin/env node
'use strict';

/**
 * Read every job board once, right now, and exit — the same work the timer does (server/ingest/), for an operator who
 * wants the listings without waiting for the next interval, or wants to see what a board answers.
 *
 *   node scripts/ingest.js              every source
 *   node scripts/ingest.js arbeitnow    one source
 *
 * It is not gated on WORK_INGEST: running it by hand is the point. It still only fetches the configured base URLs.
 */
const configLib = require('../server/config');
const { openStore } = require('../server/db');
const { createIngest } = require('../server/ingest');

(async () => {
    const config = configLib.load();
    const s = await openStore(config, { log: console });
    const ingest = createIngest({ config, s, log: console });
    try {
        const want = process.argv.slice(2);
        const out = want.length
            ? await Promise.all(want.map((id) => ingest.runSource(id)))
            : await ingest.runAll();
        for (const r of out) {
            process.stdout.write(`${r.ok ? 'ok  ' : 'FAIL'} ${r.source || ''}: ${r.listings} listing(s)${r.error ? ` — ${r.error}` : ''}\n`);
        }
        process.exitCode = out.every((r) => r.ok) ? 0 : 1;
    } finally {
        await s.close();
    }
})().catch((err) => { console.error('[OpenVibe.Work] ingest failed:', err && err.message ? err.message : err); process.exit(1); });
