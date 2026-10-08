'use strict';
/**
 * The listings as a reader and as a crawler meet them: the search and its filters and facets, the cursor, one listing
 * with its provenance and its JSON-LD, the escaping of a hostile title, and the discovery files that carry the
 * listings (sitemap) and the sources (llms.txt).
 *
 * The listings come from the stand-in boards through the real ingest, so what is searched is what was really stored.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const ldBlocks = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
const first = async (t, path) => (await t.get(path)).json();

(async () => {
    const t = await boot({ env: { WORK_INGEST_PAGES: '2' } });
    try {
        await t.ctx.ingest.runAll();

        await check('search: text matches the title, the company and the tags; results are newest first', async () => {
            const byTitle = await first(t, '/api/v1/jobs?q=devops');
            assert.deepStrictEqual(byTitle.jobs.map((j) => j.title), ['DevOps Engineer']);
            const byCompany = await first(t, '/api/v1/jobs?q=Skyward');
            assert.deepStrictEqual(byCompany.jobs.map((j) => j.company), ['Skyward Cloud']);
            // The term is found in a tag and in the excerpt, so both listings answer.
            const byTag = await first(t, '/api/v1/jobs?q=terraform');
            assert.deepStrictEqual(byTag.jobs.map((j) => j.company).sort(), ['Meridian Rail', 'Skyward Cloud']);
            // Case does not matter, and a % a caller typed is a character, not a wildcard.
            assert.strictEqual((await first(t, '/api/v1/jobs?q=DEVOPS')).count, 1);
            assert.strictEqual((await first(t, '/api/v1/jobs?q=%25')).count, 0);
            const all = await first(t, '/api/v1/jobs?limit=100');
            const dates = all.jobs.map((j) => j.posted_at);
            assert.deepStrictEqual(dates, [...dates].sort().reverse(), 'newest first');
        });

        await check('filters: remote, job type and location, with the facets counting the same scope', async () => {
            const remote = await first(t, '/api/v1/jobs?remote=true');
            assert.ok(remote.count > 0);
            assert.ok(remote.jobs.every((j) => j.remote === true));
            const onSite = await first(t, '/api/v1/jobs?remote=false');
            assert.ok(onSite.count > 0);
            assert.ok(onSite.jobs.every((j) => j.remote === false));
            assert.strictEqual(remote.count + onSite.count, (await first(t, '/api/v1/jobs?limit=100')).count);

            const contract = await first(t, '/api/v1/jobs?type=contract');
            assert.deepStrictEqual(contract.jobs.map((j) => j.title), ['Content Marketer']);
            assert.strictEqual(contract.facets.matches, 1, 'the count must be what the filters match');
            assert.strictEqual(contract.facets.scope, 8, 'the type facet must not narrow its own scope');

            const germany = await first(t, '/api/v1/jobs?location=Germany');
            assert.deepStrictEqual(germany.jobs.map((j) => j.title).sort(), ['Data Analyst', 'Senior Backend Engineer (Node.js)']);

            const combined = await first(t, '/api/v1/jobs?q=engineer&remote=true');
            assert.ok(combined.count >= 1 && combined.jobs.every((j) => /engineer/i.test(j.title)));
            const facetTypes = (await first(t, '/api/v1/jobs')).facets.type;
            assert.ok(facetTypes.length > 0 && facetTypes.every((x) => x.type && x.count > 0), JSON.stringify(facetTypes));
        });

        await check('the cursor pages through without repeating or losing a listing', async () => {
            const seen = [];
            let cursor = null;
            for (let i = 0; i < 5; i++) {
                const page = await first(t, `/api/v1/jobs?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
                seen.push(...page.jobs.map((j) => j.id));
                cursor = page.next;
                if (!cursor) break;
            }
            const all = (await first(t, '/api/v1/jobs?limit=100')).jobs.map((j) => j.id);
            assert.strictEqual(seen.length, all.length);
            assert.deepStrictEqual([...new Set(seen)].length, all.length, 'a listing was repeated');
            assert.deepStrictEqual(seen, all);
            // A cursor we did not write is refused rather than guessed at.
            assert.strictEqual((await t.get('/api/v1/jobs?cursor=nonsense')).status, 422);
        });

        await check('the list page shows every listing with its source named and linked back to the board', async () => {
            const html = (await t.get('/jobs')).text;
            assert.strictEqual((await t.get('/jobs')).status, 200);
            for (const [name, url] of [
                ['Arbeitnow', 'https://www.arbeitnow.com/view/senior-backend-engineer-berlin-12345'],
                ['Remotive', 'https://remotive.com/remote-jobs/software-dev/platform-engineer-1900789'],
                ['RemoteOK', 'https://remoteok.com/remote-jobs/remote-devops-engineer-skyward-1049001'],
            ]) {
                assert.ok(html.includes(name), `the source ${name} is not named on the list`);
                assert.ok(html.includes(`href="${url}"`), `the original listing ${url} is not linked on the list`);
            }
            assert.match(html, /rel="nofollow noopener external"/, 'the link back must be marked as external');
            // Filters and facets are on the page, and paging is a plain link (no JavaScript).
            assert.ok(html.includes('name="remote"') && html.includes('name="location"'), 'the filter form is missing');
            assert.match(html, /class="facets"/);
            assert.match(html, /href="\/jobs\?[^"]*remote=true"/, 'a facet link is missing');
        });

        await check('one listing: the board\'s fields, the excerpt, the source and "read the full listing on" link', async () => {
            const job = (await first(t, '/api/v1/jobs?q=Platform Engineer')).jobs[0];
            const r = await t.get(`/jobs/${job.id}`);
            assert.strictEqual(r.status, 200);
            const html = r.text;
            assert.ok(html.includes('Platform Engineer'));
            assert.ok(html.includes('Meridian Rail'));
            assert.ok(html.includes('Remote (EU)'));
            assert.ok(html.includes('€70,000 – €85,000'), 'the salary the board gave');
            assert.ok(html.includes('<li>kubernetes</li>'), 'the tags');
            assert.ok(html.includes('Read the full listing on Remotive'), 'no apply link');
            assert.ok(html.includes(`href="${job.url}"`), 'the apply link must be the original URL');
            assert.match(html, /<dt>Source<\/dt>/, 'the source is not stated');
            // The excerpt is shown; the tail of the description was never stored, so it cannot be shown.
            assert.ok(html.includes('You will run the platform other engineers build on'), 'the excerpt is missing');
            assert.ok(!html.includes('Waffle'), 'the full description was republished');
            assert.ok(html.length < 60_000, `the page is ${html.length} bytes: too much of the description is on it`);
            assert.ok(html.includes('/sources#remotive'), 'no link to the source\'s terms as applied');
        });

        await check('the listing page carries a valid JobPosting whose url is the original, not this page', async () => {
            const job = (await first(t, '/api/v1/jobs?q=DevOps')).jobs[0];
            const html = (await t.get(`/jobs/${job.id}`)).text;
            const blocks = ldBlocks(html);
            const posting = blocks.find((b) => b['@type'] === 'JobPosting');
            assert.ok(posting, `no JobPosting node: ${JSON.stringify(blocks.map((b) => b['@type']))}`);
            assert.strictEqual(posting.title, 'DevOps Engineer');
            assert.strictEqual(posting.url, job.url);
            assert.notStrictEqual(posting.url, `https://openvibe.work/jobs/${job.id}`);
            assert.strictEqual(posting.hiringOrganization.name, 'Skyward Cloud');
            assert.strictEqual(posting.jobLocationType, 'TELECOMMUTE');
            assert.match(posting.datePosted, /^2026-10-01T/);
            assert.strictEqual(posting.identifier.name, 'remoteok');
            assert.ok(posting.description.length <= 320);
            assert.ok(posting['@context'] === 'https://schema.org');
            // Every JSON-LD block on the page parses (the escaping must survive a hostile title).
            assert.ok(blocks.length >= 1);
        });

        await check('a hostile title is escaped everywhere it appears, and never becomes markup or a URL', async () => {
            const job = (await first(t, '/api/v1/jobs?q=Frontend Engineer')).jobs[0];
            assert.ok(job.title.includes('<script>'), 'the fixture must carry the hostile title');
            for (const path of ['/jobs', `/jobs/${job.id}`, `/api/v1/jobs?q=Frontend Engineer`]) {
                const html = (await t.get(path)).text;
                assert.ok(!html.includes('<script>alert("xss")</script>'), `${path} rendered the title as markup`);
                assert.ok(!/window\.__pwned/.test(html), `${path} rendered the description's script`);
                if (path.startsWith('/jobs')) assert.ok(html.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'), `${path} did not escape the title`);
            }
            // The JSON-LD on its own page is still parseable JSON with the title as a string.
            const posting = ldBlocks((await t.get(`/jobs/${job.id}`)).text).find((b) => b['@type'] === 'JobPosting');
            assert.ok(posting.title.includes('<script>'));
        });

        await check('a listing that is not there is a 404 page and a problem+json, the same for any unknown id', async () => {
            for (const id of ['job_00000000000000000000000000', 'nope', "1' OR 1=1--"]) {
                const page = await t.get(`/jobs/${encodeURIComponent(id)}`);
                assert.strictEqual(page.status, 404, id);
                assert.match(page.text, /Listing not found/);
                const api = await t.get(`/api/v1/jobs/${encodeURIComponent(id)}`);
                assert.strictEqual(api.status, 404);
                assert.strictEqual(api.json().code, 'work.jobs.not_found');
            }
        });

        await check('every source is listed with its terms as applied and when it was last read', async () => {
            const api = await first(t, '/api/v1/sources');
            assert.deepStrictEqual(api.sources.map((s) => s.id).sort(), ['arbeitnow', 'remoteok', 'remotive']);
            for (const src of api.sources) {
                assert.ok(src.terms.length > 40, `${src.id} has no terms`);
                assert.match(src.terms, /link|attribute|mention|name/i, `${src.id}'s terms do not state the attribution rule`);
                assert.strictEqual(src.last_fetch.ok, true);
                assert.ok(src.last_fetch.finished_at);
                assert.ok(src.listings > 0);
            }
            const html = (await t.get('/sources')).text;
            assert.ok(html.includes('id="remotive"') && html.includes('id="remoteok"') && html.includes('id="arbeitnow"'));
            assert.ok(html.includes('Listing from Remotive') && html.includes('Listing from RemoteOK'));
            assert.match(html, /four a day/, 'Remotive\'s call limit is not stated');
        });

        await check('the sitemap carries the newest listings and the site\'s own pages, and no private path', async () => {
            const xml = (await t.get('/sitemap.xml')).text;
            const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
            const jobs = (await first(t, '/api/v1/jobs?limit=100')).jobs;
            for (const job of jobs) assert.ok(locs.includes(`https://openvibe.work/jobs/${job.id}`), `${job.id} is not in the sitemap`);
            for (const p of ['/', '/jobs', '/sources', '/docs', '/updates']) assert.ok(locs.includes(`https://openvibe.work${p}`), `${p} is not in the sitemap`);
            for (const p of ['/saved', '/auth/login', '/api/v1/jobs']) assert.ok(!xml.includes(`https://openvibe.work${p}`), `${p} must not be in the sitemap`);
            assert.ok(locs.length <= 1000 + 5);
        });

        await check('llms.txt sends a crawler to the listings and the sources, and robots keeps /saved out', async () => {
            const llms = (await t.get('/llms.txt')).text;
            assert.ok(llms.includes('(https://openvibe.work/jobs)'));
            assert.ok(llms.includes('(https://openvibe.work/sources)'));
            assert.ok(llms.includes('Arbeitnow, Remotive, RemoteOK'), 'the sources are not named for a crawler');
            assert.ok(!llms.includes('/saved'), 'llms.txt names a private page');
            const robots = (await t.get('/robots.txt')).text;
            assert.ok(robots.includes('Disallow: /saved'));
            assert.ok(!robots.includes('Disallow: /jobs'));
        });

        await check('the home page is the search box, the latest listings and the sources with their counts', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('Find work.'), 'the hero');
            assert.match(r.text, /action="\/jobs"/, 'the search box');
            assert.ok(r.text.includes('Latest remote jobs'));
            assert.ok(r.text.includes('DevOps Engineer'), 'no listing on the home page');
            for (const [name, url] of [['Arbeitnow', 'https://www.arbeitnow.com/'], ['Remotive', 'https://remotive.com/'], ['RemoteOK', 'https://remoteok.com/']]) {
                assert.ok(r.text.includes(`href="${url}"`), `the source ${name} is not linked on the home page`);
            }
            assert.match(r.text, /no paywall/i, '"how it works" does not say what is behind a paywall (nothing)');
        });

        await check('search is limited per caller, and past it the API says so with Retry-After', async () => {
            const busy = await boot({ callerLimits: true, limitsNow: () => Date.now(), env: { WORK_INGEST_PAGES: '1' } });
            try {
                await busy.ctx.ingest.runAll();
                let limited = null;
                for (let i = 0; i < 70 && !limited; i++) {
                    const r = await busy.get('/api/v1/jobs?q=engineer', { headers: { 'x-forwarded-for': '10.9.9.9' } });
                    if (r.status === 429) limited = r;
                }
                assert.ok(limited, 'the search budget never engaged');
                assert.strictEqual(limited.json().code, 'rate_limited');
                assert.ok(Number(limited.headers.get('retry-after')) > 0);
                // Reading one listing is a plain read, not the search budget, and still works.
                assert.strictEqual((await busy.get('/api/v1/sources')).status, 200);
            } finally { await busy.close(); }
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
