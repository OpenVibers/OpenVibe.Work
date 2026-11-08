'use strict';
/**
 * A search page counted its listings three times per request (the exact match count, the remote facet and the
 * job-type facet); on 2026-11-08 those three scans were 256 s, 240 s and 233 s of database time in 22 h. The
 * counts are now kept for COUNTS_MS in production (server/jobs/store.js kept), keyed by the filters. This
 * proves a repeated search reads the counts once, a changed filter reads them again, and the keep expires.
 */
process.env.WORK_COUNTS_CACHE_MS = '60000';
const assert = require('assert');
const { search, kept } = require('../server/jobs/store');

(async () => {
    let t = 0;
    try {
        const calls = { value: 0, many: 0 };
        const s = {
            db: {
                value: async () => { calls.value += 1; return 0; },
                many: async () => { calls.many += 1; return []; },
            },
        };
        await search(s, { q: 'nurse', location: 'berlin' });
        assert.deepStrictEqual(calls, { value: 1, many: 3 }, 'one count, two facet reads and the page on the first request');
        await search(s, { q: 'nurse', location: 'berlin' });
        assert.deepStrictEqual(calls, { value: 1, many: 4 }, 'the same filters reuse both counts; only the rows are read again');
        await search(s, { q: 'nurse', location: 'munich' });
        assert.strictEqual(calls.value, 2, 'a changed filter counts again');
        assert.strictEqual(calls.many, 7, 'and reads both facets and the page again');
    } finally {
        delete process.env.WORK_COUNTS_CACHE_MS;
    }

    // The helper itself: in-flight callers share one read, the window is the keep, and a failure is not kept.
    let reads = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const read = async () => { reads += 1; await gate; return 7; };
    const [a, b] = [kept('t|in-flight', read, 60_000, () => t), kept('t|in-flight', read, 60_000, () => t)];
    release();
    assert.deepStrictEqual(await Promise.all([a, b]), [7, 7]);
    assert.strictEqual(reads, 1, 'callers at the same moment share one read');
    assert.strictEqual(await kept('t|in-flight', async () => { reads += 1; return 8; }, 60_000, () => t), 7, 'within the window: kept');
    t = 60_000;
    assert.strictEqual(await kept('t|in-flight', async () => { reads += 1; return 8; }, 60_000, () => t), 8, 'past the window: read again');
    assert.strictEqual(reads, 2);
    let failed = 0;
    await assert.rejects(() => kept('t|fail', async () => { failed += 1; throw new Error('boom'); }, 60_000, () => t));
    await assert.rejects(() => kept('t|fail', async () => { failed += 1; throw new Error('boom'); }, 60_000, () => t));
    assert.strictEqual(failed, 2, 'a failed read is not kept');
    console.log('ok - search counts are kept per filter and window');
})().catch((err) => { console.error(err); process.exit(1); });
