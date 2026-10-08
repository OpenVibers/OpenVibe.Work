'use strict';

/**
 * Account export and deletion → Work (ADR-033; openvibe-sdk/account-data). Work holds one thing a person made: the
 * search they saved, keyed `subject = user:usr_…` (server/http/api.js builds the subject from req.principal.requester,
 * which server/http/principal.js sets to `user:${subject_id}`; server/jobs/store.js writes it). A saved search is the
 * person's own — nothing anyone else hangs under it — so it is deleted whole and nothing is kept.
 *
 *   network.account.export_requested  the person's saved searches (saved_searches.json), newest first, pushed to
 *                                     Network (POST /internal/account-exports/:id/parts) with this service's token.
 *   network.account.deleted           the person's saved searches go, and Work confirms with counts.
 *
 * The listings (work_listings) and the per-source ingest bookkeeping (work_source_fetches) hold no person's rows:
 * neither has a subject column (a listing is scraped from a public job board and a fetch record is per source), so
 * neither is exported nor erased (see migrations/0002_listings.sql). Nothing here is a secret: no token, key or
 * credential is stored, so every column of the saved-search table may be exported.
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

/**
 * The tables that hold a person's rows, with the value the subject column really stores. A saved search stores
 * `user:usr_…` (server/jobs/store.js takes the subject straight from the principal's requester; server/http/api.js).
 */
const TABLES = [
    { table: 'work_saved_searches', subject: 'subject', value: (usr) => `user:${usr}`, file: 'saved_searches.json' },
];

/** The account-data handle for Work's store (server/db.js createStore). */
function create({ db, log = console } = {}) {
    return createAccountData({ db, service: 'work', tables: TABLES, log });
}

module.exports = { create, TABLES, TOPICS };
