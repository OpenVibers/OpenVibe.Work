'use strict';
/**
 * RemoteOK through OpenVibe.Sources (server/ingest/from-sources.js; plan 2026-10-22, track F): the board's API is
 * read by Sources (source remoteok-job-board) under its robots and terms, and Work follows the change feed. A listing
 * must become the row Work's own RemoteOK fetch made: the same id (the board's own id, so the same listing URL), the
 * position as its title, the company and place, tags, and the salary bounds written the way the board's fetch wrote
 * them. A job Sources retires expires here; Work never calls remoteok.com itself.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const store = require('../server/jobs/store');

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
    id: `itm_remoteok_${identity}`, source_key: 'remoteok-job-board', category: 'jobs', kind: 'job', identity,
    canonical_url: `https://remoteok.com/remote-jobs/remote-devops-engineer-skyward-${identity}`,
    title: 'DevOps Engineer', summary: 'Kubernetes, Terraform, on-call.',
    authors: [], published_at: '2026-11-10T08:00:00.000Z', source_updated_at: null,
    fields: {
        company: 'Skyward Cloud', location: 'Worldwide', job_type: null,
        salary_min: 90000, salary_max: 130000, tags: ['devops', 'kubernetes'],
    },
    revision: 1, provenance: { retrieved_at: '2026-11-12T06:00:00.000Z' }, removed: null, ...over,
});

(async () => {
    const clock = { t: Date.parse('2026-11-12T06:00:00Z') };
    const t = await boot({ now: () => clock.t, sourcesClient });
    const s = t.ctx.s;
    const from = t.ctx.fromSources;

    try {
        await check('RemoteOK is one of the boards followed, not one Work fetches', async () => {
            assert.ok(from.sourceIds.includes('remoteok'), from.sourceIds.join(', '));
            const out = await t.ctx.ingest.runAll();
            assert.deepStrictEqual(out.find((o) => o.source === 'remoteok'), { source: 'remoteok', skipped: 'from_sources' });
        });

        await check('a Sources item becomes the listing RemoteOK\'s own fetch made', async () => {
            push(job('1049001'));
            const out = await from.pull();
            assert.deepStrictEqual([out.applied, out.hold, out.removed], [1, 0, 0]);

            const id = store.idOf('remoteok', '1049001');
            const row = await s.db.maybe('SELECT * FROM work_listings WHERE id = $1', [id]);
            assert.deepStrictEqual(
                [row.source, row.source_id, row.title, row.company, row.location, row.remote, row.tags, row.job_type, row.salary, row.expired],
                ['remoteok', '1049001', 'DevOps Engineer', 'Skyward Cloud', 'Worldwide', true, 'devops, kubernetes', null, '$90,000–$130,000 a year', false]);
            assert.strictEqual(row.url, 'https://remoteok.com/remote-jobs/remote-devops-engineer-skyward-1049001');
            assert.strictEqual(row.excerpt, 'Kubernetes, Terraform, on-call.');
            const page = (await t.get('/api/v1/jobs?q=DevOps')).json();
            assert.deepStrictEqual(page.jobs.map((j) => [j.id, j.source, j.salary]), [[id, 'remoteok', '$90,000–$130,000 a year']]);
            assert.strictEqual((await store.sourceFetches(s)).get('remoteok').listings, 1);
        });

        await check('a RemoteOK job Sources retires expires here', async () => {
            push(job('1049001', { revision: 2, removed: { at: '2026-11-20T06:00:00.000Z', reason: 'gone_from_source' } }));
            const out = await from.pull();
            assert.deepStrictEqual([out.applied, out.removed], [0, 1]);
            const row = await s.db.maybe('SELECT expired FROM work_listings WHERE source_id = $1', ['1049001']);
            assert.strictEqual(row.expired, true);
            assert.strictEqual((await t.get('/api/v1/jobs?q=DevOps')).json().jobs.length, 0);
        });
    } finally {
        await t.close();
    }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
