'use strict';
/**
 * The outcomes the market research asks of us (research-2026-10-30/market/outcomes/work.md), one test each:
 *   1. the salary exactly as the board wrote it, or that it wrote none — never a guess;
 *   2. the board named, linked, and when we first saw the listing there;
 *   3. a listing the board stopped showing is hidden, and says so when the old link is followed;
 *   4. our own salary disclosure rate, measured from the listings we fetched;
 *   5. the source board and the exact fetch date next to the link out;
 *   6. we never host the description: a short excerpt and a link out;
 *   7. a saved search says what it looks for and when it last ran; alerts are one account across the network;
 *   8. no apply button and no CV upload, and the one line why.
 *
 * Every number the pages show is checked against the database or against configuration, never against a literal
 * written here.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** The date as the pages write it: the day, the month and the year, in UTC. */
const dateWords = (iso) => {
    const d = new Date(iso);
    assert.ok(!Number.isNaN(d.getTime()), `not a date: ${iso}`);
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
/** The card of one listing, as it stands on the list page. */
const cardOf = (html, id) => {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(at > 0, `the card of ${id} is not on the page`);
    const end = html.indexOf('</li>', at);
    return html.slice(at, end);
};

(async () => {
    const t = await boot({ env: { WORK_INGEST_PAGES: '2', WORK_DISCLOSURE_SAMPLE: '100' } });
    const kim = t.network.addUser('kim');
    const SAME = { 'sec-fetch-site': 'same-origin' };
    try {
        await t.ctx.ingest.runAll();

        await check('outcome 1: the salary as the board wrote it, or that the board wrote none', async () => {
            const jobs = (await t.get('/api/v1/jobs?limit=100')).json().jobs;
            const paid = jobs.find((j) => j.salary === '€70,000 – €85,000');
            const unpaid = jobs.find((j) => !j.salary);
            assert.ok(paid && unpaid, 'the fixtures need one listing with a salary and one without');
            const list = (await t.get('/jobs')).text;
            // The board's own words, character for character.
            assert.ok(cardOf(list, paid.id).includes(`Salary: ${paid.salary}`), 'the card does not carry the board\'s salary');
            // And where there is none, the card says so — it does not leave the line out, and it does not guess.
            const none = cardOf(list, unpaid.id);
            assert.ok(none.includes('Salary not listed by the employer'), 'the card does not say the salary is not listed');
            assert.ok(!/Salary:\s*€|\$\s?\d/.test(none), 'a salary was invented');
            // The listing's own page says the same thing.
            const withPay = (await t.get(`/jobs/${paid.id}`)).text;
            assert.ok(withPay.includes(`Salary: ${paid.salary}`), 'the page does not carry the board\'s salary');
            assert.ok(withPay.includes('as the board gives it'));
            const withoutPay = (await t.get(`/jobs/${unpaid.id}`)).text;
            assert.ok(withoutPay.includes('Salary not listed by the employer'), 'the page does not say the salary is not listed');
        });

        await check('outcome 2: the card names the board, links to it, and says when we first saw it there', async () => {
            const job = (await t.get('/api/v1/jobs?q=Platform%20Engineer')).json().jobs[0];
            const row = await t.ctx.s.db.one('SELECT * FROM work_listings WHERE id = $1', [job.id]);
            const card = cardOf((await t.get('/jobs')).text, job.id);
            assert.ok(card.includes('Listing from'), 'the card does not say where the listing came from');
            assert.ok(card.includes(`href="${job.url}"`), 'the card does not link the board\'s own listing');
            assert.ok(card.includes(`first seen ${dateWords(row.first_seen_at)}`), 'the card does not say when we first saw it');
            assert.ok(card.includes('rel="nofollow noopener external"'), 'the link out must stay external and nofollow');
        });

        await check('outcome 4: the jobs page shows our own disclosure rate, measured from what we fetched', async () => {
            const page = (await t.get('/jobs')).text;
            const expected = await t.ctx.s.db.one(
                `SELECT count(*) AS n, count(*) FILTER (WHERE coalesce(salary, '') <> '') AS salaried
                 FROM (SELECT salary FROM work_listings ORDER BY fetched_at DESC, id DESC LIMIT $1) t`, [100]);
            const pct = Math.round((expected.salaried / expected.n) * 100);
            assert.ok(page.includes(`Of the last ${expected.n} listings we fetched, ${expected.salaried} included a salary (${pct}%)`),
                'the disclosure rate is not the one the database gives');
            // The sample size is configuration, not a literal on the page: with a smaller sample the line follows.
            const small = await boot({ env: { WORK_INGEST_PAGES: '2', WORK_DISCLOSURE_SAMPLE: '3' } });
            try {
                await small.ctx.ingest.runAll();
                const want = await small.ctx.s.db.one(
                    `SELECT count(*) AS n, count(*) FILTER (WHERE coalesce(salary, '') <> '') AS salaried
                     FROM (SELECT salary FROM work_listings ORDER BY fetched_at DESC, id DESC LIMIT $1) t`, [3]);
                const text = (await small.get('/jobs')).text;
                assert.ok(text.includes(`Of the last ${want.n} listings we fetched, ${want.salaried} included a salary`),
                    'the sample size did not come from the configuration');
            } finally { await small.close(); }
        });

        await check('outcome 5: the listing page names the board and the exact fetch date next to the link out', async () => {
            const job = (await t.get('/api/v1/jobs?q=Platform%20Engineer')).json().jobs[0];
            const row = await t.ctx.s.db.one('SELECT * FROM work_listings WHERE id = $1', [job.id]);
            const page = (await t.get(`/jobs/${job.id}`)).text;
            assert.ok(page.includes('Read the full listing on Remotive'), 'the link out');
            assert.ok(page.includes(`Read from Remotive on ${dateWords(row.fetched_at)}`), 'the fetch date next to the link out');
            // The two sit together, in one line, so the reader sees them at once.
            assert.match(page, /Read the full listing on Remotive<\/a>[^<]*<span class="muted small">Read from Remotive on /, 'the date is not next to the link');
        });

        await check('outcome 6: we never host the description, and the page says so', async () => {
            const job = (await t.get('/api/v1/jobs?q=Platform%20Engineer')).json().jobs[0];
            const page = (await t.get(`/jobs/${job.id}`)).text;
            assert.ok(page.includes('Short excerpt only. You apply on Remotive.'), 'the promise is not a visible line');
            assert.ok(page.includes('You will run the platform other engineers build on'), 'the excerpt is missing');
            assert.ok(!page.includes('Waffle'), 'the full description was republished');
            const list = (await t.get('/jobs')).text;
            assert.ok(list.includes('Each listing is a short excerpt that links to its board.'), 'the list page does not say it either');
        });

        await check('outcome 8: no apply button and no CV upload, with the one line why', async () => {
            const job = (await t.get('/api/v1/jobs?q=Platform%20Engineer')).json().jobs[0];
            const page = (await t.get(`/jobs/${job.id}`)).text;
            assert.ok(page.includes('Short excerpt only. You apply on Remotive.'), 'the page does not say where you apply');
            assert.ok(!/<input[^>]*type="file"/.test(page), 'there is a file input on the page');
            assert.ok(!/<button[^>]*>\s*Apply/i.test(page), 'there is an apply button on the page');
            const list = (await t.get('/jobs')).text;
            assert.ok(list.includes('we host no descriptions, CVs or apply buttons'), 'the list page does not say it either');
        });

        await check('the job types are in words on the cards, in the facet and on the page, and the filter keeps the raw value', async () => {
            const jobs = (await t.get('/api/v1/jobs?limit=100')).json().jobs;
            const one = jobs.find((j) => j.job_type === 'full_time');
            const two = jobs.find((j) => j.job_type === 'permanent, full_time');
            assert.ok(one && two, 'the fixtures need a listing of each kind');
            const page = (await t.get('/jobs')).text;
            assert.ok(cardOf(page, one.id).includes('<span class="chip">Full time</span>'), 'the card does not say the job type in words');
            assert.ok(cardOf(page, two.id).includes('<span class="chip">Permanent, Full time</span>'), 'the card does not say the job type in words');
            assert.ok(!page.includes('permanent, full_time'), 'a raw job type is shown');
            assert.match(page, />Full time <span class="facet-n">/, 'the facet is not in words');
            assert.ok(page.includes('href="/jobs?type=full_time"'), 'the facet does not keep the raw query value');
            // The listing's own page says it in words too, and its tags are the cards' chips.
            const detail = (await t.get(`/jobs/${one.id}`)).text;
            assert.ok(detail.includes('<span class="job-type">Full time</span>'), 'the page does not say the job type in words');
            assert.ok(detail.includes('<span class="chip chip-tag">'), 'the tags are not chips');
        });

        await check('outcome 3: a listing the board stopped showing is hidden, and says so when the link is followed', async () => {
            const job = (await t.get('/api/v1/jobs?q=Platform%20Engineer')).json().jobs[0];
            const row = await t.ctx.s.db.one('SELECT * FROM work_listings WHERE id = $1', [job.id]);
            await t.ctx.s.db.exec('UPDATE work_listings SET expired = true WHERE id = $1', [job.id]);
            // Hidden: out of the search and out of the list.
            assert.ok(!(await t.get('/jobs')).text.includes(`id="${job.id}"`), 'the expired listing is still listed');
            assert.strictEqual((await t.get(`/api/v1/jobs/${job.id}`)).status, 404, 'the API still offers it');
            // And the old link answers with the truth: gone, and the day we last saw it.
            const page = await t.get(`/jobs/${job.id}`);
            assert.strictEqual(page.status, 404, 'a listing that is gone must not answer 200');
            assert.ok(page.text.includes('No longer on the board'), 'the page does not say the listing is gone');
            assert.ok(page.text.includes(`Last seen on Remotive on ${dateWords(row.last_seen_at)}`), 'the page does not say when we last saw it');
            assert.ok(page.text.includes(job.url), 'the board\'s own listing is still linked');
        });

        await check('outcome 7: a saved search says what it looks for and when it last ran, and its alerts come from Watch', async () => {
            const saved = await t.get('/saved', { as: kim, form: { q: 'engineer', remote: 'true' }, headers: SAME });
            assert.strictEqual(saved.status, 303);
            const page = (await t.get('/saved', { as: kim })).text;
            assert.ok(page.includes('“engineer”'), 'the saved search does not say what it looks for');
            assert.ok(page.includes('remote'), 'the saved search does not say what it looks for');
            assert.match(page, /last ran <time datetime="[^"]+">/, 'the saved search does not say when it last ran');
            assert.ok(page.includes('Alerts for a search come from OpenVibe.Watch, on the same account.'), 'the alerts are not said to come from Watch on the same account');
            assert.ok(page.includes('openvibe.watch'), 'there is no link to Watch');
            // And the search it keeps is the search it runs.
            assert.match(page, /href="\/jobs\?q=engineer&amp;remote=true"/, 'no link to run it again');
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
