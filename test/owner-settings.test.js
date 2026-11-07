'use strict';
/**
 * Owner settings (D11) for Work's data sources (server/settings.js, work.data_sources):
 *   - the USAJOBS API key and account email have plain titles, 30+ character descriptions,
 *     x-owner-input words and a test;
 *   - /internal/config is loopback only and needs work.config.manage;
 *   - the key is write-only and marked in summaries, usajobs() reads the owner's pair and falls back
 *     to USAJOBS_API_KEY / USAJOBS_ACCOUNT_EMAIL, and the test hook never echoes or logs the key.
 *   node test/owner-settings.test.js
 */
const assert = require('assert');
const http = require('http');
const express = require('express');
const { serviceAuth } = require('openvibe-contracts');
const { boot } = require('./helpers/boot');
const { createSettings } = require('../server/settings');

const CAP = 'work.config.manage';
const NS = 'work.data_sources';
const USR = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3';
const KEY = 'usajobs-owner-key-sentinel';
const EMAIL = 'owner@example.com';

(async () => {
    const t = await boot({ env: { USAJOBS_API_KEY: 'usajobs-env-key', USAJOBS_ACCOUNT_EMAIL: 'env@example.com' } });
    const now = Math.floor(Date.now() / 1000);
    const TOKEN = serviceAuth.signServiceToken({ iss: t.network.url, sub: 'svc:network', actor_type: 'service', aud: ['openvibe.work'], cap: [CAP], iat: now, exp: now + 300, jti: 'tok_owner_settings' }, t.network.privatePem);
    const checks = [];
    const check = async (name, fn) => {
        try { await fn(); checks.push(name); console.log(`  ✓ ${name}`); } catch (e) { console.log(`  ✗ ${name}\n${e.stack}`); await t.close(); process.exit(1); }
    };

    await check('both USAJOBS fields have owner words and a test', async () => {
        const r = await t.get(`/internal/config/${NS}`, { bearer: TOKEN });
        assert.strictEqual(r.status, 200, r.text);
        const props = r.json().schema.properties;
        for (const key of ['usajobs_api_key', 'usajobs_account_email']) {
            const f = props[key];
            assert.ok(f, `${key} exists`);
            assert.ok(f.title && f.title.length >= 3);
            assert.ok(f.description && f.description.length >= 30);
            assert.strictEqual(f['x-owner-input'].group, 'Data sources');
            assert.ok(f['x-owner-input'].unlocks.length > 20);
            assert.ok(/^https:\/\//.test(f['x-owner-input'].get_it_at));
            assert.strictEqual(f['x-owner-input'].test, true);
            assert.strictEqual(f['x-required-for'], 'USAJOBS federal jobs');
        }
    });

    await check('the routes are loopback only and need the capability', async () => {
        assert.strictEqual((await t.get(`/internal/config/${NS}`)).status, 401);
        const wrong = serviceAuth.signServiceToken({ iss: t.network.url, sub: 'svc:network', actor_type: 'service', aud: ['openvibe.work'], cap: ['work.job.read'], iat: now, exp: now + 300, jti: 'tok_wrong' }, t.network.privatePem);
        assert.strictEqual((await t.get(`/internal/config/${NS}`, { bearer: wrong })).status, 403);
        assert.strictEqual((await t.get(`/internal/config/${NS}`, { bearer: TOKEN, headers: { 'x-forwarded-for': '203.0.113.9' } })).status, 404);
    });

    await check('the key is write-only and the environment is the fallback', async () => {
        assert.deepStrictEqual(t.ctx.settings.usajobs(), { apiKey: 'usajobs-env-key', email: 'env@example.com' });
        const put = await t.get(`/internal/config/${NS}/secrets/usajobs_api_key`, {
            bearer: TOKEN, method: 'PUT', json: { value: KEY, reason: 'owner test' }, headers: { 'x-ov-subject': USR, 'x-ov-fresh': '1' },
        });
        assert.strictEqual(put.status, 200, put.text);
        assert.ok(put.json().fingerprint && put.json().hint);
        assert.ok(!put.text.includes(KEY));
        const email = await t.get(`/internal/config/${NS}`, {
            bearer: TOKEN, method: 'POST', json: { values: { usajobs_account_email: EMAIL }, merge: true, reason: 'owner test' }, headers: { 'x-ov-subject': USR },
        });
        assert.strictEqual(email.status, 200, email.text);
        const summary = await t.get(`/internal/config/${NS}`, { bearer: TOKEN });
        assert.ok(summary.json().values.usajobs_api_key.redacted);
        assert.ok(!summary.text.includes(KEY));
        assert.deepStrictEqual(t.ctx.settings.usajobs(), { apiKey: KEY, email: EMAIL });
    });

    await check('the test hook says ok/failed in one line and never echoes a key', async () => {
        const fake = createSettings({
            db: t.ctx.s.db, env: {},
            probes: { usajobs: async ({ apiKey }) => { throw new Error(`refused ${apiKey}`); } },
        });
        await fake.ready;
        const app = express();
        app.use(express.json());
        fake.mount(app, { guard: (_req, _res, next) => next(), log: t.log });
        const server = await new Promise((resolve) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => resolve(s)); });
        try {
            const r = await fetch(`http://127.0.0.1:${server.address().port}/internal/config/${NS}/test/usajobs_api_key`, { method: 'POST' });
            const body = await r.json();
            assert.strictEqual(r.status, 200);
            assert.strictEqual(body.ok, false);
            assert.ok(/^failed — USAJOBS said: /.test(body.detail), body.detail);
            assert.ok(!body.detail.includes(KEY));
            assert.ok(!body.detail.includes('\n'));
        } finally { server.close(); }
        assert.ok(!t.logs().includes(KEY), 'no key in a captured log line');
    });

    await t.close();
    console.log(`\n${checks.length} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
