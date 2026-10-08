'use strict';
/**
 * ADR-033: Work's part of an account export (a person's saved searches) and of an account deletion, applied through
 * the service's own /internal/events route with a stand-in Network. Real rows are made through the service's store,
 * the signed delivery is answered by openvibe-sdk/account-data, and the part only ever carries person A's rows. A
 * redelivery erases nothing twice, and the route refuses a bad signature and a forwarded request.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');
const { createNetworkSender } = require('openvibe-sdk/account-data');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const jobsStore = require('../server/jobs/store');

const A = 'usr_01JZ0000000000000000000AAA';
const B = 'usr_01JZ0000000000000000000BBB';
const OLD = 'usr_01JZ0000000000000000000MRG';
const EXP = 'exp_01JZ0000000000000000000EXP';
const DEL = 'del_01JZ0000000000000000000DEX';
// Fixture secrets, built so they never look like a real key to a scanner.
const SECRET = `whsec_${'fixture'.repeat(6)}`;
const WRONG = `whsec_${'mismatch'.repeat(5)}`;

const exportEvent = { event_id: 'evt_01JZ0000000000000000000E01', event_type: 'network.account.export_requested', source: 'network', payload: { export_id: EXP, subject: A } };
const deleteEvent = { event_id: 'evt_01JZ0000000000000000000D01', event_type: 'network.account.deleted', source: 'network', payload: { deletion_id: DEL, subject: A, aliases: [OLD] } };
const bodyOf = (ev) => JSON.stringify({ event: ev, seq: 1 });

/** A stand-in for Network's internal routes: the token endpoint, the export part and the deletion confirmation. */
async function startNetworkStub({ partStatus = 201, confirmStatus = 201 } = {}) {
    const calls = [];
    const statusOf = (v) => (typeof v === 'function' ? v() : v);
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks);
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url === '/oauth/token') return json(200, { access_token: 'tok_work', token_type: 'Bearer', expires_in: 300, scope: 'openvibe.network' });
            calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw.toString() || 'null') });
            return json(req.url.includes('/parts') ? statusOf(partStatus) : statusOf(confirmStatus), {});
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

/** Save a search for one person, through the store the API writes with (server/jobs/store.js). */
async function makeRows(t, subject, q) {
    const s = t.ctx.s;
    const out = await jobsStore.createSaved(s, `user:${subject}`, { q, remote: 'true', type: 'full-time', location: 'berlin' }, { id: s.newId('ssc'), now: s.iso() });
    assert.ok(out.row, 'the saved search was created');
    return out.row;
}

(async () => {
    await check('an export part carries only the person\'s saved searches, and no secret', async () => {
        const stub = await startNetworkStub();
        const sender = createNetworkSender({ networkInternalUrl: stub.url, clientId: 'work', clientSecret: 'work-secret' });
        const t = await boot({ env: { WORK_EVENTS_SECRET: SECRET }, accountSend: sender });
        try {
            await makeRows(t, A, 'person-a');
            await makeRows(t, B, 'person-b');

            const res = await t.get('/internal/events', { method: 'POST', body: bodyOf(exportEvent), headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(bodyOf(exportEvent), SECRET) } });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.json().outcome, 'exported');

            const part = stub.calls.find((c) => c.url === `/internal/account-exports/${EXP}/parts`);
            assert.ok(part, 'the part was pushed to Network');
            assert.strictEqual(part.auth, 'Bearer tok_work', 'with this service\'s own token');
            assert.strictEqual(part.body.subject, A);
            assert.deepStrictEqual(part.body.files.map((f) => f.name).sort(), ['saved_searches.json']);
            const saved = part.body.files.find((f) => f.name === 'saved_searches.json').content;
            assert.strictEqual(saved.length, 1);
            assert.strictEqual(saved[0].query, 'person-a');
            assert.ok(!JSON.stringify(part.body).includes('person-b'), 'nobody else\'s rows');
            assert.ok(!/token|secret|password/i.test(JSON.stringify(part.body)), 'no secret is exported');
        } finally { await t.close(); await stub.close(); }
    });

    await check('a deletion erases the person and their aliases once, keeps someone else, and confirms with counts', async () => {
        const stub = await startNetworkStub();
        const sender = createNetworkSender({ networkInternalUrl: stub.url, clientId: 'work', clientSecret: 'work-secret' });
        const t = await boot({ env: { WORK_EVENTS_SECRET: SECRET }, accountSend: sender });
        try {
            await makeRows(t, A, 'person-a');
            await makeRows(t, B, 'person-b');
            const gone = async (subject) => await t.ctx.s.db.value('SELECT count(*)::int FROM work_saved_searches WHERE subject = $1', [`user:${subject}`]);

            const res = await t.get('/internal/events', { method: 'POST', body: bodyOf(deleteEvent), headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(bodyOf(deleteEvent), SECRET) } });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.json().outcome, 'erased');
            assert.strictEqual(await gone(A), 0, 'the person\'s saved searches are gone');
            assert.strictEqual(await gone(B), 1, 'someone else\'s saved search stays');

            const confirmation = stub.calls.find((c) => c.url === `/internal/account-deletions/${DEL}/confirmations`);
            assert.ok(confirmation, 'the confirmation was sent');
            assert.deepStrictEqual(confirmation.body.erased, { work_saved_searches: 1 });
            assert.deepStrictEqual(confirmation.body.retained, {});
            assert.ok(!Number.isNaN(Date.parse(confirmation.body.completed_at)));

            // A redelivery must not erase again: rows written after the deletion stay.
            await makeRows(t, A, 'written-later');
            const again = await t.get('/internal/events', { method: 'POST', body: bodyOf(deleteEvent), headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(bodyOf(deleteEvent), SECRET) } });
            assert.strictEqual(again.status, 200);
            assert.strictEqual(again.json().outcome, 'unchanged');
            assert.strictEqual(await gone(A), 1, 'nothing was erased twice');
        } finally { await t.close(); await stub.close(); }
    });

    await check('the internal route refuses a bad signature (401) and a forwarded request (403)', async () => {
        const stub = await startNetworkStub();
        const sender = createNetworkSender({ networkInternalUrl: stub.url, clientId: 'work', clientSecret: 'work-secret' });
        const t = await boot({ env: { WORK_EVENTS_SECRET: SECRET }, accountSend: sender });
        try {
            const bad = await t.get('/internal/events', { method: 'POST', body: bodyOf(exportEvent), headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(bodyOf(exportEvent), WRONG) } });
            assert.strictEqual(bad.status, 401);

            const forwarded = await t.get('/internal/events', { method: 'POST', body: bodyOf(exportEvent), headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9', ...signDeliveryHeaders(bodyOf(exportEvent), SECRET) } });
            assert.strictEqual(forwarded.status, 403);
        } finally { await t.close(); await stub.close(); }
    });

    done();
})();
