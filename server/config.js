'use strict';

/**
 * OpenVibe.Work configuration. Every value comes from the environment (production: /etc/openvibe/work.env, see
 * .env.example). Only environment variable NAMES appear in code and docs; secrets are never logged.
 *
 * load(env) is pure so tests can build a config without touching process.env.
 */
require('dotenv').config();
const trim = (s) => String(s || '').replace(/\/+$/, '');
const int = (v, def) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def);
const num = (v, def) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : def);

function load(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 4960);
    const baseUrl = trim(env.BASE_URL || (isProduction ? 'https://openvibe.work' : `http://localhost:${port}`));
    const networkUrl = trim(env.OV_NETWORK_URL || 'https://openvibe.network');

    return {
        service: 'work',
        port,
        host: env.HOST || '127.0.0.1',
        nodeEnv,
        isProduction,
        baseUrl,
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 2,
        // Per-caller limits (server/http/caller-limits.js): the requests one caller (an app, a person, else an
        // address) may make per minute and per hour. The product's own routes add tighter budgets there.
        limits: {
            minute: Math.max(1, int(env.WORK_LIMITS_MINUTE, 120)),
            hour: Math.max(1, int(env.WORK_LIMITS_HOUR, 3000)),
        },

        // PostgreSQL (ADR-035): DATABASE_URL serves (PgBouncer), DATABASE_DIRECT_URL migrates (owner role). In
        // development without DATABASE_URL an embedded PGlite database in data/pglite is used (WORK_PGLITE_DIR
        // overrides the directory).
        db: { url: env.DATABASE_URL || '', directUrl: env.DATABASE_DIRECT_URL || '', pgliteDir: env.WORK_PGLITE_DIR || '' },
        valkey: { url: env.VALKEY_URL || '', prefix: env.VALKEY_PREFIX || 'ov:work:' },

        // OpenVibe.Network: SSO (OAuth2 authorization server with PKCE) and its JWKS.
        networkUrl,
        networkInternalUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        networkIssuer: trim(env.OV_NETWORK_ISSUER || networkUrl),
        // The audience this service's app, agent and service tokens carry.
        audience: env.WORK_AUDIENCE || 'openvibe.work',
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'work',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
            redirectUri: env.OV_OAUTH_REDIRECT_URI || `${baseUrl}/auth/callback`,
            scope: 'profile',
            sessionAudience: env.OV_SESSION_AUDIENCE || 'openvibe.network',
        },
        cookies: { secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction },

        // The public job boards the ingest reads (server/jobs/sources.js). The base URLs are configurable so a
        // test points them at a stand-in server; nothing else in the service ever fetches a URL, and never one a
        // caller typed. Their terms are quoted in the manifest that describes each source, and applied on every
        // page that shows a listing: the source is named and the original listing is linked.
        sources: {
            arbeitnow: { url: trim(env.WORK_ARBEITNOW_URL || 'https://www.arbeitnow.com/api/job-board-api') },
            remotive: { url: trim(env.WORK_REMOTIVE_URL || 'https://remotive.com/api/remote-jobs') },
            remoteok: { url: trim(env.WORK_REMOTEOK_URL || 'https://remoteok.com/api') },
        },
        // The background ingest (server/ingest/): off unless WORK_INGEST=on, so a test and a development run
        // never call a job board. Once on, each source is fetched at most every intervalMs (Remotive's terms
        // allow about four calls a day: six hours is exactly four), and listings not seen for retentionDays go.
        ingest: {
            enabled: String(env.WORK_INGEST || '').toLowerCase() === 'on',
            intervalMs: Math.max(1, num(env.WORK_INGEST_INTERVAL_HOURS, 6)) * 3_600_000,
            timeoutMs: Math.max(1000, int(env.WORK_INGEST_TIMEOUT_MS, 15_000)),
            // Arbeitnow's board is paginated; the first N pages are read. Remotive takes a limit.
            pages: Math.max(1, int(env.WORK_INGEST_PAGES, 3)),
            limit: Math.max(1, int(env.WORK_INGEST_LIMIT, 100)),
            retentionDays: Math.max(1, int(env.WORK_RETENTION_DAYS, 30)),
            userAgent: env.WORK_USER_AGENT || `OpenVibeWork/0.1 (+${baseUrl})`,
        },
    };
}

module.exports = { load };
