'use strict';
/**
 * Stand-in job boards for the ingest tests: one HTTP server with a path per board, answering the shape each real API
 * documents, with small fixtures written to look like the real thing (including RemoteOK's legal notice as the first
 * array element, and an Arbeitnow listing whose title carries a <script> tag, so the pages' escaping is provable).
 *
 *   const b = await startBoards();
 *   b.env                      WORK_ARBEITNOW_URL / WORK_REMOTIVE_URL / WORK_REMOTEOK_URL, for boot({ env })
 *   b.state.arbeitnow = 'fail' one board answering HTTP 500 (default 'ok')
 *   b.state.remotive = 'json'  one board answering something that is not JSON
 *   b.add('arbeitnow', row)    a listing the board starts showing (see b.fixtures for the shape)
 *   b.requests                 [{ path, query, userAgent }] for every call
 *
 * The fixtures are ours, not a board's: no real listing is copied here.
 */
const http = require('http');

/** One listing per board, in that board's own payload shape. */
function fixtures() {
    return {
        arbeitnow: [
            {
                slug: 'senior-backend-engineer-berlin',
                company_name: 'Nordlicht Systems',
                title: 'Senior Backend Engineer (Node.js)',
                description: '<p>We run a fleet of Node.js services.</p><ul><li>PostgreSQL</li><li>Valkey</li></ul><p>You will own the billing pipeline end to end.</p>',
                remote: false,
                url: 'https://www.arbeitnow.com/view/senior-backend-engineer-berlin-12345',
                tags: ['nodejs', 'postgresql'],
                job_types: ['permanent'],
                location: 'Berlin, Germany',
                created_at: 1791500000,
            },
            {
                slug: 'frontend-engineer-remote-eu',
                company_name: 'Helles Werk',
                title: 'Frontend Engineer <script>alert("xss")</script>',
                description: '<div>Build the design system.<script>window.__pwned = true</script></div><div>TypeScript, CSS.</div>',
                remote: true,
                url: 'https://www.arbeitnow.com/view/frontend-engineer-remote-eu-23456',
                tags: ['typescript', 'css'],
                job_types: ['permanent', 'full_time'],
                location: 'Remote (EU)',
                created_at: 1791600000,
            },
        ],
        arbeitnowPage2: [
            {
                slug: 'data-analyst-munich',
                company_name: 'Alpen Daten',
                title: 'Data Analyst',
                description: '<p>SQL, dashboards and a lot of questions.</p>',
                remote: false,
                url: 'https://www.arbeitnow.com/view/data-analyst-munich-34567',
                tags: ['sql'],
                job_types: ['permanent'],
                location: 'Munich, Germany',
                created_at: 1791700000,
            },
        ],
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
        remoteok: [
            { legal: "RemoteOK's API is offered for personal use; please link back to the listing and name RemoteOK as the source." },
            {
                id: '1049001',
                slug: 'devops-engineer-skyward',
                company: 'Skyward Cloud',
                position: 'DevOps Engineer',
                tags: ['devops', 'kubernetes'],
                location: 'Worldwide',
                salary_min: 90000,
                salary_max: 130000,
                date: '2026-10-01T08:00:00+00:00',
                url: 'https://remoteok.com/remote-jobs/remote-devops-engineer-skyward-1049001',
                description: '<p>Kubernetes, Terraform, on-call.</p>',
            },
            {
                id: '1049002',
                slug: 'technical-writer-atlas',
                company: 'Atlas Docs',
                position: 'Technical Writer',
                tags: ['docs'],
                location: 'EU',
                salary_min: null,
                salary_max: null,
                date: '2026-09-25T08:00:00+00:00',
                url: 'https://remoteok.com/remote-jobs/remote-technical-writer-atlas-1049002',
                description: '<p>Document an API.</p>',
            },
        ],
    };
}

async function startBoards() {
    const data = fixtures();
    const requests = [];
    const state = { arbeitnow: 'ok', remotive: 'ok', remoteok: 'ok' };
    const added = { arbeitnow: [], remotive: [], remoteok: [] };

    const send = (res, status, body, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://stand-in');
        requests.push({ path: url.pathname, query: url.search, userAgent: req.headers['user-agent'] || '', accept: req.headers.accept || '' });
        const board = url.pathname.replace(/^\//, '');
        if (!['arbeitnow', 'remotive', 'remoteok'].includes(board)) return send(res, 404, { error: 'not a board' });
        if (state[board] === 'fail') return send(res, 500, { error: 'the board is having a bad day' }, 'text/plain');
        if (state[board] === 'html') return send(res, 200, '<html>not json</html>', 'text/html');
        if (board === 'arbeitnow') {
            const page = Number(url.searchParams.get('page') || 1);
            const rows = page === 1 ? data.arbeitnow : page === 2 ? data.arbeitnowPage2 : [];
            return send(res, 200, { data: [...rows, ...added.arbeitnow], links: { next: page < 2 ? `https://www.arbeitnow.com/api/job-board-api?page=${page + 1}` : null } });
        }
        if (board === 'remotive') return send(res, 200, { 'job-count': data.remotive.length + added.remotive.length, jobs: [...data.remotive, ...added.remotive] });
        // RemoteOK: the legal notice is element 0, exactly as the real API sends it.
        return send(res, 200, [...data.remoteok.slice(0, 1), ...data.remoteok.slice(1), ...added.remoteok]);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    return {
        url: base,
        fixtures: data,
        state,
        requests,
        env: { WORK_ARBEITNOW_URL: `${base}/arbeitnow`, WORK_REMOTIVE_URL: `${base}/remotive`, WORK_REMOTEOK_URL: `${base}/remoteok` },
        /** Make a board start showing one more listing (the shape of that board's own payload). */
        add(board, row) { added[board].push(row); },
        reset() { Object.assign(state, { arbeitnow: 'ok', remotive: 'ok', remoteok: 'ok' }); requests.length = 0; },
        close: () => new Promise((r) => server.close(r)),
    };
}

module.exports = { startBoards, fixtures };
