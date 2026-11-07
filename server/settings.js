'use strict';

/**
 * Owner settings (D11) for OpenVibe.Work: the data-source accounts in `work.data_sources`.
 *
 * USAJOBS takes two owner values: the API key and the account email that goes in the User-Agent
 * header. usajobs() reads them when a USAJOBS read is made: the admin panel's value wins, the
 * environment (USAJOBS_API_KEY, USAJOBS_ACCOUNT_EMAIL) is the fallback. The key is sealed by the
 * shared store under OV_CONFIG_KEKS and is write-only through
 * /internal/config/work.data_sources/secrets/usajobs_api_key; summaries, history and logs carry
 * markers. Network's admin proxy reaches this namespace with `work.config.manage`, acting for the
 * owner (X-OV-Subject); a secret change needs X-OV-Fresh: 1. The test route makes one cheap
 * authenticated search read and answers ok or failed in one line, never echoing the key.
 */
const { createConfigStore, adminRoutes } = require('openvibe-shared/config');

const SERVICE = 'work';
const NAMESPACE = 'work.data_sources';
const BASE_PATH = '/internal/config';
const GROUP = 'Data sources';

const SCHEMA = Object.freeze({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Work data sources',
    description: 'The accounts Work reads job listings from. A source with no key is skipped; the other sources keep working.',
    type: 'object',
    additionalProperties: false,
    properties: {
        usajobs_api_key: {
            type: 'string', title: 'USAJOBS API key', 'x-group': GROUP,
            description: 'The API key from your USAJOBS developer account. It lets Work read federal jobs from USAJOBS directly; without it those jobs are missing from search and alerts.',
            'x-owner-input': {
                group: GROUP,
                unlocks: 'Federal job listings from USAJOBS appear in Work\'s search, company pages and job alerts.',
                get_it_at: 'https://developer.usajobs.gov/apirequest/',
                get_it_how: 'Sign in with your USAJOBS account, request an API key for an app, and paste the Authorization Key it shows.',
                test: true,
            },
            'x-required-for': 'USAJOBS federal jobs',
        },
        usajobs_account_email: {
            type: 'string', format: 'email', title: 'USAJOBS account email', 'x-group': GROUP,
            description: 'The email address on the USAJOBS developer account. USAJOBS requires it in the User-Agent header of every request, not just to sign in.',
            'x-owner-input': {
                group: GROUP,
                unlocks: 'USAJOBS accepts Work\'s requests: the email must match the account the API key belongs to.',
                get_it_at: 'https://developer.usajobs.gov/apirequest/',
                get_it_how: 'Use the email you signed in to developer.usajobs.gov with.',
                test: true,
            },
            'x-required-for': 'USAJOBS federal jobs',
        },
    },
});

const SECRETS = new Set(['usajobs_api_key']);
const ACTIVE = { settings: null };

function createSettings({ db, env = process.env, log = console, fetchImpl = globalThis.fetch, probes = null } = {}) {
    let store = null;
    const ready = createConfigStore({
        db, service: SERVICE, namespace: NAMESPACE, schema: SCHEMA,
        classify: (key) => (SECRETS.has(key) ? 'secret' : 'internal'),
        env, log,
    }).then((s) => { store = s; return s; });

    const values = () => (store ? store.get() : {});

    function valueOf(key, envName, fallback = '') {
        const v = values()[key];
        if (v !== undefined && v !== null && v !== '') return v;
        const e = envName ? env[envName] : undefined;
        return e !== undefined && e !== null && e !== '' ? e : fallback;
    }

    /** The USAJOBS pair, read when a USAJOBS read is made. */
    function usajobs() {
        return {
            apiKey: valueOf('usajobs_api_key', 'USAJOBS_API_KEY', ''),
            email: valueOf('usajobs_account_email', 'USAJOBS_ACCOUNT_EMAIL', ''),
        };
    }

    async function test(key) {
        if (key !== 'usajobs_api_key' && key !== 'usajobs_account_email') return { ok: false, detail: 'That setting has no test.' };
        const { apiKey, email } = usajobs();
        if (!apiKey || !email) return { ok: false, detail: 'USAJOBS is not configured: both the API key and the account email are needed.' };
        const probe = probes && typeof probes.usajobs === 'function'
            ? probes.usajobs
            : async ({ apiKey: keyValue, email: mail }) => {
                const r = await fetchImpl('https://data.usajobs.gov/api/search?Keyword=software&ResultsPerPage=1', {
                    headers: { host: 'data.usajobs.gov', 'user-agent': mail, 'authorization-key': keyValue, accept: 'application/json' },
                });
                let body = {};
                try { body = await r.json(); } catch { /* not JSON */ }
                if (!r.ok) throw new Error(`HTTP ${r.status}${body && body.Message ? `: ${body.Message}` : ''}`);
            };
        try {
            await probe({ apiKey, email });
            return { ok: true, detail: 'ok — USAJOBS answered a one-result search with this key and email.' };
        } catch (err) {
            const words = String((err && err.message) || 'the request failed').split(/\s+/).join(' ').slice(0, 160);
            return { ok: false, detail: `failed — USAJOBS said: ${words.split(apiKey).join('[redacted]')}` };
        }
    }

    function mount(app, { guard, log: appLog = log } = {}) {
        if (!store) throw new Error('createSettings: await ready before mount()');
        const routes = adminRoutes([store], {
            basePath: BASE_PATH,
            requireAdmin: guard,
            actor: (req) => {
                const id = String(req.get('x-ov-subject') || '').trim();
                return /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(id) ? { type: 'user', id } : null;
            },
            requireFresh: (req) => String(req.get('x-ov-fresh') || '') === '1',
            log: appLog,
        });
        app.use(routes.handle);
        app.post(`${BASE_PATH}/:namespace/test/:key`, guard, async (req, res) => {
            if (req.params.namespace !== NAMESPACE) return res.status(404).json({ error: 'no such configuration namespace' });
            let key = String(req.params.key || '');
            try { key = decodeURIComponent(key); } catch { /* keep it as it is */ }
            if (!SCHEMA.properties[key]) return res.status(404).json({ error: 'no such setting' });
            try {
                const out = await test(key);
                return res.status(200).json({ ok: Boolean(out.ok), detail: String(out.detail).replace(/\s+/g, ' ').slice(0, 200) });
            } catch (err) {
                appLog.warn(`[config] ${NAMESPACE}: the test for ${key} failed: ${String((err && err.message) || err).slice(0, 160)}`);
                return res.status(200).json({ ok: false, detail: 'failed — the test did not finish. The service log has the reason.' });
            }
        });
        return routes;
    }

    return { namespace: NAMESPACE, schema: SCHEMA, ready, value: valueOf, get: values, usajobs, test, mount };
}

function activate(settings) { ACTIVE.settings = settings; return settings; }
function usajobs() {
    if (ACTIVE.settings) return ACTIVE.settings.usajobs();
    return { apiKey: process.env.USAJOBS_API_KEY || '', email: process.env.USAJOBS_ACCOUNT_EMAIL || '' };
}

module.exports = { SERVICE, NAMESPACE, SCHEMA, SECRETS, createSettings, activate, usajobs };
