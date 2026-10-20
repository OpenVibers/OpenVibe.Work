'use strict';
/**
 * Applications: tracking one from a listing or by hand, one per person per listing, the status-change history, the
 * applied_at auto-stamp, validation, the cap, the capability rule for app tokens, asking the person's OpenVibe.Actor
 * agent through an injected client, and the pages. The clock is the test's own, because applied_at is a claim about
 * time.
 */
const assert = require('assert');
const { serviceAuth, ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

const SAME = { 'sec-fetch-site': 'same-origin' };

/** A stand-in OpenVibe.Actor client: records calls and returns (or throws) what each test asks. */
function makeActor() {
    const actor = { available: true, calls: [], impl: null };
    actor.createTask = async (args) => {
        actor.calls.push(args);
        if (actor.impl) return actor.impl(args);
        return { id: 'tsk_01JZ0000000000000000000000TK', state: 'queued' };
    };
    return actor;
}

/** An app token for audience openvibe.work, with the grants given. */
function appToken(t, cap = []) {
    const now = Math.floor(Date.now() / 1000);
    const project = ids.newId('project');
    return serviceAuth.signServiceToken({
        iss: t.network.url,
        sub: `app:${ids.newId('app')}`,
        actor_type: 'app',
        aud: ['openvibe.work'],
        cap,
        ns: [project],
        project_id: project,
        env: 'production',
        iat: now,
        exp: now + 300,
        jti: `tok_${'a'.repeat(12)}`,
    }, t.network.privatePem);
}

(async () => {
    const clock = { t: Date.now() };
    const actor = makeActor();
    const t = await boot({ now: () => clock.t, actor });
    const kim = t.network.addUser('kim');
    const lee = t.network.addUser('lee');

    try {
        await t.ctx.ingest.runAll();
        const firstListing = async () => (await t.get('/api/v1/jobs?limit=1')).json().jobs[0];

        await check('an application is a person\'s: anonymous is 401, an app token is 403, nobody sees anybody else\'s', async () => {
            assert.strictEqual((await t.get('/api/v1/me/applications')).status, 401);
            assert.strictEqual((await t.get('/api/v1/me/applications')).json().code, 'token.required');

            assert.strictEqual((await t.get('/api/v1/me/applications', { bearer: appToken(t) })).status, 403, 'an app token without work.application.manage is refused');

            const made = await t.get('/api/v1/me/applications', { as: kim, json: { title: 'Backend Engineer', company: 'Acme', url: 'https://acme.example/jobs/1' }, headers: SAME });
            assert.strictEqual(made.status, 201, made.text);
            const mine = made.json();
            assert.match(mine.id, /^wap_[0-9A-HJKMNP-TV-Z]{26}$/);
            assert.strictEqual(mine.status, 'saved');
            assert.strictEqual(mine.title, 'Backend Engineer');

            assert.deepStrictEqual((await t.get('/api/v1/me/applications', { as: lee })).json().applications, [], 'another person saw my application');
            assert.strictEqual((await t.get(`/api/v1/me/applications/${mine.id}`, { as: lee })).status, 404);
            assert.strictEqual((await t.get(`/api/v1/me/applications/${mine.id}`, { as: lee, method: 'DELETE', headers: SAME })).status, 404);
        });

        await check('creating from a listing copies title/company/url, and a second POST for the same listing answers 200 with the existing one', async () => {
            const listing = await firstListing();
            const made = await t.get('/api/v1/me/applications', { as: kim, json: { listing_id: listing.id }, headers: SAME });
            assert.strictEqual(made.status, 201, made.text);
            const one = made.json();
            assert.strictEqual(one.listing_id, listing.id);
            assert.strictEqual(one.title, listing.title);
            assert.strictEqual(one.company, listing.company);
            assert.strictEqual(one.url, listing.url);

            const again = await t.get('/api/v1/me/applications', { as: kim, json: { listing_id: listing.id }, headers: SAME });
            assert.strictEqual(again.status, 200, again.text);
            assert.strictEqual(again.json().id, one.id, 'a duplicate listing should return the existing application');
        });

        await check('a status change appends an event, and setting applied with no applied_at stamps now', async () => {
            const made = (await t.get('/api/v1/me/applications', { as: kim, json: { title: 'Designer', company: 'Raytrace', url: 'https://raytrace.example/jobs/9' }, headers: SAME })).json();
            const patched = await t.get(`/api/v1/me/applications/${made.id}`, { as: kim, method: 'PATCH', json: { status: 'applied' }, headers: SAME });
            assert.strictEqual(patched.status, 200, patched.text);
            const applied = patched.json();
            assert.strictEqual(applied.status, 'applied');
            assert.strictEqual(applied.applied_at, new Date(clock.t).toISOString(), 'applied_at was not auto-stamped');

            const detail = (await t.get(`/api/v1/me/applications/${made.id}`, { as: kim })).json();
            assert.strictEqual(detail.events.length, 1);
            assert.deepStrictEqual({ from_status: detail.events[0].from_status, to_status: detail.events[0].to_status }, { from_status: 'saved', to_status: 'applied' });

            const notes = await t.get(`/api/v1/me/applications/${made.id}`, { as: kim, method: 'PATCH', json: { notes: 'hiring manager: Sam', next_step: 'portfolio' }, headers: SAME });
            assert.strictEqual(notes.status, 200);
            assert.strictEqual((await t.get(`/api/v1/me/applications/${made.id}`, { as: kim })).json().events.length, 1, 'a non-status edit appended an event');

            clock.t += 60_000;
            const interviewing = await t.get(`/api/v1/me/applications/${made.id}`, { as: kim, method: 'PATCH', json: { status: 'interviewing' }, headers: SAME });
            assert.strictEqual(interviewing.status, 200);
            const after = (await t.get(`/api/v1/me/applications/${made.id}`, { as: kim })).json();
            assert.strictEqual(after.events.length, 2);
            assert.deepStrictEqual(after.events[0].from_status, 'applied');
            assert.deepStrictEqual(after.events[0].to_status, 'interviewing');
        });

        await check('validation: unknown fields, a bad status and over-long notes are 400', async () => {
            const unknown = await t.get('/api/v1/me/applications', { as: kim, json: { title: 'x', company: 'y', url: 'https://y.example', salary: 1 }, headers: SAME });
            assert.strictEqual(unknown.status, 400);
            assert.strictEqual(unknown.json().code, 'work.applications.unknown_field');

            const noTitle = await t.get('/api/v1/me/applications', { as: kim, json: { company: 'y', url: 'https://y.example' }, headers: SAME });
            assert.strictEqual(noTitle.status, 400);
            assert.strictEqual(noTitle.json().code, 'work.applications.title_required');

            const badUrl = await t.get('/api/v1/me/applications', { as: kim, json: { title: 'x', company: 'y', url: 'not a url' }, headers: SAME });
            assert.strictEqual(badUrl.status, 400);
            assert.strictEqual(badUrl.json().code, 'work.applications.url_invalid');

            const made = (await t.get('/api/v1/me/applications', { as: kim, json: { title: 'x', company: 'y', url: 'https://y.example' }, headers: SAME })).json();
            const badStatus = await t.get(`/api/v1/me/applications/${made.id}`, { as: kim, method: 'PATCH', json: { status: 'hired' }, headers: SAME });
            assert.strictEqual(badStatus.status, 400);
            assert.strictEqual(badStatus.json().code, 'work.applications.status_invalid');

            const longNotes = await t.get(`/api/v1/me/applications/${made.id}`, { as: kim, method: 'PATCH', json: { notes: 'n'.repeat(5001) }, headers: SAME });
            assert.strictEqual(longNotes.status, 400);
            assert.strictEqual(longNotes.json().code, 'work.applications.notes_too_long');

            const badFilter = await t.get('/api/v1/me/applications?status=hired', { as: kim });
            assert.strictEqual(badFilter.status, 400);
            assert.strictEqual(badFilter.json().code, 'work.applications.status_invalid');
        });

        await check('the cap: one more than the configured maximum is refused 409', async () => {
            const small = await boot({ env: { WORK_APPLICATIONS_MAX: '2' } });
            const user = small.network.addUser('kim');
            try {
                for (let i = 0; i < 2; i++) {
                    const r = await small.get('/api/v1/me/applications', { as: user, json: { title: `job ${i}`, company: 'Acme', url: 'https://acme.example/job' }, headers: SAME });
                    assert.strictEqual(r.status, 201, r.text);
                }
                const full = await small.get('/api/v1/me/applications', { as: user, json: { title: 'job 3', company: 'Acme', url: 'https://acme.example/job' }, headers: SAME });
                assert.strictEqual(full.status, 409);
                assert.strictEqual(full.json().code, 'work.applications_full');
            } finally { await small.close(); }
        });

        await check('asking the agent: idempotency key, task_url, the ask and subject travel to Actor', async () => {
            actor.available = true;
            actor.impl = null;
            actor.calls.length = 0;
            const listing = await firstListing();
            const made = (await t.get('/api/v1/me/applications', { as: kim, json: { listing_id: listing.id }, headers: SAME })).json();
            const res = await t.get(`/api/v1/me/applications/${made.id}/assist`, { as: kim, json: { ask: 'Emphasise my systems experience.' }, headers: SAME });
            assert.strictEqual(res.status, 200, res.text);
            const out = res.json();
            assert.strictEqual(out.task_id, 'tsk_01JZ0000000000000000000000TK');
            assert.strictEqual(out.task_url, 'https://openvibe.actor/tasks/tsk_01JZ0000000000000000000000TK');

            assert.strictEqual(actor.calls.length, 1);
            assert.strictEqual(actor.calls[0].idempotencyKey, `work-assist:${made.id}:1`);
            assert.strictEqual(actor.calls[0].subjectId, kim.subject);
            assert.ok(actor.calls[0].task.includes(made.title));
            assert.ok(actor.calls[0].task.includes(made.company));
            assert.ok(actor.calls[0].task.includes(made.url));
            assert.ok(actor.calls[0].task.includes('Emphasise my systems experience.'));
            assert.ok(actor.calls[0].task.includes('Excerpt:'), 'the listing excerpt is in the task text');

            const stored = (await t.get(`/api/v1/me/applications/${made.id}`, { as: kim })).json();
            assert.strictEqual(stored.actor_task_id, out.task_id);

            const second = await t.get(`/api/v1/me/applications/${made.id}/assist`, { as: kim, json: {}, headers: SAME });
            assert.strictEqual(second.status, 200);
            assert.strictEqual(actor.calls[1].idempotencyKey, `work-assist:${made.id}:2`);
            assert.strictEqual(actor.calls[1].subjectId, kim.subject);
        });

        await check('assist: Actor unavailable is 503, and Actor\'s 402/429 refusal passes through as 409', async () => {
            const made = (await t.get('/api/v1/me/applications', { as: kim, json: { title: 'SRE', company: 'Acme', url: 'https://acme.example/sre' }, headers: SAME })).json();

            actor.available = false;
            actor.calls.length = 0;
            const unavailable = await t.get(`/api/v1/me/applications/${made.id}/assist`, { as: kim, json: {}, headers: SAME });
            assert.strictEqual(unavailable.status, 503);
            assert.strictEqual(unavailable.json().code, 'work.actor_unavailable');
            assert.strictEqual(actor.calls.length, 0, 'an unavailable Actor is never called');

            actor.available = true;
            actor.impl = () => { throw Object.assign(new Error('over budget'), { status: 429, code: 'actor.budget.exceeded', detail: 'over budget' }); };
            const refused = await t.get(`/api/v1/me/applications/${made.id}/assist`, { as: kim, json: {}, headers: SAME });
            assert.strictEqual(refused.status, 409);
            assert.strictEqual(refused.json().code, 'actor.budget.exceeded');

            actor.impl = () => { throw Object.assign(new Error('boom'), { status: 500 }); };
            const error = await t.get(`/api/v1/me/applications/${made.id}/assist`, { as: kim, json: {}, headers: SAME });
            assert.strictEqual(error.status, 503);
            assert.strictEqual(error.json().code, 'work.actor_unavailable');
            actor.impl = null;
        });

        await check('asking the agent is limited to 10 per person per day', async () => {
            const t2 = await boot({ actor: makeActor() });
            const user = t2.network.addUser('kim');
            try {
                const made = (await t2.get('/api/v1/me/applications', { as: user, json: { title: 'PM', company: 'Acme', url: 'https://acme.example/pm' }, headers: SAME })).json();
                for (let i = 0; i < 10; i++) {
                    const r = await t2.get(`/api/v1/me/applications/${made.id}/assist`, { as: user, json: {}, headers: SAME });
                    assert.strictEqual(r.status, 200, `assist ${i + 1}`);
                }
                const over = await t2.get(`/api/v1/me/applications/${made.id}/assist`, { as: user, json: {}, headers: SAME });
                assert.strictEqual(over.status, 429);
                assert.strictEqual(over.json().code, 'rate_limited');
            } finally { await t2.close(); }
        });

        await check('the pages: signed out is an explanation, signed in lists and edits, and a listing page tracks', async () => {
            const anon = await t.get('/applications');
            assert.strictEqual(anon.status, 200);
            assert.match(anon.text, /Sign in with OpenVibe/);
            assert.match(anon.text, /rel="nofollow" href="\/auth\/login/);

            const listing = await firstListing();
            const before = await t.get(`/jobs/${listing.id}`);
            assert.match(before.text, /Sign in/, 'a signed-out listing page offers a sign-in for tracking');
            // Crawlers followed each listing's sign-in link (7,954 sign-in redirects from Meta's crawler on 2026-10-20).
            assert.match(before.text, /<a rel="nofollow" href="\/auth\/login\?next=%2Fjobs%2F/, 'the sign-in link is nofollow');
            assert.doesNotMatch(before.text, /Track this job/, 'a signed-out listing page has no tracking form');

            const trackedPage = await t.get(`/jobs/${listing.id}`, { as: lee });
            assert.match(trackedPage.text, /Track this job/, 'a signed-in listing page offers tracking');

            const tracked = await t.get(`/jobs/${listing.id}/track`, { as: lee, method: 'POST', headers: SAME });
            assert.strictEqual(tracked.status, 303);
            assert.match(tracked.headers.get('location'), /^\/applications\/wap_/);

            const again = await t.get(`/jobs/${listing.id}`, { as: lee });
            assert.match(again.text, /Tracked: Saved/, 'an already-tracked listing says so');
            assert.match(again.text, /Open your application/);

            const list = await t.get('/applications', { as: lee });
            assert.strictEqual(list.status, 200);
            assert.match(list.text, /Applications/);
            assert.match(list.text, /Add one by hand/);

            const id = tracked.headers.get('location').split('/').pop();
            const detail = await t.get(`/applications/${id}`, { as: lee });
            assert.strictEqual(detail.status, 200);
            assert.match(detail.text, /<select name="status">/);
            assert.match(detail.text, /Ask my agent/);
            assert.match(detail.text, /Delete this application/);

            const foreign = await t.get(`/applications/${id}/delete`, { as: lee, method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, redirect: 'manual' });
            assert.strictEqual(foreign.status, 403, 'a cross-site delete is refused');
            const gone = await t.get(`/applications/${id}/delete`, { as: lee, method: 'POST', headers: SAME, redirect: 'manual' });
            assert.strictEqual(gone.status, 303);
            assert.strictEqual((await t.get(`/applications/${id}`, { as: lee })).status, 404, 'the deleted application is gone');
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
