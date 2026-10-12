'use strict';

/**
 * /api/v1 — OpenVibe.Work's API.
 *
 *   GET    /ping                    public   liveness: { ok: true, service }
 *   GET    /jobs                    public   search the listings (q, remote, type, location, limit, cursor) with facets
 *   GET    /jobs/:id                public   one listing, with its source and the original URL to apply on
 *   GET    /sources                 public   the boards we gather from, their terms as applied, and the last fetch
 *   GET    /saved-searches          person   your saved searches, each with the count new since you last looked
 *   POST   /saved-searches          person   save the search you are looking at
 *   DELETE /saved-searches/:id      person   forget one
 *
 * Reads are public: a listing is public data with its provenance. A saved search is a person's, so those three routes
 * need a signed-in person (their token as a Bearer, or this site's session) and answer 401 otherwise — a saved search
 * belongs to nobody else. Every route carries its per-caller numbers (../http/caller-limits.js).
 *
 * A refusal is an RFC 9457 problem+json with a stable code.
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const { sameOrigin } = require('./principal');
const store = require('../jobs/store');
const sources = require('../jobs/sources');
const applications = require('../applications');

function createApi(ctx) {
    const { config, s, principal, limits } = ctx;
    const r = asyncRouter();
    const problem = (req, res, status, code, detail, extra) => contracts.http.sendProblem(res, status, code, { detail, ctx: req.ov, extra });

    r.use(express.json({ limit: '64kb' }));
    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    r.use(principal.middleware);

    // The one route the skeleton ships. It is public and counted per caller with the default read numbers.
    r.get('/ping', limits.reads('work.api.read'), (_req, res) => res.json({ ok: true, service: config.service }));

    const wire = (row) => store.toWire(row, { source: sources.byId(row.source) });
    const person = (req, res) => {
        if (req.principal.kind === 'user') {
            // A write made with the session cookie must come from this site: another site cannot make a signed-in
            // visitor save or forget a search. (A Bearer token is the person's own and is not tied to an origin.)
            if (req.principal.viaSession && req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req, config.baseUrl)) {
                problem(req, res, 403, 'request.cross_site', 'A signed-in request that changes something must come from openvibe.work itself.');
                return null;
            }
            return req.principal.requester;
        }
        // A person's data is theirs: an app or agent token is not a person, and anonymous is not signed in.
        problem(req, res, req.principal.kind === 'anonymous' ? 401 : 403, req.principal.kind === 'anonymous' ? 'token.required' : 'work.saved_searches.person_only',
            req.principal.kind === 'anonymous'
                ? 'Sign in at openvibe.work to keep saved searches, or send a person\'s Network token as a Bearer.'
                : 'Saved searches belong to a person; an app or agent token cannot hold one. A person\'s token can.');
        return null;
    };

    // Applications are a person's own; an app or agent token may manage them only with work.application.manage.
    const requireApp = principal.requireCapability('work.application.manage');
    // Asking the person's agent is always the person themselves: an app token cannot stand in for them.
    const personOnly = (req, res) => {
        if (req.principal.kind === 'user') {
            if (req.principal.viaSession && req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req, config.baseUrl)) {
                problem(req, res, 403, 'request.cross_site', 'A signed-in request that changes something must come from openvibe.work itself.');
                return null;
            }
            return req.principal.requester;
        }
        problem(req, res, req.principal.kind === 'anonymous' ? 401 : 403, req.principal.kind === 'anonymous' ? 'token.required' : 'work.applications.person_only',
            req.principal.kind === 'anonymous'
                ? 'Sign in at openvibe.work to track applications, or send a person\'s Network token as a Bearer.'
                : 'Asking your agent is yours alone; an app or agent token cannot do it for you.');
        return null;
    };
    const assistLimit = ctx.assistLimiter('work.applications.assist');

    // ── The listings ────────────────────────────────────────
    r.get('/jobs', limits.budget('work.jobs.search'), async (req, res) => {
        const filters = store.filtersOf(req.query);
        const cursor = store.decodeCursor(req.query.cursor);
        if (req.query.cursor && !cursor) return problem(req, res, 422, 'work.jobs.cursor_invalid', 'cursor: the value the previous page returned as `next`, or absent');
        const limit = Math.min(store.MAX_PAGE, Math.max(1, parseInt(req.query.limit, 10) || store.PAGE_SIZE));
        const page = await store.search(s, filters, { limit, cursor });
        res.json({
            jobs: page.rows.map(wire),
            next: store.encodeCursor(page.next),
            count: page.rows.length,
            filters,
            facets: page.facets,
            sources: sources.SOURCES.map((src) => ({ id: src.id, name: src.name, url: src.homepage })),
        });
    });

    r.get('/jobs/:id', limits.reads('work.api.read'), async (req, res) => {
        const row = await store.getListing(s, req.params.id);
        if (!row) return problem(req, res, 404, 'work.jobs.not_found', 'No such listing. It may have expired from the board it came from.');
        res.json(wire(row));
    });

    // ── The sources ─────────────────────────────────────────
    r.get('/sources', limits.reads('work.api.read'), async (_req, res) => {
        const fetches = await store.sourceFetches(s);
        const counts = await store.countsBySource(s);
        res.json({
            sources: sources.SOURCES.map((src) => {
                const f = fetches.get(src.id) || null;
                return {
                    id: src.id,
                    name: src.name,
                    url: src.homepage,
                    terms: src.terms,
                    attribution: src.attribution,
                    listings: (counts.get(src.id) || {}).count || 0,
                    last_fetch: f ? { started_at: f.started_at, finished_at: f.finished_at || null, ok: !!f.ok, listings: Number(f.listings) || 0, error: f.error || null } : null,
                };
            }),
            cadence_hours: Math.round(config.ingest.intervalMs / 3_600_000),
            retention_days: config.ingest.retentionDays,
        });
    });

    // ── Saved searches ──────────────────────────────────────
    const savedWire = async (row) => store.toSavedWire(row, { newCount: await store.newCount(s, row) });

    r.get('/saved-searches', limits.reads('work.api.read'), async (req, res) => {
        const subject = person(req, res);
        if (!subject) return undefined;
        const rows = await store.listSaved(s, subject);
        return res.json({ saved_searches: await Promise.all(rows.map(savedWire)) });
    });

    r.post('/saved-searches', limits.budget('work.saved_searches.write'), async (req, res) => {
        const subject = person(req, res);
        if (!subject) return undefined;
        const b = req.body || {};
        const filters = store.filtersOf({ q: b.q != null ? b.q : b.query, remote: b.remote, type: b.type, location: b.location });
        if (!filters.q && !filters.remote && !filters.type && !filters.location) {
            return problem(req, res, 422, 'work.saved_searches.empty', 'A saved search needs at least one of q, remote, type or location — otherwise it is the whole board.');
        }
        const out = await store.createSaved(s, subject, filters, { id: s.newId('ssc'), now: s.iso() });
        if (out.error === 'too_many') return problem(req, res, 429, 'work.saved_searches.limit', `You can keep ${store.MAX_SAVED} saved searches; delete one first.`);
        res.status(201).set('Location', `/api/v1/saved-searches/${out.row.id}`).json(await savedWire(out.row));
        return undefined;
    });

    r.delete('/saved-searches/:id', limits.budget('work.saved_searches.write'), async (req, res) => {
        const subject = person(req, res);
        if (!subject) return undefined;
        const gone = await store.deleteSaved(s, subject, req.params.id);
        if (!gone) return problem(req, res, 404, 'work.saved_searches.not_found', 'You have no saved search with that id.');
        return res.status(204).end();
    });

    // ── Applications ─────────────────────────────────────────
    r.get('/me/applications', limits.reads('work.api.read'), requireApp, async (req, res) => {
        const subject = req.principal.requester;
        const status = req.query.status;
        if (status != null && status !== '' && !applications.STATUSES.includes(status)) {
            return problem(req, res, 400, 'work.applications.status_invalid', `status is one of ${applications.STATUSES.join(', ')}.`);
        }
        const cursor = applications.decodeCursor(req.query.cursor);
        if (req.query.cursor && !cursor) return problem(req, res, 422, 'work.applications.cursor_invalid', 'cursor: the value the previous page returned as `next`, or absent');
        const page = await applications.listApplications(s, subject, { status: status || null, cursor, limit: req.query.limit });
        return res.json({
            applications: page.rows.map(applications.toWire),
            next: applications.encodeCursor(page.next),
            count: page.rows.length,
        });
    });

    r.post('/me/applications', limits.budget('work.applications.write'), requireApp, async (req, res) => {
        const subject = req.principal.requester;
        const v = applications.validateCreate(req.body);
        if (v.error) return problem(req, res, v.error[0], v.error[1], v.error[2]);
        const resolved = await applications.resolveCreateFields(s, v.fields);
        if (resolved.error === 'listing_not_found') return problem(req, res, 404, 'work.jobs.not_found', 'No such listing to track. It may have expired from the board it came from.');
        const fields = resolved.fields;
        if (fields.listing_id) {
            const existing = await applications.applicationByListing(s, subject, fields.listing_id);
            if (existing) return res.status(200).json(applications.toWire(existing));
        }
        const out = await applications.createApplication(s, subject, fields, { id: s.newId('wap'), now: s.iso(), max: config.applications.max });
        if (out.error === 'full') return problem(req, res, 409, 'work.applications_full', `You can track up to ${config.applications.max} applications; delete one first.`);
        res.status(201).set('Location', `/api/v1/me/applications/${out.row.id}`).json(applications.toWire(out.row));
        return undefined;
    });

    r.get('/me/applications/:id', limits.reads('work.api.read'), requireApp, async (req, res) => {
        const subject = req.principal.requester;
        const row = await applications.getApplication(s, subject, req.params.id);
        if (!row) return problem(req, res, 404, 'work.applications.not_found', 'You have no application with that id.');
        const events = await applications.listEvents(s, row.id);
        return res.json({ ...applications.toWire(row), events: events.map(applications.toEventWire) });
    });

    r.patch('/me/applications/:id', limits.budget('work.applications.write'), requireApp, async (req, res) => {
        const subject = req.principal.requester;
        const v = applications.validatePatch(req.body);
        if (v.error) return problem(req, res, v.error[0], v.error[1], v.error[2]);
        const out = await applications.updateApplication(s, subject, req.params.id, v.fields, { now: s.iso() });
        if (out.error === 'not_found') return problem(req, res, 404, 'work.applications.not_found', 'You have no application with that id.');
        return res.json(applications.toWire(out.row));
    });

    r.delete('/me/applications/:id', limits.budget('work.applications.write'), requireApp, async (req, res) => {
        const subject = req.principal.requester;
        const gone = await applications.deleteApplication(s, subject, req.params.id);
        if (!gone) return problem(req, res, 404, 'work.applications.not_found', 'You have no application with that id.');
        return res.status(204).end();
    });

    r.post('/me/applications/:id/assist', assistLimit, async (req, res) => {
        const subject = personOnly(req, res);
        if (!subject) return undefined;
        const app = await applications.getApplication(s, subject, req.params.id);
        if (!app) return problem(req, res, 404, 'work.applications.not_found', 'You have no application with that id.');
        const a = applications.validateAsk(req.body);
        if (a.error) return problem(req, res, a.error[0], a.error[1], a.error[2]);
        const actor = ctx.actor;
        if (!actor || !actor.available) return problem(req, res, 503, 'work.actor_unavailable', 'The OpenVibe.Actor agent is not available right now.');
        const n = Number(app.assists || 0) + 1;
        const idempotencyKey = `work-assist:${app.id}:${n}`;
        const listing = app.listing_id ? await store.getListing(s, app.listing_id) : null;
        const task = applications.buildTaskText(app, listing, a.ask);
        let out;
        try {
            out = await actor.createTask({ subjectId: subject.slice('user:'.length), task, idempotencyKey });
        } catch (err) {
            const status = err && err.status;
            if (status === 402 || status === 429) return problem(req, res, 409, (err.code || 'work.actor_refused'), (err.detail || 'The agent refused this task.'));
            return problem(req, res, 503, 'work.actor_unavailable', 'The agent could not be reached.');
        }
        await applications.recordAssist(s, subject, app.id, out.id, s.iso());
        return res.json({ task_id: out.id, task_url: `${config.actor.publicUrl}/tasks/${out.id}` });
    });

    return r;
}

module.exports = { createApi };
