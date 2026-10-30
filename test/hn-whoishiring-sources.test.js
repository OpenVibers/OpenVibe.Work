'use strict';
/**
 * Hacker News "Who is hiring" through OpenVibe.Sources (server/ingest/from-sources.js), against a Sources stand-in:
 *   - a comment becomes a listing with its company and role read from the first line ("Company | Role | Place" or
 *     "Company is hiring …");
 *   - the thin-listing gate still applies: a comment with no company, or a one-letter title/company, is held;
 *   - the listing links the HN comment and is attributed to Hacker News "Who is hiring";
 *   - Work never calls the Hacker News API itself.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const store = require('../server/jobs/store');

const feed = [];
let seq = 0;
const push = (item) => feed.push({ ...item, change_seq: ++seq });
const sourcesClient = {
    enabled: true,
    async listItems({ after = 0, limit = 100 } = {}) {
        const page = feed.filter((i) => i.change_seq > after).slice(0, limit);
        return { items: page, next_after: page.length ? page[page.length - 1].change_seq : after, more: false };
    },
};

// A recorded item of the resolver's output (a fixture: no live call here).
const hn = (identity, title, summary, over = {}) => ({
    id: `itm_${identity}`, source_key: 'hn-whoishiring', category: 'jobs', kind: 'job', identity,
    canonical_url: `https://news.ycombinator.com/item?id=${identity.replace('hn-', '')}`,
    title, summary, authors: ['acme_founder'], published_at: '2026-10-01T15:00:00.000Z', source_updated_at: null,
    fields: { story_id: '101', story_title: 'Ask HN: Who is hiring? (October 2026)', story_url: 'https://news.ycombinator.com/item?id=101' },
    revision: 1, provenance: { retrieved_at: '2026-10-30T06:00:00.000Z' }, removed: null, ...over,
});

(async () => {
    const clock = { t: Date.parse('2026-10-30T08:00:00Z') };
    const t = await boot({ now: () => clock.t, env: { WORK_HN_WHOISHIRING_FROM: 'sources' }, sourcesClient });
    const s = t.ctx.s;
    const from = t.ctx.fromSources;

    try {
        await check('a comment becomes a listing with the company and role from its first line', async () => {
            push(hn('hn-201', 'Acme Corp | Senior Backend Engineer | Remote (US)', 'Acme Corp is hiring. Email [email] or call [phone].'));
            push(hn('hn-203', 'Beta & Co is hiring a product designer', 'Beta & Co is hiring a product designer. Contact [email].'));
            push(hn('hn-205', 'No company here', 'A comment with no company in its first line.'));
            push(hn('hn-206', 'Z | Q', 'A board test post with one-letter fields.'));
            const out = await from.pull();
            assert.deepStrictEqual([out.applied, out.hold, out.removed], [2, 2, 0]);

            const acme = await s.db.maybe('SELECT * FROM work_listings WHERE id = $1', [store.idOf('hn-whoishiring', 'hn-201')]);
            assert.deepStrictEqual([acme.source, acme.title, acme.company, acme.remote, acme.url],
                ['hn-whoishiring', 'Senior Backend Engineer | Remote (US)', 'Acme Corp', true, 'https://news.ycombinator.com/item?id=201']);
            assert.ok(acme.excerpt.includes('[email]') && acme.excerpt.includes('[phone]'), 'the excerpt is Sources\' privacy-stripped text');

            const beta = await s.db.maybe('SELECT * FROM work_listings WHERE id = $1', [store.idOf('hn-whoishiring', 'hn-203')]);
            assert.deepStrictEqual([beta.title, beta.company, beta.remote], ['a product designer', 'Beta & Co', false]);
            assert.strictEqual(await s.db.maybe('SELECT id FROM work_listings WHERE id = $1', [store.idOf('hn-whoishiring', 'hn-205')]), null);
            assert.strictEqual(await s.db.maybe('SELECT id FROM work_listings WHERE id = $1', [store.idOf('hn-whoishiring', 'hn-206')]), null);
        });

        await check('the listing links the HN comment and is attributed to the thread', async () => {
            const id = store.idOf('hn-whoishiring', 'hn-201');
            const list = await t.get('/jobs');
            assert.strictEqual(list.status, 200);
            assert.ok(list.text.includes('Hacker News: Who is hiring'));
            assert.ok(list.text.includes('https://news.ycombinator.com/item?id=201'));
            const page = await t.get(`/jobs/${id}`);
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('Hacker News: Who is hiring'));
            assert.ok(page.text.includes('https://news.ycombinator.com/item?id=201'), 'the original comment is linked');
        });

        await check('a removed item expires the listing, and Work never reads HN itself', async () => {
            push({ ...hn('hn-201', 'Acme Corp | Senior Backend Engineer | Remote (US)', 'x'), id: 'itm_hn-201', removed: { at: '2026-10-30T07:00:00.000Z', reason: 'gone_from_source' }, revision: 2 });
            const out = await from.pull();
            assert.strictEqual(out.removed, 1);
            const row = await s.db.maybe('SELECT expired FROM work_listings WHERE id = $1', [store.idOf('hn-whoishiring', 'hn-201')]);
            assert.ok(row.expired, 'the listing is expired, not deleted');
            const runs = await t.ctx.ingest.runAll();
            assert.deepStrictEqual(runs.find((o) => o.source === 'hn-whoishiring'), { source: 'hn-whoishiring', skipped: 'from_sources' });
        });
    } finally {
        await t.close();
    }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
