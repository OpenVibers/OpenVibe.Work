'use strict';

/**
 * OpenVibe.Work — Express app factory; server/index.js listens, tests build their own instance with a temp database
 * and a mock Network.
 *
 *   /, /updates                                       the pages (http/pages.js)
 *   /api/v1/*                                         the API (http/api.js)
 *   /auth/*                                           Network SSO with PKCE (auth/sso.js)
 *   /api/health, /api/ready, /release.json, /metrics  (loopback only)
 *
 * The product fills this in: its routes in http/api.js, its pages in http/pages.js, its capabilities in
 * http/principal.js and its budgets in http/caller-limits.js. The plumbing here (helmet, SSO, legal pages,
 * static assets, the API mount, the 404 and the error handler) stays.
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const contracts = require('openvibe-contracts');
const cache = require('openvibe-shared/cache-policy');

const configLib = require('./config');
const { openStore } = require('./db');
const { createKeyStore } = require('./auth/keys');
const { createSso } = require('./auth/sso');
const { createPrincipal } = require('./http/principal');
const { createApi } = require('./http/api');
const { createPageRoutes } = require('./http/pages');
const { createServiceReadiness } = require('./observability');
const { createCallerLimits } = require('./http/caller-limits');
const { createIngest } = require('./ingest');
const { createFromSources } = require('./ingest/from-sources');
const { createIndexNow } = require('openvibe-shared/indexnow');
const { createSearchIndex } = require('./search-index');
const accountDataLib = require('./identity/account-data');
const { createNetworkSender } = require('openvibe-sdk/account-data');
const { createActorLimiter } = require('openvibe-sdk/limits');
const actorLib = require('./actor');
const { assetVersion, send } = require('./render/layout');
const { html } = require('./render/html');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = require('../package.json').version;
const { createHttpTelemetry } = require('openvibe-sdk/service');
const { createPgTelemetrySink } = require('openvibe-sdk/telemetry');

/**
 * opts: config, store, now (clock), fetchImpl (Network), log, limitsNow, callerLimits (false: count nobody,
 * tests only), valkey, accountSend (a stand-in for Network's internal routes; tests only), actor (a stand-in
 * Actor client; tests only), assistLimitsNow (the assist rate-limit clock; tests only)
 */
