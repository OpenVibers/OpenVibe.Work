'use strict';
/**
 * We Work Remotely through OpenVibe.Sources (server/ingest/from-sources.js), against a Sources stand-in serving its
 * change feed:
 *   - a feed item becomes a listing (the board's "Company: Position" title gives the company and the position, the
 *     labelled lines of the description give the location, the duration and the salary, the feed's category a tag);
 *   - the thin-listing gate still applies: an item without a company is held, not published;
 *   - the listing is attributed to We Work Remotely and links back to the original listing;
 *   - Work never reads the feed itself.
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

// A recorded item of the board's feed, in the shape OpenVibe.Sources keeps it (a recorded fixture: no live call here).
const wwr = (identity, over = {}) => ({
    id: `itm_${identity}`, source_key: 'weworkremotely', category: 'jobs', kind: 'article', identity,
    canonical_url: `https://weworkremotely.com/remote-jobs/${identity}`,
    title: 'Welocalize: Automation Specialist',
    summary: 'Headquarters: Ciudad de Mexico, Mexico URL: https://t.mtrbio.com/WeloData About the Role We are looking for an Automation Specialist. Job Title: Automation Specialist-1 Working Hours: 10:00-18:30 CDT Duration: Contract -indefinite . Salary/Compensation: 480,000 MXN/ yearly Location: Mexico (Remote)',
    authors: [], published_at: '2026-10-29T12:00:00.000Z', source_updated_at: null,
    fields: { categories: ['Full-Stack Programming'] },
    revision: 1, provenance: { retrieved_at: '2026-10-30T06:00:00.000Z' }, removed: null, ...over,
});

(async () => {
    const clock = { t: Date.parse('2026-10-30T08:00:00Z') };
    const t = await boot({ now: () => clock.t, env: { WORK_WWR_FROM: 'sources' }, sourcesClient });
    const s = t.ctx.s;
    const from = t.ctx.fromSources;

    try {
        await check('a feed item becomes a listing with the board\'s own words', async () => {
            push(wwr('automation-specialist-welocalize'));
            // The thin-listing gate: no company in the title, so no listing may be published (Work #133).
            push(wwr('automation-specialist', { title: 'Automation Specialist', canonical_url: 'https://weworkremotely.com/remote-jobs/automation-specialist' }));
            const out = await from.pull();
            assert.deepStrictEqual([out.applied, out.hold, out.removed], [1, 1, 0]);

            const id = store.idOf('weworkremotely', 'automation-specialist-welocalize');
            const row = await s.db.maybe('SELECT * FROM work_listings WHERE id = $1', [id]);
            assert.deepStrictEqual([row.source, row.title, row.company, row.location, row.remote, row.tags, row.job_type, row.salary, row.expired],
                ['weworkremotely', 'Automation Specialist', 'Welocalize', 'Mexico (Remote)', true, 'Full-Stack Programming', 'Contract -indefinite', '480,000 MXN/ yearly', false]);
            assert.strictEqual(row.url, 'https://weworkremotely.com/remote-jobs/automation-specialist-welocalize');
            assert.ok(row.excerpt.includes('Automation Specialist'), 'the excerpt is the board\'s own description');

            const page = (await t.get('/api/v1/jobs?q=Automation')).json();
            assert.deepStrictEqual(page.jobs.map((j) => [j.id, j.source, j.source_name]), [[id, 'weworkremotely', 'We Work Remotely']]);
        });

        await check('the listing is attributed to the board and links back to it', async () => {
            const id = store.idOf('weworkremotely', 'automation-specialist-welocalize');
            const list = await t.get('/jobs');
            assert.strictEqual(list.status, 200);
            assert.ok(list.text.includes('Listing from'), 'the listing carries its provenance');
            assert.ok(list.text.includes('We Work Remotely'), 'the board is named');
            assert.ok(list.text.includes('https://weworkremotely.com/remote-jobs/automation-specialist-welocalize'), 'the original listing is linked');
            const page = await t.get(`/jobs/${id}`);
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('We Work Remotely'), 'the board is named on the listing page');
            assert.ok(page.text.includes('https://weworkremotely.com/remote-jobs/automation-specialist-welocalize'), 'the original listing is linked');
        });

        await check('the fetch record says the listings came through, and Work never reads the feed itself', async () => {
            const rec = (await store.sourceFetches(s)).get('weworkremotely');
            assert.deepStrictEqual([rec.ok, rec.listings, rec.error], [true, 1, null]);
            const out = await t.ctx.ingest.runAll();
            assert.deepStrictEqual(out.find((o) => o.source === 'weworkremotely'), { source: 'weworkremotely', skipped: 'from_sources' });
        });
    } finally {
        await t.close();
    }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
