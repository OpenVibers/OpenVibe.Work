'use strict';

/**
 * Account export and deletion → Work (ADR-033; openvibe-sdk/account-data). Work holds two things a person made: the
 * search they saved (`work_saved_searches.subject = user:usr_…`) and the job applications they track
 * (`work_applications.subject_id = user:usr_…`), with the append-only history of each application's status changes
 * (`work_application_events`, keyed by application_id). All three are the person's own — nothing anyone else hangs
 * under them — so they are deleted whole and nothing is kept.
 *
 * The events table has no subject column of its own, so its export comes through extraExport (the person's events,
 * joined to their applications) and its erase rides on the applications table's ON DELETE CASCADE foreign key: when
 * an application row goes, its events go with it.
 *
 *   network.account.export_requested  the person's saved searches and applications (and each application's events),
 *                                     pushed to Network (POST /internal/account-exports/:id/parts) with this service's token.
 *   network.account.deleted           all three go, and Work confirms with counts.
 *
 * The listings (work_listings) and the per-source ingest bookkeeping (work_source_fetches) hold no person's rows:
 * neither has a subject column, so neither is exported nor erased (see migrations/0002_listings.sql). Nothing here is
 * a secret: no token, key or credential is stored, so every column may be exported.
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

/** The value a subject column really stores (a person's requester is `user:usr_…`). */
const subjectOf = (usr) => `user:${usr}`;

/**
 * The tables that hold a person's rows. A saved search stores `user:usr_…` in `subject`; an application stores it in
 * `subject_id` (server/applications.js takes the subject straight from the principal's requester).
 */
const TABLES = [
    { table: 'work_saved_searches', subject: 'subject', value: subjectOf, file: 'saved_searches.json' },
    { table: 'work_applications', subject: 'subject_id', value: subjectOf, file: 'applications.json' },
];

/** The person's application status-change history, which has no subject column of its own. */
async function extraExport(db, subject) {
    const rows = await db.many(
        `SELECT e.application_id, e.at, e.from_status, e.to_status
         FROM work_application_events e
         JOIN work_applications a ON a.id = e.application_id
         WHERE a.subject_id = $1
         ORDER BY e.at DESC, e.application_id DESC`,
        [subjectOf(subject)]);
    return rows.length ? [{ name: 'application_events.json', content: rows }] : [];
}

/** The account-data handle for Work's store (server/db.js createStore). */
function create({ db, log = console } = {}) {
    return createAccountData({ db, service: 'work', tables: TABLES, extraExport, log });
}

module.exports = { create, TABLES, extraExport, TOPICS };