async function createApp(opts = {}) {
    const config = opts.config || configLib.load();
    const log = opts.log || console;
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const s = opts.store || await openStore(config, { now: opts.now, log });

    const keys = createKeyStore({ config, fetchImpl, log });
    const sso = createSso({ config, keys, fetchImpl, now: s.now, log });
    const principal = createPrincipal({ config, keys });
    const ctx = { config, s, keys, sso, principal, log };

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    const release = require('openvibe-shared/release').createRelease({ service: 'work', root: path.join(__dirname, '..') });
    require('./render/layout').setRelease(release.release);
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'work', release: release.release });
    app.locals.metrics = metrics.registry;
    // Request telemetry (openvibe-sdk/service, plan T1): one aggregated sample per route template, method and status
    // class each flush, stored in this service's telemetry_samples table; /shared, health, readiness and /metrics make
    // none. server/index.js flushes it on stop and keeps the table to 14 days.
    ctx.telemetry = createHttpTelemetry({ service: 'work', sink: opts.telemetrySink || createPgTelemetrySink({ db: s.db, log }), skipPrefixes: ['/shared'], intervalMs: 60_000 });
    app.use(ctx.telemetry.middleware());
    app.locals.ctx = ctx;
    const valkey = opts.valkey !== undefined ? opts.valkey : (config.valkey.url ? require('openvibe-sdk/valkey').createValkey({ url: config.valkey.url, prefix: config.valkey.prefix, log }) : null);
    ctx.valkey = valkey;
    ctx.limits = createCallerLimits({ config, now: opts.limitsNow || (() => Date.now()), registry: metrics.registry, log, enabled: opts.callerLimits !== false, valkey });
    // The job-board ingest. Built here so a test can run one source against its stand-in server, but started only by
    // server/index.js, and only when WORK_INGEST=on: nothing fetches a board in a test or a development run.
    // Listing pages in OpenVibe.Search (./search-index.js): swept after every ingest run, and on its own timer once
    // server/index.js starts it. The outbox relay is off until the events URL and the OAuth client secret are set.
    ctx.search = opts.search || createSearchIndex({ config, s, log });
    // IndexNow (openvibe-shared/indexnow): off without INDEXNOW_KEY; a malformed key is a configuration mistake, not
    // a reason to leave the site down, so it warns and runs with IndexNow off.
    ctx.indexnow = opts.indexnow || (() => {
        const warn = (...a) => (log.warn || console.warn)(...a);
        try { return createIndexNow({ host: config.baseUrl, key: config.indexnow.key, fetch: fetchImpl, log: warn }); } catch (err) {
            warn(`[Work] ${err.message} — IndexNow is off until INDEXNOW_KEY is fixed`);
            return createIndexNow({ host: config.baseUrl, key: '', fetch: fetchImpl, log: warn });
        }
    })();
    // Arbeitnow through OpenVibe.Sources (server/ingest/from-sources.js), off unless WORK_ARBEITNOW_FROM=sources; a test
    // passes its own Sources stand-in as opts.sourcesClient.
    ctx.fromSources = createFromSources({ config, s, fetchImpl, log, source: opts.sourcesClient || null, afterRun: () => ctx.search.afterIngest(), indexnow: ctx.indexnow });
    ctx.ingest = createIngest({ config, s, fetchImpl, log, afterRun: () => ctx.search.afterIngest(), indexnow: ctx.indexnow, fromSources: ctx.fromSources });

    // The person's OpenVibe.Actor agent (server/actor.js) and the per-person daily cap on asking it. A test injects
    // a stand-in client and clock through opts.actor / opts.assistLimitsNow, so the assist route never calls out.
    ctx.actor = opts.actor || actorLib.create({ config, fetchImpl, log });
    ctx.assistLimiter = opts.assistLimiter || createActorLimiter({
        limits: { day: config.applications.assistsPerDay },
        actor: (req) => (req.principal && req.principal.requester) || null,
        now: opts.assistLimitsNow || (() => Date.now()),
        log,
    });

    // Account export and deletion (ADR-033, ./identity/account-data.js): the one table that holds a person's rows.
    // The sender posts to Network's internal export/deletion routes with this service's own client-credentials token;
    // a test injects a stand-in through opts.accountSend.
    const accountData = accountDataLib.create({ db: s.db, log });
    // Without a client secret the service has no way to push a part or a confirmation: the route still answers
    // (bad signature, a forwarded request, no secret), and an event that really arrives asks Events to retry.
    const accountSend = opts.accountSend || (config.oauth.clientSecret
        ? createNetworkSender({ networkInternalUrl: config.networkInternalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, fetch: fetchImpl })
        : async () => { throw new Error('OV_OAUTH_CLIENT_SECRET is not set: Work cannot answer account events'); });
    ctx.accountData = accountData;
    ctx.accountSend = accountSend;

    app.use(contracts.http.middleware());
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                // The OpenVibe Frame (theme-loader, navbar, footer) comes from the Network; the inline init is ours.
                scriptSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://static.cloudflareinsights.com'],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
                fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
                imgSrc: ["'self'", 'data:', 'https://openvibe.network', 'https://openvibe.media'],
                connectSrc: ["'self'", 'https://openvibe.network', 'https://cloudflareinsights.com', 'https://openvibe.events'],
                frameSrc: ["'self'", 'https://openvibe.network'],
                frameAncestors: ["'none'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'", 'https://openvibe.network'],
            },
        },
        frameguard: { action: 'deny' },
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: 'same-site' },
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }));
    app.use(cookieParser());

    // ── Machine endpoints ───────────────────────────────────
    app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'openvibe-work', version: VERSION }));
    release.mount(app, { registry: metrics.registry });
    const readiness = createServiceReadiness({ s, config, release: release.release, valkey, sso });
    app.get('/api/ready', readiness.handler);

    // ── Who is asking (verified offline; refreshed when expired) ──
    app.use(sso.middleware());

    // ── Sign-in (OAuth2 + PKCE client of OpenVibe.Network) ──
    // /auth/me is the navbar's who-is-signed-in read on every page, so it is not counted with sign-ins: 60 page views in 15 minutes made a signed-in visitor look signed out.
    app.use('/auth/', rateLimit({ windowMs: 15 * 60_000, limit: 60, skip: (req) => req.path === '/me', standardHeaders: true, legacyHeaders: false }));
    app.use('/auth', sso.routes());
    { const legal = require('openvibe-shared/legal'); app.get(legal.PATHS, legal.handler({ id: 'work', service: 'work', host: 'openvibe.work', name: 'OpenVibe.Work', profile: 'ugc' })); }

    // ── OpenVibe.Events → this service (loopback only) ──────
    // network.account.export_requested and network.account.deleted (ADR-033), answered by the SDK's consumer. It
    // reads the raw body itself, so it is mounted before any body parser (there is none above it), and nginx answers
    // 404 for /internal/ so this is reachable only on 127.0.0.1.
    app.use('/internal/events', accountData.consumer({ secrets: config.events.secrets, send: accountSend, log }));

    // ── Static assets (content-hashed ?v= → immutable) ──────
    app.use('/shared', require('openvibe-shared/serve').handler());
    // GET /<key>.txt — the IndexNow key file, only when a key is configured.
    if (ctx.indexnow.enabled) app.use(ctx.indexnow.keyFile);
    app.use(express.static(PUBLIC_DIR, {
        index: false, redirect: false,
        setHeaders(res, filePath) {
            const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
            const v = res.req && res.req.query && res.req.query.v;
            res.setHeader('Cache-Control', cache.assetHeaders(rel, { hashed: !!v && v === assetVersion(rel) }));
        },
    }));

    // ── API ─────────────────────────────────────────────────
    app.use('/api/v1', rateLimit({ windowMs: 60_000, limit: Number(process.env.WORK_API_RATE_LIMIT_PER_MIN) || 240, standardHeaders: true, legacyHeaders: false, handler: (req, res) => contracts.http.sendProblem(res, 429, 'rate_limited', { detail: 'too many requests from this address; retry shortly', ctx: req.ov }) }));
    app.use('/api/v1', createApi(ctx));
    app.use('/api', (req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'No such API route', ctx: req.ov }));

    // ── Pages ───────────────────────────────────────────────
    app.use(rateLimit({ windowMs: 60_000, limit: Number(process.env.WORK_RATE_LIMIT_PER_MIN) || 300, standardHeaders: true, legacyHeaders: false }));
    // The agent layer (openvibe-shared/agent-layer): /.well-known/agent.json, and the Markdown twins of the public
    // pages. Entered only for the manifest exactly (the rest of /.well-known/ belongs to the app) and a twin request —
    // a `.md` path, ?format=markdown or an explicit text/markdown preference — because the layer renders every page
    // signed out and a Work page is not one page (saved searches, applications, the account bar). It comes before the
    // page routes so `/jobs/x.md` is not taken for a listing called `x.md`; the app's own pages name their twins in
    // the head and the Link header (server/render/layout.js).
    const pageRoutes = createPageRoutes(ctx);
    {
        const agentRouter = express.Router();
        require('openvibe-shared/agent-layer').mount(agentRouter, {
            descriptor: require('./agent-descriptor'),
            render: require('./agent-pages').createAgentPages({ router: pageRoutes, host: new URL(config.baseUrl).hostname }).renderPublicPage,
        });
        app.use((req, res, next) => {
            if (req.path === '/.well-known/agent.json') return agentRouter(req, res, next);
            const p = String(req.path || '');
            if (p.endsWith('.md') || (req.query && req.query.format === 'markdown')
                || req.accepts(['html', 'text/markdown']) === 'text/markdown') return agentRouter(req, res, next);
            return next();
        });
    }
    app.use(pageRoutes);
    app.use((req, res) => send(res, 404, { viewer: req.viewer, config, path: req.originalUrl, title: 'Not found', body: html`<h1>Not found</h1><p>No page here. Try <a href="/">the home page</a> or <a href="/updates">the update log</a>.</p>` }));

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        // Never log request bodies.
        log.error('[OpenVibe.Work]', err && err.message ? err.message.slice(0, 300) : err);
        if (res.headersSent) return;
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (err && err.type === 'entity.parse.failed') return contracts.http.sendProblem(res, 400, 'request.malformed_json', { ctx: req.ov });
        if (err && err.type === 'entity.too.large') return req.path.startsWith('/api/') ? contracts.http.sendProblem(res, 413, 'request.too_large', { ctx: req.ov }) : res.status(413).type('text/plain').send('That request was too large.');
        if (req.path.startsWith('/api/')) return contracts.http.sendProblem(res, 500, 'internal.error', { detail: 'Internal error', ctx: req.ov });
        res.status(500).type('text/plain').send('Something went wrong on our side. Try again in a moment.');
    });

    return { app, ctx };
}

module.exports = { createApp };
