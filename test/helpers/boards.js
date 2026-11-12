'use strict';
/**
 * A stand-in Remotive API for the one board Work still reads itself (test/ingest.test.js). Its payload is the shape
 * Remotive documents, with fixtures of ours (no real listing is copied here) including a description longer than the
 * excerpt Work keeps.
 *
 * The other boards are not here because Work does not fetch them: Arbeitnow, We Work Remotely, Hacker News "Who is
 * hiring" and RemoteOK are served by OpenVibe.Sources, and their tests use a Sources feed stand-in instead.
 *
 *   const b = await startBoards();
 *   b.env                      WORK_REMOTIVE_URL, for boot({ env })
 *   b.state.remotive = 'fail'  the board answering HTTP 500 (default 'ok')
 *   b.add('remotive', row)     a listing the board starts showing (see b.fixtures)
 *   b.requests                 [{ path, query, userAgent }] for every call
 */
const http = require('http');

/** One listing per board, in that board's own payload shape. */
function fixtures() {
    return {
        remotive: [
            {
                id: 1900123,
                url: 'https://remotive.com/remote-jobs/software-dev/support-engineer-1900123',
                title: 'Support Engineer',
                company_name: 'Cassiopeia',
                category: 'Software Development',
                tags: ['customer support', 'saas'],
                job_type: 'full_time',
                publication_date: '2026-09-30T09:12:00',
                candidate_required_location: 'Europe',
                salary: '€45,000 – €55,000',
                description: '<p>Answer customers, write runbooks.</p><p>Postgres and a sharp eye.</p>',
            },
            {
                id: 1900789,
                url: 'https://remotive.com/remote-jobs/software-dev/platform-engineer-1900789',
                title: 'Platform Engineer',
                company_name: 'Meridian Rail',
                category: 'Software Development',
                tags: ['kubernetes', 'terraform'],
                job_type: 'full_time',
                publication_date: '2026-09-29T07:45:00',
                candidate_required_location: 'Remote (EU)',
                salary: '€70,000 – €85,000',
                // Longer than the excerpt we keep, so a test can prove the tail is never stored or shown.
                description: `<p>You will run the platform other engineers build on.</p>
<p>That means Kubernetes clusters, Terraform modules, a queue nobody has to think about, and an on-call rotation that
people actually join voluntarily. We look after the boring parts of shipping software so product teams do not have to.</p>
<p>You will work with people across four time zones, mostly in writing. We keep our runbooks honest and our postmortems
blameless. The office dog is called Waffle.</p>`,
            },
            {
                id: 1900456,
                url: 'https://remotive.com/remote-jobs/marketing/content-marketer-1900456',
                title: 'Content Marketer',
                company_name: 'Longform Ltd',
                category: 'Marketing',
                tags: ['writing'],
                job_type: 'contract',
                publication_date: '2026-09-28T14:00:00',
                candidate_required_location: 'Worldwide',
                salary: '',
                description: '<p>Write about developer tools.</p>',
            },
        ],
    };
}

async function startBoards() {
    const data = fixtures();
    const requests = [];
    const state = { remotive: 'ok' };
    const added = { remotive: [] };

    const send = (res, status, body, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://stand-in');
        requests.push({ path: url.pathname, query: url.search, userAgent: req.headers['user-agent'] || '', accept: req.headers.accept || '' });
        const board = url.pathname.replace(/^\//, '');
        if (board !== 'remotive') return send(res, 404, { error: 'not a board Work reads' });
        if (state.remotive === 'fail') return send(res, 500, { error: 'the board is having a bad day' }, 'text/plain');
        if (state.remotive === 'html') return send(res, 200, '<html>not json</html>', 'text/html');
        return send(res, 200, { 'job-count': data.remotive.length + added.remotive.length, jobs: [...data.remotive, ...added.remotive] });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    return {
        url: base,
        fixtures: data,
        state,
        requests,
        env: { WORK_REMOTIVE_URL: `${base}/remotive` },
        /** Make the board start showing one more listing (the shape of its own payload). */
        add(board, row) { added[board].push(row); },
        reset() { Object.assign(state, { remotive: 'ok' }); requests.length = 0; },
        close: () => new Promise((r) => server.close(r)),
    };
}

module.exports = { startBoards, fixtures };
