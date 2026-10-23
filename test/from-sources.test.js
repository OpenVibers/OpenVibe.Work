'use strict';
/**
 * Arbeitnow through OpenVibe.Sources (server/ingest/from-sources.js; plan 2026-10-22, track F2), against a Sources
 * stand-in serving its change feed:
 *   - each job item becomes the listing Work's own fetch made (same slug → same id and URL), with its excerpt, tags and
 *     job types; other sources' items and jobs Work may not publish are held;
 *   - the board is no longer read, and Work's expiry sweep leaves these listings to Sources;
 *   - a job Sources retires (gone_from_source) expires here; the fetch record says what came through;
 *   - without WORK_ARBEITNOW_FROM=sources nothing changes.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const store = require('../server/jobs/store');
const { createFromSources } = require('../server/ingest/from-sources');

const DAY = 86_400_000;
const feed = [];
let seq = 0;
function push(item) { feed.push({ ...item, change_seq: ++seq }); }
const sourcesClient = {
    enabled: true,
    async listItems({ after = 0, limit = 100 } = {}) {
        const page = feed.filter((i) => i.change_seq > after).slice(0, limit);
        return { items: page, next_after: page.length ? page[page.length - 1].change_seq : after, more: false };
    },
};
const job = (identity, over = {}) => ({
    id: `itm_${identity}`, source_key: 'arbeitnow-job-board', category: 'jobs', kind: 'job', identity,
    canonical_url: `https://www.arbeitnow.com/jobs/companies/acme/${identity}`, title: 'Backend Developer', summary: 'We build payment rails. Node.js and PostgreSQL.',
    authors: [], published_at: '2026-10-20T08:00:00.000Z', source_updated_at: null,
    fields: { company: 'Acme GmbH', location: 'Berlin', remote: false, tags: ['Node.js', 'PostgreSQL'], job_types: ['full time'] },
    revision: 1, provenance: { retrieved_at: '2026-10-22T06:00:00.000Z' }, removed: null, ...over,
});

(async () => {
    const clock = { t: Date.parse('2026-10-23T06:00:00Z') };
    const pinged = [];
    const indexnow = { enabled: false, pingSoon: (urls) => { pinged.push(...urls); return urls.length; } };
    const t = await boot({ now: () => clock.t, env: { WORK_ARBEITNOW_FROM: 'sources' }, sourcesClient, indexnow });
    const s = t.ctx.s;
    const from = t.ctx.fromSources;

    try {
        await check('each job item becomes the listing the board fetch made; others are held', async () => {
            push(job('backend-developer-berlin-123'));
            // Before Sources maps lists (contracts 0.212.0) an item has none: the listing has no tags or job type.
            push(job('ops-engineer-remote-456', { title: 'Ops Engineer', summary: 'Keep our clusters healthy.', fields: { company: 'Beta AG', location: 'Remote', remote: true } }));
            push(job('no-company-789', { fields: { location: 'Munich' } }));
            push({ ...job('remotive-1'), source_key: 'remotive-feed' });
            const out = await from.pull();
            assert.deepStrictEqual([out.applied, out.hold, out.removed], [2, 2, 0]);

            const id = store.idOf('arbeitnow', 'backend-developer-berlin-123');
            const row = await s.db.maybe('SELECT * FROM work_listings WHERE id = $1', [id]);
            assert.deepStrictEqual([row.source, row.title, row.company, row.location, row.remote, row.tags, row.job_type, row.expired],
                ['arbeitnow', 'Backend Developer', 'Acme GmbH', 'Berlin', false, 'Node.js, PostgreSQL', 'full time', false]);
            assert.strictEqual(row.excerpt, 'We build payment rails. Node.js and PostgreSQL.');
            assert.strictEqual(row.url, 'https://www.arbeitnow.com/jobs/companies/acme/backend-developer-berlin-123');
            const ops = await s.db.maybe('SELECT tags, job_type, remote FROM work_listings WHERE source_id = $1', ['ops-engineer-remote-456']);
            assert.deepStrictEqual([ops.tags, ops.job_type, ops.remote], ['', null, true]);
            assert.ok(pinged.includes(`https://openvibe.work/jobs/${id}`), 'search engines hear about the new listing page');

            const page = (await t.get('/api/v1/jobs?q=payment')).json();
            assert.deepStrictEqual(page.jobs.map((j) => [j.id, j.source]), [[id, 'arbeitnow']]);
        });

        await check('the fetch record says the listings came through', async () => {
            const rec = (await store.sourceFetches(s)).get('arbeitnow');
            assert.deepStrictEqual([rec.ok, rec.listings, rec.error], [true, 2, null]);
        });

        await check('the board is not read, and the expiry sweep leaves these listings to Sources', async () => {
            const out = await t.ctx.ingest.runAll();
            assert.deepStrictEqual(out.find((o) => o.source === 'arbeitnow'), { source: 'arbeitnow', skipped: 'from_sources' });
            clock.t += 60 * DAY;
            await t.ctx.ingest.runAll();
            const live = await s.db.many("SELECT source_id FROM work_listings WHERE source = 'arbeitnow' AND expired = false ORDER BY source_id");
            assert.deepStrictEqual(live.map((r) => r.source_id), ['backend-developer-berlin-123', 'ops-engineer-remote-456']);
        });

        await check('a job Sources retires expires here and leaves the search', async () => {
            push(job('backend-developer-berlin-123', { revision: 2, removed: { at: '2026-10-30T06:00:00.000Z', reason: 'gone_from_source' } }));
            const out = await from.pull();
            assert.deepStrictEqual([out.applied, out.removed], [0, 1]);
            const row = await s.db.maybe('SELECT expired FROM work_listings WHERE source_id = $1', ['backend-developer-berlin-123']);
            assert.strictEqual(row.expired, true);
            assert.strictEqual((await t.get('/api/v1/jobs?q=payment')).json().jobs.length, 0);
            assert.strictEqual((await store.sourceFetches(s)).get('arbeitnow').listings, 1);
            // The cursor moved past it: the next pull changes nothing.
            assert.deepStrictEqual([(await from.pull()).applied, (await from.pull()).removed], [0, 0]);
        });

        await check('without WORK_ARBEITNOW_FROM=sources nothing follows Sources', async () => {
            const config = { ...t.config, sources: { ...t.config.sources, arbeitnowFrom: 'board', internalUrl: 'http://127.0.0.1:1' } };
            const off = createFromSources({ config, s, log: { log() {}, warn() {} } });
            assert.strictEqual(off.enabled, false);
            assert.deepStrictEqual(await off.pull(), { skipped: true });
        });
    } finally {
        await t.close();
    }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
