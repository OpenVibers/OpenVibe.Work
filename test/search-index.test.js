'use strict';
/**
 * Listing pages in OpenVibe.Search (server/search-index.js): after an ingest run every listing is one
 * work.index_document.upserted in the outbox, exactly the contract (the event payload and search.index-document@1),
 * with the page's URL, the board as provenance and the original listing's URL; a second sweep sends nothing; a listing
 * that changes is re-sent at the next revision; one that expires becomes a tombstone; the ingest run itself triggers
 * the sweep.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

const DAY = 86_400_000;

(async () => {
    const clock = { t: Date.parse('2026-10-01T06:00:00Z') };
    const t = await boot({ now: () => clock.t, env: { WORK_INGEST_PAGES: '2' } });
    const { s, search, ingest } = t.ctx;
    const outbox = async () => (await s.db.many('SELECT envelope FROM event_outbox ORDER BY id')).map((r) => r.envelope);
    const valid = (env) => {
        const e = contracts.validate('events.event-envelope@1', env);
        assert.ok(e.valid, `envelope: ${JSON.stringify(e.errors)}`);
        const p = contracts.validate(env.event_type, env.payload);
        assert.ok(p.valid, `${env.event_type}: ${JSON.stringify(p.errors)}`);
        if (env.event_type.endsWith('.upserted')) {
            const d = contracts.validate('search.index-document@1', env.payload);
            assert.ok(d.valid, `search.index-document@1: ${JSON.stringify(d.errors)}`);
        }
        assert.strictEqual(env.source, 'work');
        assert.strictEqual(env.visibility, 'internal');
        assert.strictEqual(env.subject.id, env.payload.id);
        return env;
    };

    try {
        await check('an ingest run puts every listing in the outbox, as the contract says', async () => {
            await ingest.runAll();
            await search.sweep();   // the run's own sweep is fire-and-forget; this one waits (and shares or repeats it)
            const envs = (await outbox()).map(valid);
            const listings = await s.db.many('SELECT * FROM work_listings ORDER BY id');
            assert.strictEqual(listings.length, 8);
            assert.strictEqual(envs.length, 8, 'one document per listing, sent once');
            assert.ok(envs.every((e) => e.event_type === 'work.index_document.upserted'));
            const byId = new Map(envs.map((e) => [e.payload.id, e.payload]));
            const devops = listings.find((r) => r.title.includes('DevOps'));
            const doc = byId.get(devops.id);
            assert.strictEqual(doc.canonical_url, `https://openvibe.work/jobs/${devops.id}`);
            assert.strictEqual(doc.title, `${devops.title} at ${devops.company}`);
            assert.strictEqual(doc.authorship, 'imported');
            assert.strictEqual(doc.visibility, 'public');
            assert.deepStrictEqual(doc.indexability, { decision: 'index', reasons: [] });
            assert.strictEqual(doc.facets.source, 'remoteok');
            assert.strictEqual(doc.facets.remote, true);
            assert.match(doc.body, /Skyward Cloud/);
            assert.match(doc.summary, /\$90,000–\$130,000 a year/);
            assert.deepStrictEqual(doc.provenance.map((p) => [p.service, p.type, p.label, p.url]),
                [['work', 'board_listing', 'RemoteOK', devops.url]], 'the board and the original listing travel with it');
            assert.ok(!JSON.stringify(envs).includes('personal use'), 'RemoteOK\'s legal notice is not a document');
        });

        await check('a second sweep sends nothing; a changed listing is sent again at the next revision', async () => {
            const before = (await outbox()).length;
            const again = await search.sweep();
            assert.deepStrictEqual(again.job, { seen: 8, sent: 0, removed: 0, failed: 0 });
            assert.strictEqual((await outbox()).length, before);
            const one = await s.db.one("SELECT * FROM work_listings WHERE source = 'arbeitnow' ORDER BY id LIMIT 1");
            await s.db.exec('UPDATE work_listings SET salary = $1 WHERE id = $2', ['€70,000 a year', one.id]);
            const res = await search.sweep();
            assert.strictEqual(res.job.sent, 1);
            const last = valid((await outbox()).pop());
            assert.strictEqual(last.payload.id, one.id);
            assert.strictEqual(last.payload.revision, 2);
            assert.match(last.payload.summary, /€70,000 a year/);
        });

        await check('a listing that expires (its page answers 404) becomes a tombstone, once', async () => {
            const one = await s.db.one("SELECT * FROM work_listings WHERE source = 'remotive' ORDER BY id LIMIT 1");
            await s.db.exec('UPDATE work_listings SET expired = true WHERE id = $1', [one.id]);
            assert.strictEqual((await t.get(`/jobs/${one.id}`)).status, 404);
            const res = await search.sweep();
            assert.strictEqual(res.job.sent, 1);
            const last = valid((await outbox()).pop());
            assert.strictEqual(last.event_type, 'work.index_document.deleted');
            assert.deepStrictEqual(last.payload, { type: 'job', id: one.id, revision: 2 });
            assert.strictEqual((await search.sweep()).job.sent, 0, 'a tombstone is not re-sent');
            // A row deleted outright is tombstoned too (exists()).
            const gone = await s.db.one("SELECT * FROM work_listings WHERE source = 'arbeitnow' AND expired = false ORDER BY id DESC LIMIT 1");
            await s.db.exec('DELETE FROM work_listings WHERE id = $1', [gone.id]);
            assert.strictEqual((await search.sweep()).job.removed, 1);
        });

        await check('the ingest run triggers the sweep itself', async () => {
            const before = (await outbox()).length;
            clock.t += 3 * DAY;
            t.boards.add && t.boards.add('remotive', { id: 990001, title: 'Staff platform engineer', company_name: 'Northwind', url: 'https://remotive.com/remote-jobs/software-dev/staff-platform-engineer-990001', candidate_required_location: 'Worldwide', job_type: 'full_time', publication_date: '2026-10-04T08:00:00', description: '<p>Platform work.</p>', tags: ['go'] });
            await ingest.runAll();
            for (let i = 0; i < 100 && (await outbox()).length === before; i += 1) await new Promise((r) => setTimeout(r, 50));
            assert.ok((await outbox()).length > before, 'the run swept: something changed (fetched_at moved), so something was sent');
        });

        await check('the outbox relay stays off without the events URL and the client secret; rows wait', async () => {
            const st = await search.status();
            assert.strictEqual(st.enabled, false);
            assert.ok(st.pending > 0);
        });
    } finally {
        await done(t);
    }
})();
