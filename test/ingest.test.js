'use strict';
/**
 * The background ingest against the stand-in boards (test/helpers/boards.js): what it keeps from each board and what
 * it refuses, that reading a board twice updates rather than duplicates, that a board which fails is recorded and
 * does not stop the others, that only a short plain-text excerpt is stored, and that a listing no board has shown for
 * the retention window expires out of the search and the pages.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const store = require('../server/jobs/store');

const DAY = 86_400_000;

(async () => {
    const clock = { t: Date.parse('2026-10-01T06:00:00Z') };
    const t = await boot({ now: () => clock.t, env: { WORK_INGEST_PAGES: '2' } });
    const ingest = t.ctx.ingest;
    const s = t.ctx.s;

    try {
        await check('reading the three boards keeps every listing with its source, its id and the original URL', async () => {
            const out = await ingest.runAll();
            assert.deepStrictEqual(out.map((o) => o.source), ['arbeitnow', 'remotive', 'remoteok']);
            assert.ok(out.every((o) => o.ok), JSON.stringify(out.map((o) => o.error)));
            // Arbeitnow's two pages (2 + 1), Remotive's two jobs, RemoteOK's two listings.
            const counts = await store.countsBySource(s);
            assert.strictEqual(counts.get('arbeitnow').count, 3);
            assert.strictEqual(counts.get("remotive").count, 3);
            assert.strictEqual(counts.get('remoteok').count, 2);

            const page = (await t.get('/api/v1/jobs?q=DevOps')).json();
            assert.strictEqual(page.jobs.length, 1);
            const job = page.jobs[0];
            assert.strictEqual(job.source, 'remoteok');
            assert.strictEqual(job.source_name, 'RemoteOK');
            assert.strictEqual(job.url, 'https://remoteok.com/remote-jobs/remote-devops-engineer-skyward-1049001');
            assert.strictEqual(job.company, 'Skyward Cloud');
            assert.strictEqual(job.salary, '$90,000–$130,000 a year');
            assert.strictEqual(job.remote, true);
            assert.deepStrictEqual(job.tags, ['devops', 'kubernetes']);
            assert.ok(job.posted_at.startsWith('2026-10-01'));

            // RemoteOK's first array element is a legal notice, not a listing: nothing was made of it.
            const all = (await t.get('/api/v1/jobs?limit=100')).json();
            assert.strictEqual(all.count, 8);
            assert.ok(!JSON.stringify(all.jobs).includes('personal use'), 'the legal notice became a listing');
        });

        await check('every request used this service\'s User-Agent, a JSON Accept, and only the configured hosts', async () => {
            assert.ok(t.boards.requests.length >= 4);
            for (const r of t.boards.requests) {
                assert.strictEqual(r.userAgent, 'OpenVibeWork/0.1 (+https://openvibe.work)', r.path);
                assert.match(r.accept, /application\/json/);
            }
            assert.deepStrictEqual([...new Set(t.boards.requests.map((r) => r.path))].sort(), ['/arbeitnow', '/remoteok', '/remotive']);
            // Arbeitnow is paginated as configured (WORK_INGEST_PAGES=2); Remotive is asked for a limit.
            assert.ok(t.boards.requests.some((r) => r.path === '/arbeitnow' && r.query === '?page=1'));
            assert.ok(t.boards.requests.some((r) => r.path === '/arbeitnow' && r.query === '?page=2'));
            assert.ok(t.boards.requests.some((r) => r.path === '/remotive' && r.query === '?limit=100'));
        });

        await check('an HTML description becomes a short plain-text excerpt: no tags, no script code, under 320 characters', async () => {
            const job = (await t.get('/api/v1/jobs?q=Frontend')).json().jobs[0];
            assert.ok(!/[<>]/.test(job.excerpt), job.excerpt);
            assert.ok(!/window\.__pwned/.test(job.excerpt), 'script content was kept');
            assert.ok(job.excerpt.includes('Build the design system'), job.excerpt);
            assert.ok(job.excerpt.length <= 320, String(job.excerpt.length));
            const page = (await t.get('/api/v1/jobs?q=Senior Backend')).json().jobs[0];
            assert.ok(page.excerpt.includes('PostgreSQL'), page.excerpt);
            assert.ok(page.excerpt.includes('fleet of Node.js services'), page.excerpt);
            // The full description is nowhere in the database: only the excerpt is stored.
            const dump = await t.dbDump();
            assert.ok(!dump.includes('billing pipeline end to end</p>'), 'the full description was stored');
        });

        await check('the text helper strips markup and entities, and cuts a long excerpt on a word', () => {
            const { stripHtml, excerpt, EXCERPT_CHARS } = require('../server/jobs/text');
            assert.strictEqual(stripHtml('<p>Hello&nbsp;<b>world</b> — it&#39;s 5 &amp; 6 &lt;ok&gt;</p>'), "Hello world — it's 5 & 6 ok");
            assert.strictEqual(stripHtml('<div>a</div><div>b</div>'), 'a b');
            assert.strictEqual(stripHtml('<style>p{color:red}</style><p>real</p>'), 'real');
            assert.strictEqual(stripHtml('<script>alert(1)</script>'), '');
            assert.strictEqual(stripHtml(null), '');
            // Arbeitnow sends some descriptions as escaped HTML: the markup must not show up as words.
            assert.strictEqual(stripHtml('&lt;div class=&quot;content-intro&quot;&gt;&lt;p&gt;GitLab is here.&lt;/p&gt;&lt;script&gt;x()&lt;/script&gt;'), 'GitLab is here.');
            // A doubly-encoded tag decodes to text and is then dropped, never re-formed into markup.
            assert.ok(!stripHtml('&lt;script&gt;alert(1)&lt;/script&gt;').includes('<'));
            assert.strictEqual(excerpt('<p>short</p>'), 'short');
            const long = excerpt(`<p>${'word '.repeat(120)}</p>`);
            assert.ok(long.length <= EXCERPT_CHARS + 1, String(long.length));
            assert.ok(long.endsWith('…'));
            assert.ok(!long.includes('  ') && /^\S/.test(long), 'the excerpt is cut mid-word or padded');
        });

        await check('reading a board again updates the listing in place: no duplicate, same id, newer fetch', async () => {
            const before = (await t.get('/api/v1/jobs?q=DevOps')).json().jobs[0];
            const seenBefore = before.fetched_at;
            clock.t += 2 * 3600_000;
            // The board's own text changed under the same id, as a board edits a listing.
            t.boards.fixtures.remoteok[1].position = 'DevOps Engineer (Platform)';
            const remoteok = (await ingest.runAll()).find((o) => o.source === 'remoteok');
            assert.deepStrictEqual([remoteok.ok, remoteok.listings, remoteok.added, remoteok.updated], [true, 2, 0, 2]);
            const after = (await t.get('/api/v1/jobs?q=DevOps')).json().jobs[0];
            assert.strictEqual(after.id, before.id, 'the id must not change when a board is read again');
            assert.strictEqual(after.title, 'DevOps Engineer (Platform)');
            assert.ok(after.fetched_at > seenBefore, 'fetched_at did not move');
            assert.strictEqual((await t.get("/api/v1/jobs?limit=100")).json().count, 8);
            t.boards.fixtures.remoteok[1].position = 'DevOps Engineer';
        });

        await check('a listing the board stopped showing expires out, leaving the others', async () => {
            // Arbeitnow's page 2 goes quiet: one listing was there, is not any more.
            const gone = t.boards.fixtures.arbeitnowPage2.shift();
            clock.t += 31 * DAY;
            await ingest.runAll();
            assert.strictEqual((await store.countsBySource(s)).get('arbeitnow').count, 2);
            assert.strictEqual((await t.get('/api/v1/jobs?q=Data Analyst')).json().count, 0);
            const row = await s.db.maybe("SELECT * FROM work_listings WHERE source_id = $1 AND expired", [gone.slug]);
            assert.ok(row, 'the expired listing was deleted rather than kept');
            assert.strictEqual((await t.get(`/jobs/${row.id}`)).status, 404);
            // And it comes back if the board shows it again.
            t.boards.fixtures.arbeitnowPage2.push(gone);
            await ingest.runAll();
            assert.strictEqual((await t.get('/api/v1/jobs?q=Data Analyst')).json().count, 1);
        });

        await check('a board that fails is recorded, says why, and does not stop the others', async () => {
            clock.t += 3600_000;
            t.boards.state.remotive = 'fail';
            t.boards.state.remoteok = 'html';
            const out = await ingest.runAll();
            assert.strictEqual(out.find((o) => o.source === 'remotive').ok, false);
            assert.strictEqual(out.find((o) => o.source === 'arbeitnow').ok, true, 'one board failing stopped another');
            const src = (await t.get('/api/v1/sources')).json();
            const remotive = src.sources.find((x) => x.id === 'remotive');
            assert.strictEqual(remotive.last_fetch.ok, false);
            assert.match(remotive.last_fetch.error, /500/);
            assert.ok(remotive.last_fetch.finished_at, 'the failure was not timestamped');
            assert.match(src.sources.find((x) => x.id === 'remoteok').last_fetch.error, /not JSON/);
            // What was already gathered stays: a failed read never empties the board.
            assert.strictEqual(remotive.listings, 3);
            t.boards.reset();
        });

        await check('the ingest is off unless WORK_INGEST=on, so a test or a development run reads no board', async () => {
            assert.strictEqual(t.config.ingest.enabled, false);
            assert.strictEqual(ingest.start(), false);
            const other = await boot({ env: { WORK_INGEST: 'on', WORK_INGEST_INTERVAL_HOURS: '6' } });
            try {
                assert.strictEqual(other.config.ingest.enabled, true);
                assert.strictEqual(other.config.ingest.intervalMs, 6 * 3600_000);
                assert.strictEqual(other.ctx.ingest.start(), true);
                assert.strictEqual(other.ctx.ingest.timers.size, 4, 'one timer per source plus the first run');
                other.ctx.ingest.stop();
            } finally { await other.close(); }
        });

        await check('a page that is not a listing is refused rather than published', async () => {
            // A row with no URL to link back to, or a URL that is not http(s), has no provenance: it is not kept.
            const { toRow } = require('../server/jobs/sources');
            const base = { source_id: 'x', title: 't', company: 'c', url: 'https://example.org/x', tags: [], description_html: '<p>hi</p>' };
            assert.strictEqual(toRow({ ...base, url: 'javascript:alert(1)' }, { sourceId: 'remotive', fetchedAt: 'x', idOf: store.idOf }), null);
            assert.strictEqual(toRow({ ...base, url: null }, { sourceId: 'remotive', fetchedAt: 'x', idOf: store.idOf }), null);
            assert.strictEqual(toRow({ ...base, title: '' }, { sourceId: 'remotive', fetchedAt: 'x', idOf: store.idOf }), null);
            const row = toRow(base, { sourceId: 'remotive', fetchedAt: '2026-10-01T00:00:00.000Z', idOf: store.idOf });
            assert.strictEqual(row.sort_at, '2026-10-01T00:00:00.000Z', 'a listing with no date sorts by when we read it');
        });

        await check('a listing\'s id is derived from its source and the board\'s id, so it is stable', () => {
            assert.strictEqual(store.idOf('remotive', '1900123'), store.idOf('remotive', '1900123'));
            assert.notStrictEqual(store.idOf('remotive', '1900123'), store.idOf('remoteok', '1900123'));
            assert.match(store.idOf('arbeitnow', 'x'), store.LISTING_ID);
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
