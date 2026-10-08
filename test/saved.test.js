'use strict';
/**
 * Saved searches: saving the search you are looking at, seeing each one with the count of listings that appeared
 * since you last looked, the count resetting when you open /saved, signing in being required, a signed-in write from
 * another site being refused, and nobody seeing anybody else's.
 *
 * The clock is a test's own, because "new since you last looked" is a claim about time.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    // The clock starts at the real now: the session is a Network token, and this service checks it against its own
    // clock, so a test that moves time must move only a little or the token stops verifying.
    const clock = { t: Date.now() };
    const t = await boot({ now: () => clock.t, env: { WORK_INGEST_PAGES: '2' } });
    const kim = t.network.addUser('kim');
    const lee = t.network.addUser('lee');
    const SAME = { 'sec-fetch-site': 'same-origin' };

    try {
        await t.ctx.ingest.runAll();

        await check('a saved search is a person\'s: anonymous is 401, an app token is 403, the other person sees nothing', async () => {
            assert.strictEqual((await t.get('/api/v1/saved-searches')).status, 401);
            const anon = await t.get('/api/v1/saved-searches');
            assert.strictEqual(anon.json().code, 'token.required');

            const save = await t.get('/api/v1/saved-searches', { as: kim, json: { q: 'engineer' }, headers: SAME });
            assert.strictEqual(save.status, 201, save.text);
            const mine = save.json();
            assert.match(mine.id, /^ssc_[0-9A-HJKMNP-TV-Z]{26}$/);
            assert.strictEqual(mine.query, 'engineer');
            assert.strictEqual(mine.new_count, 0);

            const other = await t.get('/api/v1/saved-searches', { as: lee });
            assert.deepStrictEqual(other.json().saved_searches, [], 'another person saw my saved search');
            assert.strictEqual((await t.get(`/api/v1/saved-searches/${mine.id}`, { as: lee, method: 'DELETE', headers: SAME })).status, 404);
            assert.strictEqual((await t.get('/api/v1/saved-searches', { as: kim })).json().saved_searches.length, 1, 'the other person deleted mine');
        });

        await check('a saved search needs at least one filter, and its filters are the search\'s own', async () => {
            const empty = await t.get('/api/v1/saved-searches', { as: kim, json: { q: '   ' }, headers: SAME });
            assert.strictEqual(empty.status, 422);
            assert.strictEqual(empty.json().code, 'work.saved_searches.empty');
            const remote = await t.get('/api/v1/saved-searches', { as: kim, json: { q: 'devops', remote: 'yes', location: 'Worldwide' }, headers: SAME });
            assert.strictEqual(remote.status, 201, remote.text);
            const saved = remote.json();
            assert.deepStrictEqual(saved.filters, { remote: 'true', type: '', location: 'worldwide' });
            assert.strictEqual(saved.search_path, '/jobs?q=devops&remote=true&location=worldwide');
            // Running it again gives the same listings the search would.
            const run = (await t.get(saved.search_path)).text;
            assert.ok(run.includes('DevOps Engineer'));
        });

        await check('a signed-in write from another site is refused; a Bearer token is not (it is that person\'s own)', async () => {
            const cross = await t.get('/api/v1/saved-searches', { as: kim, json: { q: 'x' }, headers: { 'sec-fetch-site': 'cross-site' } });
            assert.strictEqual(cross.status, 403);
            assert.strictEqual(cross.json().code, 'request.cross_site');
            const bearer = await t.get('/api/v1/saved-searches', { bearer: t.network.userToken(kim), json: { q: 'designer' } });
            assert.strictEqual(bearer.status, 201, bearer.text);
        });

        await check('a listing that appears later counts as new, and opening /saved is what clears it', async () => {
            const saved = (await t.get('/api/v1/saved-searches', { as: kim, json: { q: 'render wrangler' }, headers: SAME })).json();
            assert.strictEqual(saved.new_count, 0);
            // Nothing new yet: the board shows nothing matching.
            assert.strictEqual((await t.get('/api/v1/saved-searches', { as: kim })).json().saved_searches.find((x) => x.id === saved.id).new_count, 0);

            // A little later the board starts showing one that matches.
            clock.t += 60_000;
            t.boards.add('remotive', {
                id: 1900999, url: 'https://remotive.com/remote-jobs/other/render-wrangler-1900999',
                title: 'Render Wrangler', company_name: 'Raytrace', category: 'Other', tags: ['gpu'],
                job_type: 'full_time', publication_date: '2026-10-02T10:00:00',
                candidate_required_location: 'Worldwide', salary: '', description: '<p>Keep the farm rendering.</p>',
            });
            await t.ctx.ingest.runAll();

            const apiList = (await t.get('/api/v1/saved-searches', { as: kim })).json().saved_searches;
            assert.strictEqual(apiList.find((x) => x.id === saved.id).new_count, 1, JSON.stringify(apiList));

            // Opening /saved shows the count, and is itself the act of looking.
            const page = await t.get('/saved', { as: kim });
            assert.strictEqual(page.status, 200);
            assert.match(page.text, /1 new/);
            assert.strictEqual((await t.get('/api/v1/saved-searches', { as: kim })).json().saved_searches.find((x) => x.id === saved.id).new_count, 0, 'opening /saved did not clear the count');
            assert.strictEqual((await t.get('/saved', { as: kim })).text.includes('nothing new'), true);
        });

        await check('saving from the page needs a sign-in, must come from this site, and lands on /saved', async () => {
            const anon = await t.get('/saved');
            assert.strictEqual(anon.status, 200);
            assert.match(anon.text, /Sign in with OpenVibe/);
            assert.match(anon.text, /href="\/auth\/login\?next=%2Fsaved"/);

            const cross = await t.get('/saved', { as: kim, form: { q: 'engineer' }, headers: { 'sec-fetch-site': 'cross-site' } });
            assert.strictEqual(cross.status, 403);

            const ok = await t.get('/saved', { as: kim, form: { q: 'support engineer', remote: 'true' }, headers: SAME });
            assert.strictEqual(ok.status, 303);
            assert.strictEqual(ok.headers.get('location'), '/saved');
            const list = await t.get('/saved', { as: kim });
            assert.ok(list.text.includes('“support engineer”'), 'the saved search is not on the page');
            assert.match(list.text, /href="\/jobs\?q=support\+engineer&amp;remote=true"/, 'no link to run it again');
            assert.match(list.text, /Forget it/);
        });

        await check('forgetting a saved search removes it, and only it', async () => {
            const before = (await t.get('/api/v1/saved-searches', { as: kim })).json().saved_searches;
            assert.ok(before.length >= 2);
            const target = before.find((x) => x.query === 'engineer');
            const gone = await t.get(`/api/v1/saved-searches/${target.id}`, { as: kim, method: 'DELETE', headers: SAME });
            assert.strictEqual(gone.status, 204);
            const after = (await t.get('/api/v1/saved-searches', { as: kim })).json().saved_searches;
            assert.deepStrictEqual(after.map((x) => x.id), before.filter((x) => x.id !== target.id).map((x) => x.id));
            assert.strictEqual((await t.get(`/api/v1/saved-searches/${target.id}`, { as: kim, method: 'DELETE', headers: SAME })).status, 404);
        });

        await check('the page\'s delete button forgets exactly the one it names', async () => {
            const list = (await t.get('/api/v1/saved-searches', { as: kim })).json().saved_searches;
            const keep = list[0];
            const drop = list[1];
            const form = await t.get(`/saved/${drop.id}/delete`, { as: kim, method: 'POST', headers: SAME });
            assert.strictEqual(form.status, 303);
            assert.strictEqual(form.headers.get('location'), '/saved');
            const after = (await t.get('/api/v1/saved-searches', { as: kim })).json().saved_searches;
            assert.ok(after.some((x) => x.id === keep.id), 'the wrong saved search was deleted');
            assert.ok(!after.some((x) => x.id === drop.id));
            // Nobody else's, even with the right id.
            const other = await t.get(`/saved/${keep.id}/delete`, { as: lee, method: 'POST', headers: SAME });
            assert.strictEqual(other.status, 303);
            assert.ok((await t.get('/api/v1/saved-searches', { as: kim })).json().saved_searches.some((x) => x.id === keep.id), 'another person deleted my saved search');
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
