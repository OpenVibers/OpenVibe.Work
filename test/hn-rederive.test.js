'use strict';
/**
 * Re-deriving the Hacker News titles stored before the one-line split (server/jobs/rederive-hn-titles.js): an old row
 * is read back from its company and title, the same parser the ingest uses writes the title, place, terms and pay,
 * Search is swept with the changed documents, and a second run reads nothing (the title_rule marker).
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const store = require('../server/jobs/store');
const { rederiveHnTitles, legacyLine } = require('../server/jobs/rederive-hn-titles');

const legacy = (s, sourceId, company, title, over = {}) => ({
    id: store.idOf('hn-whoishiring', sourceId), source: 'hn-whoishiring', source_id: sourceId,
    url: `https://news.ycombinator.com/item?id=${sourceId}`, title, company, location: null, remote: false,
    tags: '', job_type: null, salary: null,
    excerpt: `${company}${title ? ` | ${title}` : ''} The comment's own words, kept.`,
    search_text: `${title} ${company}`.toLowerCase(), posted_at: '2026-10-01T15:00:00.000Z',
    sort_at: '2026-10-01T15:00:00.000Z', fetched_at: '2026-10-30T06:00:00.000Z',
    first_seen_at: '2026-10-30T06:00:00.000Z', last_seen_at: '2026-10-30T06:00:00.000Z',
    expired: false, title_rule: null, ...over,
});

(async () => {
    const t = await boot();
    const { s, search } = t.ctx;
    try {
        const now = '2026-10-30T06:00:00.000Z';
        const rows = [
            legacy(s, 'hn-301', 'Acme', 'Senior Software Engineer | REMOTE (US) | Full-Time'),
            legacy(s, 'hn-302', 'Planlab.ai', '| Product Engineer | ONSITE in London, UK'),
            legacy(s, 'hn-303', '', 'Remote (US) | Full-time | Senior Software Engineer'),
        ];
        for (const row of rows) {
            await s.db.exec(
                `INSERT INTO work_listings (id, source, source_id, url, title, company, location, remote, tags, job_type, salary, excerpt,
                    search_text, posted_at, sort_at, fetched_at, first_seen_at, last_seen_at, expired, title_rule)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16,$16,false,NULL)`,
                [row.id, row.source, row.source_id, row.url, row.title, row.company, row.location, row.remote, row.tags,
                    row.job_type, row.salary, row.excerpt, row.search_text, row.posted_at, row.sort_at, row.fetched_at]);
        }

        await check('a legacy line is put back together from its company and title', async () => {
            assert.strictEqual(legacyLine(rows[0]), 'Acme | Senior Software Engineer | REMOTE (US) | Full-Time');
            assert.strictEqual(legacyLine(rows[1]), 'Planlab.ai | Product Engineer | ONSITE in London, UK');
        });

        let out;
        await check('the old titles are re-derived, and the row keeps the original line in its excerpt', async () => {
            out = await rederiveHnTitles({ s, config: t.config, apply: true, search, log: { log() {} } });
            assert.deepStrictEqual([out.scanned, out.changed, out.skipped], [3, 2, 1]);
            const acme = await s.db.one('SELECT * FROM work_listings WHERE id = $1', [rows[0].id]);
            assert.deepStrictEqual([acme.title, acme.company, acme.location, acme.remote, acme.job_type, acme.title_rule],
                ['Senior Software Engineer at Acme', 'Acme', 'REMOTE (US)', true, 'Full time', 'hn-line@1']);
            const planlab = await s.db.one('SELECT * FROM work_listings WHERE id = $1', [rows[1].id]);
            assert.deepStrictEqual([planlab.title, planlab.company, planlab.location, planlab.tags],
                ['Product Engineer at Planlab.ai', 'Planlab.ai', 'London, UK', 'Onsite']);
            assert.ok(acme.excerpt.startsWith('Acme | Senior Software Engineer | REMOTE (US) | Full-Time'), 'nothing is lost');
            assert.strictEqual((await s.db.one('SELECT title_rule FROM work_listings WHERE id = $1', [rows[2].id])).title_rule, null,
                'a line with no company is left alone');
        });

        await check('the listing page and its feed say "Role at Company" once, not twice', async () => {
            const page = await t.get(`/jobs/${rows[0].id}`);
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('<h1>Senior Software Engineer at Acme</h1>'));
            assert.ok(!page.text.includes('at Acme at Acme'), 'the company is not appended to a title that already ends with it');
            const feed = await t.get('/jobs.atom');
            assert.strictEqual(feed.status, 200);
            assert.ok(feed.text.includes('<title>Senior Software Engineer at Acme</title>'));
            assert.ok(!feed.text.includes('at Acme at Acme'));
        });

        await check('Search is swept with the changed documents, and the title is not doubled in the document', async () => {
            assert.ok(out.sent && out.sent.sent >= 2, `swept: ${JSON.stringify(out.sent)}`);
            const envs = (await s.db.many('SELECT envelope FROM event_outbox')).map((r) => r.envelope);
            const doc = envs.find((e) => e.payload && e.payload.id === rows[0].id);
            assert.ok(doc, 'the changed listing is in the outbox');
            assert.strictEqual(doc.payload.title, 'Senior Software Engineer at Acme');
            const plan = envs.find((e) => e.payload && e.payload.id === rows[1].id);
            assert.strictEqual(plan.payload.title, 'Product Engineer at Planlab.ai');
        });

        await check('a second run reads nothing: the marker means its own title is never parsed as the board line', async () => {
            const again = await rederiveHnTitles({ s, config: t.config, apply: false, search, log: { log() {} } });
            // The one row with no company is read again and skipped again; every row it could re-title is marked.
            assert.deepStrictEqual([again.scanned, again.changed, again.skipped], [1, 0, 1]);
            const acme = await s.db.one('SELECT title FROM work_listings WHERE id = $1', [rows[0].id]);
            assert.strictEqual(acme.title, 'Senior Software Engineer at Acme');
        });
    } finally {
        t.ctx.search.stop();
        await t.close();
    }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
