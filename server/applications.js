'use strict';

/**
 * The job applications a signed-in person tracks (migrations/0005_applications.sql) and the append-only history of
 * their status changes. Every function takes the store (server/db.js createStore) first, as everywhere else in this
 * service. An application belongs to the subject that created it (`user:usr_…` for a person; an app or agent acting
 * with work.application.manage writes its own `app:…` / `agent:…` subject), so nobody reads anybody else's rows.
 */

const { stripHtml } = require('./jobs/text');

const PAGE_SIZE = 30;
const MAX_PAGE = 100;
const MAX_APPLICATIONS = 500;
const MAX_TITLE = 500;
const MAX_COMPANY = 200;
const MAX_URL = 2000;
const MAX_NOTES = 5000;
const MAX_NEXT_STEP = 200;
const MAX_ASK = 1000;

const STATUSES = ['saved', 'applied', 'interviewing', 'offer', 'rejected', 'withdrawn'];
const APPLICATION_ID = /^wap_[0-9A-HJKMNP-TV-Z]{26}$/;
const DEFAULT_ASK = 'Help me prepare this application: summarise what the role asks for, list what to emphasise, and draft a short cover note.';

const hasValue = (v) => v != null && v !== '';
const isHttpUrl = (v) => {
    if (typeof v !== 'string' || !v) return false;
    try { const u = new URL(v); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
};

/** A row → the application as the API and pages see it. */
function toWire(row) {
    return {
        id: row.id,
        subject_id: row.subject_id,
        listing_id: row.listing_id || null,
        title: row.title,
        company: row.company,
        url: row.url,
        status: row.status,
        notes: row.notes || '',
        applied_at: row.applied_at || null,
        next_step: row.next_step || '',
        next_step_at: row.next_step_at || null,
        actor_task_id: row.actor_task_id || null,
        assists: Number(row.assists) || 0,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

const toEventWire = (row) => ({ at: row.at, from_status: row.from_status, to_status: row.to_status });

/** An ISO 8601 date-time this service accepts (a null or empty clears the field); undefined means invalid. */
function parseDate(v) {
    if (v == null || v === '') return null;
    if (typeof v !== 'string') return undefined;
    if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v)) return undefined;
    return Number.isNaN(Date.parse(v)) ? undefined : v;
}

/** POST /api/v1/me/applications: listing_id, or title + company + url. Unknown fields are refused. */
function validateCreate(body) {
    const b = body && typeof body === 'object' ? body : {};
    for (const k of Object.keys(b)) {
        if (!['listing_id', 'title', 'company', 'url'].includes(k)) return { error: [400, 'work.applications.unknown_field', `unknown field: ${k}`] };
    }
    if (hasValue(b.listing_id)) {
        if (typeof b.listing_id !== 'string') return { error: [400, 'work.applications.listing_id_invalid', 'listing_id must be a string'] };
        if (hasValue(b.title) || hasValue(b.company) || hasValue(b.url)) return { error: [400, 'work.applications.conflicting_fields', 'Give listing_id, or title + company + url, not both.'] };
        return { fields: { listing_id: b.listing_id } };
    }
    const title = typeof b.title === 'string' ? b.title.trim() : '';
    const company = typeof b.company === 'string' ? b.company.trim() : '';
    if (!title) return { error: [400, 'work.applications.title_required', 'An application needs a title.'] };
    if (title.length > MAX_TITLE) return { error: [400, 'work.applications.title_too_long', `title is at most ${MAX_TITLE} characters.`] };
    if (!company) return { error: [400, 'work.applications.company_required', 'An application needs a company.'] };
    if (company.length > MAX_COMPANY) return { error: [400, 'work.applications.company_too_long', `company is at most ${MAX_COMPANY} characters.`] };
    if (typeof b.url !== 'string' || !isHttpUrl(b.url)) return { error: [400, 'work.applications.url_invalid', 'url must be an http(s) URL.'] };
    if (b.url.length > MAX_URL) return { error: [400, 'work.applications.url_too_long', `url is at most ${MAX_URL} characters.`] };
    return { fields: { title, company, url: b.url } };
}

/** PATCH /api/v1/me/applications/:id: the five editable fields, nothing else. */
function validatePatch(body) {
    const b = body && typeof body === 'object' ? body : {};
    for (const k of Object.keys(b)) {
        if (!['status', 'notes', 'applied_at', 'next_step', 'next_step_at'].includes(k)) return { error: [400, 'work.applications.unknown_field', `unknown field: ${k}`] };
    }
    const out = {};
    if ('status' in b) {
        if (typeof b.status !== 'string' || !STATUSES.includes(b.status)) return { error: [400, 'work.applications.status_invalid', `status is one of ${STATUSES.join(', ')}.`] };
        out.status = b.status;
    }
    if ('notes' in b) {
        if (typeof b.notes !== 'string') return { error: [400, 'work.applications.notes_invalid', 'notes must be a string.'] };
        if (b.notes.length > MAX_NOTES) return { error: [400, 'work.applications.notes_too_long', `notes is at most ${MAX_NOTES} characters.`] };
        out.notes = b.notes;
    }
    if ('next_step' in b) {
        if (typeof b.next_step !== 'string') return { error: [400, 'work.applications.next_step_invalid', 'next_step must be a string.'] };
        if (b.next_step.length > MAX_NEXT_STEP) return { error: [400, 'work.applications.next_step_too_long', `next_step is at most ${MAX_NEXT_STEP} characters.`] };
        out.next_step = b.next_step;
    }
    if ('applied_at' in b) {
        const d = parseDate(b.applied_at);
        if (d === undefined) return { error: [400, 'work.applications.applied_at_invalid', 'applied_at is an ISO 8601 date-time, or null.'] };
        out.applied_at = d;
    }
    if ('next_step_at' in b) {
        const d = parseDate(b.next_step_at);
        if (d === undefined) return { error: [400, 'work.applications.next_step_at_invalid', 'next_step_at is an ISO 8601 date-time, or null.'] };
        out.next_step_at = d;
    }
    return { fields: out };
}

/** POST /api/v1/me/applications/:id/assist: an optional `ask`. */
function validateAsk(body) {
    const b = body && typeof body === 'object' ? body : {};
    for (const k of Object.keys(b)) {
        if (k !== 'ask') return { error: [400, 'work.applications.unknown_field', `unknown field: ${k}`] };
    }
    if (!hasValue(b.ask)) return { ask: DEFAULT_ASK };
    if (typeof b.ask !== 'string') return { error: [400, 'work.applications.ask_invalid', 'ask must be a string.'] };
    if (b.ask.length > MAX_ASK) return { error: [400, 'work.applications.ask_too_long', `ask is at most ${MAX_ASK} characters.`] };
    return { ask: b.ask };
}

/** Resolve a create's fields: a listing copies its title/company/url; a by-hand one is already complete. */
async function resolveCreateFields(s, fields) {
    if (!fields.listing_id) return { fields };
    const listing = await s.db.maybe('SELECT * FROM work_listings WHERE id = $1 AND expired = false', [fields.listing_id]);
    if (!listing) return { error: 'listing_not_found' };
    return { fields: { listing_id: listing.id, title: listing.title, company: listing.company, url: listing.url } };
}

const listAllApplications = (s, subject) => s.db.many('SELECT * FROM work_applications WHERE subject_id = $1 ORDER BY updated_at DESC, id DESC', [subject]);

/** One page of a person's applications, newest first, cursor on (updated_at, id). */
async function listApplications(s, subject, { status = null, cursor = null, limit = PAGE_SIZE } = {}) {
    const n = Math.min(MAX_PAGE, Math.max(1, Number(limit) || PAGE_SIZE));
    const args = [subject];
    const where = ['subject_id = $1'];
    if (status) { args.push(status); where.push(`status = $${args.length}`); }
    const at = cursor && cursor.updated_at && cursor.id ? cursor : null;
    if (at) { args.push(at.updated_at, at.id); where.push(`(updated_at, id) < ($${args.length - 1}, $${args.length})`); }
    const rows = await s.db.many(`SELECT * FROM work_applications WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ${n + 1}`, args);
    const page = rows.slice(0, n);
    const last = page[page.length - 1];
    return { rows: page, next: rows.length > n && last ? { updated_at: last.updated_at, id: last.id } : null };
}

const getApplication = (s, subject, id) => (APPLICATION_ID.test(String(id)) ? s.db.maybe('SELECT * FROM work_applications WHERE id = $1 AND subject_id = $2', [id, subject]) : Promise.resolve(null));

const applicationByListing = (s, subject, listingId) => s.db.maybe('SELECT * FROM work_applications WHERE subject_id = $1 AND listing_id = $2', [subject, listingId]);

/** The counts the /applications page groups by. */
async function countsByStatus(s, subject) {
    const rows = await s.db.many('SELECT status, count(*) AS n FROM work_applications WHERE subject_id = $1 GROUP BY status', [subject]);
    const out = Object.fromEntries(STATUSES.map((st) => [st, 0]));
    for (const r of rows) out[r.status] = Number(r.n);
    return out;
}

async function createApplication(s, subject, fields, { id, now, max = MAX_APPLICATIONS } = {}) {
    const count = Number(await s.db.value('SELECT count(*) FROM work_applications WHERE subject_id = $1', [subject]));
    if (count >= max) return { error: 'full' };
    const row = await s.db.maybe(
        `INSERT INTO work_applications (id, subject_id, listing_id, title, company, url, status, notes, applied_at, next_step_at, next_step, actor_task_id, assists, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'saved', '', NULL, NULL, '', NULL, 0, $7, $7) RETURNING *`,
        [id, subject, fields.listing_id || null, fields.title, fields.company, fields.url, now]);
    return { row };
}

async function updateApplication(s, subject, id, fields, { now }) {
    const current = await getApplication(s, subject, id);
    if (!current) return { error: 'not_found' };
    const next = { ...current };
    const statusChanged = Boolean(fields.status && fields.status !== current.status);
    if (fields.status) next.status = fields.status;
    if (fields.notes !== undefined) next.notes = fields.notes;
    if (fields.next_step !== undefined) next.next_step = fields.next_step;
    if (fields.applied_at !== undefined) next.applied_at = fields.applied_at;
    if (fields.next_step_at !== undefined) next.next_step_at = fields.next_step_at;
    // Setting the status to applied without an applied_at stamps the moment it happened.
    if (fields.status === 'applied' && !('applied_at' in fields) && !current.applied_at) next.applied_at = now;
    next.updated_at = now;
    await s.db.query(
        `UPDATE work_applications SET status = $3, notes = $4, applied_at = $5, next_step = $6, next_step_at = $7, updated_at = $8
         WHERE id = $1 AND subject_id = $2`,
        [id, subject, next.status, next.notes, next.applied_at, next.next_step, next.next_step_at, next.updated_at]);
    if (statusChanged) {
        await s.db.query('INSERT INTO work_application_events (application_id, at, from_status, to_status) VALUES ($1, $2, $3, $4)', [id, now, current.status, fields.status]);
    }
    return { row: next };
}

const deleteApplication = (s, subject, id) => (APPLICATION_ID.test(String(id)) ? s.db.exec('DELETE FROM work_applications WHERE id = $1 AND subject_id = $2', [id, subject]) : Promise.resolve(0));

const listEvents = (s, applicationId) => s.db.many('SELECT * FROM work_application_events WHERE application_id = $1 ORDER BY at DESC', [applicationId]);

const recordAssist = (s, subject, id, taskId, now) => s.db.query(
    'UPDATE work_applications SET actor_task_id = $3, assists = assists + 1, updated_at = $4 WHERE id = $1 AND subject_id = $2',
    [id, subject, taskId, now]);

/** The task text the person's agent sees: the application, the listing's excerpt when it has one, notes, then the ask. */
function buildTaskText(app, listing, ask) {
    const lines = [`Title: ${app.title}`, `Company: ${app.company}`, `URL: ${app.url}`];
    if (listing && listing.excerpt) lines.push(`Excerpt: ${stripHtml(listing.excerpt)}`);
    if (app.notes) lines.push(`Notes: ${app.notes}`);
    lines.push(`Ask: ${ask}`);
    return lines.join('\n');
}

const encodeCursor = (c) => (c ? Buffer.from(JSON.stringify([c.updated_at, c.id]), 'utf8').toString('base64url') : null);
function decodeCursor(v) {
    if (typeof v !== 'string' || !v || v.length > 200) return null;
    try {
        const [at, id] = JSON.parse(Buffer.from(v, 'base64url').toString('utf8'));
        if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(at) || !APPLICATION_ID.test(String(id))) return null;
        return { updated_at: at, id: String(id) };
    } catch { return null; }
}

module.exports = {
    toWire, toEventWire, validateCreate, validatePatch, validateAsk, resolveCreateFields,
    listAllApplications, listApplications, getApplication, applicationByListing, countsByStatus,
    createApplication, updateApplication, deleteApplication, listEvents, recordAssist, buildTaskText,
    encodeCursor, decodeCursor,
    STATUSES, APPLICATION_ID, MAX_APPLICATIONS, MAX_NOTES, MAX_NEXT_STEP, MAX_ASK, DEFAULT_ASK, PAGE_SIZE, MAX_PAGE,
};
