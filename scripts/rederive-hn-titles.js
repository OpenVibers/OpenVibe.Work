#!/usr/bin/env node
'use strict';

/**
 * Re-derive the stored Hacker News "Who is hiring" listings whose title is still the board's whole pipe-separated
 * line (server/jobs/rederive-hn-titles.js). One-off: the ingest writes the split title from now on.
 *
 *   node scripts/rederive-hn-titles.js            show what would change (first 20), write nothing
 *   node scripts/rederive-hn-titles.js --apply    write it, then sweep Search with the changed documents
 *
 * It runs with the service's own environment and connection, like scripts/ingest.js. It reads only source
 * 'hn-whoishiring' and only rows without the title_rule marker, so running it twice is harmless.
 */
const configLib = require('../server/config');
const { openStore } = require('../server/db');
const { rederiveHnTitles } = require('../server/jobs/rederive-hn-titles');

(async () => {
    const apply = process.argv.includes('--apply');
    const config = configLib.load();
    const s = await openStore(config, { log: console });
    try {
        const out = await rederiveHnTitles({ s, config, apply, log: console });
        for (const sample of out.samples) {
            process.stdout.write(`  ${sample.id}\n    was: ${sample.before}\n    now: ${sample.after}\n`);
        }
        if (out.sent) process.stdout.write(`  Search: ${out.sent.sent} sent, ${out.sent.removed} removed, ${out.sent.failed} failed of ${out.sent.seen}\n`);
        process.stdout.write(`${apply ? 'Applied' : 'Dry run'}: ${out.changed} of ${out.scanned} listing(s) change, ${out.skipped} left alone (no company)\n`);
        if (!apply) process.stdout.write('Nothing was written. Run with --apply to write it.\n');
    } finally {
        await s.close();
    }
})().catch((err) => { console.error('[OpenVibe.Work] re-derive failed:', err && err.message ? err.message : err); process.exit(1); });
