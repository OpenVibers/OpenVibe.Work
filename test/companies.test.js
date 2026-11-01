'use strict';
/**
 * Companies (server/jobs/companies.js, /companies, /companies/:slug): a company is grouped by its slug, which JS and SQL
 * compute alike (accents folded, every other run of characters one dash); the index lists them by openings and finds
 * one by name; a company's page shows its listings, places and boards, is noindex below three openings, and is a 404
 * once nothing is open; the home, a listing and the sitemap link the pages.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const companies = require('../server/jobs/companies');

(async () => {
    await check('the slug: lower case, accents folded, one dash between words; nothing left means no page', () => {
        assert.strictEqual(companies.slugOf('Skyward Cloud'), 'skyward-cloud');
        assert.strictEqual(companies.slugOf('Müller & Söhne GmbH'), 'muller-sohne-gmbh');
        assert.strictEqual(companies.slugOf('  Straße  AG '), 'strase-ag');
        assert.strictEqual(companies.slugOf('株式会社'), '');
        assert.strictEqual(companies.slugOf('x'.repeat(200)).length, 80);
    });

    const t = await boot({ env: { WORK_INGEST_PAGES: '2' } });
    try {
        await t.ctx.ingest.runAll();
        const s = t.ctx.s;
        // Two spellings of one company and one with accents, added beside what the stand-in boards gave.
        const now = new Date().toISOString();
        const add = (id, company, title) => s.db.query(`INSERT INTO work_listings (id, source, source_id, url, title, company, location, remote, tags, job_type, salary, excerpt, search_text, posted_at, sort_at, fetched_at, first_seen_at, last_seen_at, expired)
            VALUES ($1, 'remotive', $1, 'https://remotive.com/x', $2, $3, 'Berlin, Germany', true, '', null, null, 'x', lower($2), $4, $4, $4, $4, $4, false)`, [id, title, company, now]);
        await add('job_00000000000000000000000001', 'ACME Widgets', 'Widget Engineer');
        await add('job_00000000000000000000000002', 'Acme Widgets', 'Widget Tester');
        await add('job_00000000000000000000000003', 'acme widgets', 'Widget Lead');
        await add('job_00000000000000000000000004', 'Müller & Söhne GmbH', 'Schreiner');

        await check('SQL and JS agree on every slug in the table', async () => {
            const rows = await s.db.many(`SELECT company, ${companies.SLUG_SQL} AS slug FROM work_listings`, [companies.FROM, companies.TO]);
            for (const r of rows) assert.strictEqual(r.slug, companies.slugOf(r.company), r.company);
        });

        await check('the company slug is indexed (0008): a page does not fold every listing', async () => {
            const [row] = await s.db.many("SELECT to_regclass('public.work_listings_company_slug') AS idx");
            assert.strictEqual(String(row.idx), 'work_listings_company_slug');
        });

        await check('the index: every company by openings, one entry per slug, the most common spelling; found by name', async () => {
            const all = await companies.list(s);
            const acme = all.find((c) => c.slug === 'acme-widgets');
            assert.deepStrictEqual([acme.count, acme.remote], [3, 3], 'three spellings, one company');
            assert.ok(['ACME Widgets', 'Acme Widgets', 'acme widgets'].includes(acme.company));
            assert.deepStrictEqual(all.map((c) => c.count), [...all.map((c) => c.count)].sort((a, b) => b - a), 'most openings first');
            const page = await t.get('/companies');
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('href="/companies/acme-widgets"') && page.text.includes('href="/companies/muller-sohne-gmbh"'));
            assert.doesNotMatch(page.text, /noindex/);
            const found = await t.get('/companies?q=m%C3%BCller');
            assert.ok(found.text.includes('/companies/muller-sohne-gmbh') && !found.text.includes('/companies/acme-widgets'));
            assert.match(found.text, /noindex/, 'a search of the index is not indexed');
        });

        await check('a company page: its listings, places and boards; indexed from three openings, a 404 when nothing is open', async () => {
            const acme = await t.get('/companies/acme-widgets');
            assert.strictEqual(acme.status, 200);
            assert.match(acme.text, /<h1>Jobs at (ACME|Acme|acme) Widgets<\/h1>/);
            assert.ok(acme.text.includes('Widget Engineer') && acme.text.includes('Widget Lead'));
            assert.ok(acme.text.includes('Berlin') && acme.text.includes('href="/sources#remotive"'));
            assert.doesNotMatch(acme.text, /noindex/);
            const muller = await t.get('/companies/muller-sohne-gmbh');
            assert.strictEqual(muller.status, 200);
            assert.match(muller.text, /noindex/, 'one opening is too thin to index');
            assert.strictEqual((await t.get('/companies/no-such-company')).status, 404);
            assert.strictEqual((await t.get('/companies/..%2Fetc')).status, 404);
            await s.db.query("UPDATE work_listings SET expired = true WHERE company = 'Müller & Söhne GmbH'");
            assert.strictEqual((await t.get('/companies/muller-sohne-gmbh')).status, 404, 'gone once nothing is open');
        });

        await check('the home, a listing and the sitemap link the company pages', async () => {
            const home = await t.get('/');
            assert.match(home.text, /href="\/companies\/[a-z0-9-]+"/);
            assert.ok(home.text.includes('href="/companies"'));
            const job = await t.get(`/jobs/job_${'0'.repeat(25)}1`);
            assert.strictEqual(job.status, 200);
            assert.ok(job.text.includes('href="/companies/acme-widgets"'), 'a listing links its company');
            const map = await t.get('/sitemap.xml');
            assert.ok(map.text.includes('/companies</loc>') && map.text.includes('/companies/acme-widgets</loc>'));
            assert.ok(!map.text.includes('/companies/muller-sohne-gmbh'));
        });
    } finally {
        await t.close();
    }
    done();
})();
