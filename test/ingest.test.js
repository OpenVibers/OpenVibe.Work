'use strict';
/**
 * The background ingest against Remotive's stand-in API (test/helpers/boards.js): what it keeps, that reading the
 * board twice updates rather than duplicates, that a failure is recorded and does not hide the listings already
 * gathered, that only a short plain-text excerpt is stored, and that a listing the board stopped showing expires out
 * of the search and the pages.
 *
 * Arbeitnow, We Work Remotely, Hacker News "Who is hiring" and RemoteOK never reach this ingest: they come through
 * OpenVibe.Sources (server/ingest/from-sources.js, test/from-sources.test.js and test/remoteok-sources.test.js), so
 * every run lists them as skipped rather than reading them.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const store = require('../server/jobs/store');

const DAY = 86_400_000;

(async () => {
    const clock = { t: Date.parse('2026-10-01T06:00:00Z') };
    const pinged = [];
    const indexnow = { enabled: false, pingSoon: (urls) => { pinged.push(...urls); return urls.length; } };
    const t = await boot({ now: () => clock.t, indexnow });
    const ingest = t.ctx.ingest;
    const s = t.ctx.s;

    try {
        await check('the read keeps every Remotive listing, and the boards Sources feeds are skipped', async () => {
            const out = await ingest.runAll();
            assert.deepStrictEqual(out.map((o) => o.source), ['arbeitnow', 'weworkremotely', 'hn-whoishiring', 'remotive', 'remoteok']);
            assert.ok(out.filter((o) => ['arbeitnow', 'weworkremotely', 'hn-whoishiring', 'remoteok'].includes(o.source)).every((o) => o.skipped === 'from_sources'));
            assert.strictEqual(out.find((o) => o.source === 'remotive').ok, true, JSON.stringify(out));
            const counts = await store.countsBySource(s);
            assert.strictEqual(counts.get('remotive').count, 3);
            assert.ok(!counts.has('arbeitnow') && !counts.has('remoteok'), 'a board Sources feeds was fetched by Work');

            const page = (await t.get('/api/v1/jobs?q=Platform')).json();
            assert.strictEqual(page.jobs.length, 1);
            const job = page.jobs[0];
            assert.strictEqual(job.source, 'remotive');
            assert.strictEqual(job.source_name, 'Remotive');
            assert.strictEqual(job.url, 'https://remotive.com/remote-jobs/software-dev/platform-engineer-1900789');
            assert.strictEqual(job.company, 'Meridian Rail');
            assert.strictEqual(job.salary, '€70,000 – €85,000');
            assert.strictEqual(job.remote, true);
            assert.deepStrictEqual(job.tags, ['kubernetes', 'terraform', 'Software Development']);
            assert.ok(job.posted_at.startsWith('2026-09-29'));

            const all = (await t.get('/api/v1/jobs?limit=100')).json();
            assert.strictEqual(all.count, 3);

            // Search engines hear about each new listing page and the sitemap (IndexNow), absolute and on this host.
            const jobUrls = pinged.filter((u) => u !== 'https://openvibe.work/sitemap.xml');
            assert.strictEqual(jobUrls.length, 3, pinged.join(' '));
            assert.deepStrictEqual(jobUrls.sort(), all.jobs.map((j) => `https://openvibe.work/jobs/${j.id}`).sort());
            assert.ok(pinged.includes('https://openvibe.work/sitemap.xml'));
        });

        await check('the one request used this service\'s User-Agent, a JSON Accept, and only the configured host', async () => {
            assert.ok(t.boards.requests.length >= 1);
            for (const r of t.boards.requests) {
                assert.strictEqual(r.userAgent, 'OpenVibeWork/0.1 (+https://openvibe.work)', r.path);
                assert.match(r.accept, /application\/json/);
            }
            assert.deepStrictEqual([...new Set(t.boards.requests.map((r) => r.path))], ['/remotive']);
            assert.ok(t.boards.requests.some((r) => r.path === '/remotive' && r.query === '?limit=100'));
        });

        await check('an HTML description becomes a short plain-text excerpt: no tags, no script code, under 320 characters', async () => {
            const job = (await t.get('/api/v1/jobs?q=Platform')).json().jobs[0];
            assert.ok(!/[<>]/.test(job.excerpt), job.excerpt);
            assert.ok(job.excerpt.includes('Kubernetes clusters'), job.excerpt);
            assert.ok(job.excerpt.length <= 320, String(job.excerpt.length));
            const dump = await t.dbDump();
            assert.ok(!dump.includes('The office dog is called Waffle'), 'the full description was stored');
        });

        await check('the text helper strips markup and entities, and cuts a long excerpt on a word', () => {
            const { stripHtml, excerpt, EXCERPT_CHARS } = require('../server/jobs/text');
            assert.strictEqual(stripHtml('<p>Hello&nbsp;<b>world</b> — it&#39;s 5 &amp; 6 &lt;ok&gt;</p>'), "Hello world — it's 5 & 6 ok");
            assert.strictEqual(stripHtml('<div>a</div><div>b</div>'), 'a b');
            // A block boundary before the sentence's own stop leaves no space before it (2026-11-02, a German listing);
            // a dot that starts a word stays (".NET").
            assert.strictEqual(stripHtml('<p><strong>Application Operations</strong> . Deine Aufgaben</p>'), 'Application Operations. Deine Aufgaben');
            assert.strictEqual(stripHtml('C# and .NET , SQL .'), 'C# and .NET, SQL.');
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

        await check('reading the board again updates the listing in place: no duplicate, same id, newer fetch', async () => {
            const before = (await t.get('/api/v1/jobs?q=Platform')).json().jobs[0];
            const seenBefore = before.fetched_at;
            clock.t += 2 * 3600_000;
            // The board's own text changed under the same id, as a board edits a listing.
            t.boards.fixtures.remotive[1].title = 'Platform Engineer (Ops)';
            const remotive = (await ingest.runAll()).find((o) => o.source === 'remotive');
            pinged.length = 0;
            assert.deepStrictEqual([remotive.ok, remotive.listings, remotive.added, remotive.updated], [true, 3, 0, 3]);
            assert.deepStrictEqual(pinged, [], 'a listing read again is not new: no IndexNow ping');
            const after = (await t.get('/api/v1/jobs?q=Platform')).json().jobs[0];
            assert.strictEqual(after.id, before.id, 'the id must not change when a board is read again');
            assert.strictEqual(after.title, 'Platform Engineer (Ops)');
            assert.ok(after.fetched_at > seenBefore, 'fetched_at did not move');
            assert.strictEqual((await t.get('/api/v1/jobs?limit=100')).json().count, 3);
            t.boards.fixtures.remotive[1].title = 'Platform Engineer';
        });

        await check('a listing the board stopped showing expires out, leaving the others', async () => {
            const gone = t.boards.fixtures.remotive.shift();
            clock.t += 31 * DAY;
            await ingest.runAll();
            assert.strictEqual((await store.countsBySource(s)).get('remotive').count, 2);
            assert.strictEqual((await t.get('/api/v1/jobs?q=Support')).json().count, 0);
            const row = await s.db.maybe('SELECT * FROM work_listings WHERE source_id = $1 AND expired', [String(gone.id)]);
            assert.ok(row, 'the expired listing was deleted rather than kept');
            assert.strictEqual((await t.get(`/jobs/${row.id}`)).status, 404);
            // And it comes back if the board shows it again.
            t.boards.fixtures.remotive.push(gone);
            await ingest.runAll();
            assert.strictEqual((await t.get('/api/v1/jobs?q=Support')).json().count, 1);
        });

        await check('a failed read is recorded, says why, and never empties the board', async () => {
            clock.t += 3600_000;
            t.boards.state.remotive = 'fail';
            const out = await ingest.runAll();
            assert.strictEqual(out.find((o) => o.source === 'remotive').ok, false);
            const src = (await t.get('/api/v1/sources')).json();
            const remotive = src.sources.find((x) => x.id === 'remotive');
            assert.strictEqual(remotive.last_fetch.ok, false);
            assert.match(remotive.last_fetch.error, /500/);
            assert.ok(remotive.last_fetch.finished_at, 'the failure was not timestamped');
            assert.strictEqual(remotive.listings, 3);
            t.boards.reset();
        });

        await check('a source read less than the interval ago is not read again on a restart (Remotive: about four reads a day)', async () => {
            await ingest.runAll();
            const before = t.boards.requests.length;
            const out = await ingest.runAll({ onlyDue: true });
            // A board OpenVibe.Sources feeds is never read here at all, so it is skipped rather than due.
            assert.ok(out.every((o) => o.skipped === 'not_due' || o.skipped === 'from_sources'), 'every source was read just now, so none is due');
            assert.strictEqual(t.boards.requests.length, before, 'no board was called');
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
                assert.strictEqual(other.ctx.ingest.timers.size, 2, 'one hourly tick plus the first run');
                other.ctx.ingest.stop();
            } finally { await other.close(); }
        });

        await check('a page that is not a listing is refused rather than published', async () => {
            // A row with no URL to link back to, or a URL that is not http(s), has no provenance: it is not kept.
            const { toRow } = require('../server/jobs/sources');
            const base = { source_id: 'x', title: 'Tester', company: 'Acme', url: 'https://example.org/x', tags: [], description_html: '<p>hi</p>' };
            assert.strictEqual(toRow({ ...base, url: 'javascript:alert(1)' }, { sourceId: 'remotive', fetchedAt: 'x', idOf: store.idOf }), null);
            assert.strictEqual(toRow({ ...base, url: null }, { sourceId: 'remotive', fetchedAt: 'x', idOf: store.idOf }), null);
            assert.strictEqual(toRow({ ...base, title: '' }, { sourceId: 'remotive', fetchedAt: 'x', idOf: store.idOf }), null);
            // A board's test post ("z at y") is not a listing; a short real title ("QA at Acme") still is.
            assert.strictEqual(toRow({ ...base, title: 'z', company: 'y' }, { sourceId: 'remoteok', fetchedAt: 'x', idOf: store.idOf }), null);
            assert.strictEqual(toRow({ ...base, company: '1' }, { sourceId: 'remoteok', fetchedAt: 'x', idOf: store.idOf }), null);
            assert.ok(toRow({ ...base, title: 'QA' }, { sourceId: 'remoteok', fetchedAt: 'x', idOf: store.idOf }), 'two letters is a title');
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
