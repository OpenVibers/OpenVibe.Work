'use strict';

/**
 * Re-derive the titles of Hacker News "Who is hiring" listings stored before server/jobs/hiring-line.js split the
 * first line into company, roles, place, terms and pay (scripts/rederive-hn-titles.js runs it once).
 *
 * The old row kept the first segment as the company and the rest of the pipe-separated line as the title, so the
 * board's line can be put back together from the two: "Company | Role | Place" (or "Company | | Role" when the line
 * had an empty segment, which is why a title starting with "|" is joined without another separator). That line is
 * parsed by the same module the ingest uses, and the row's own title, company, place, remote flag, type, pay and tags
 * are replaced with what it says. The excerpt is never touched: it already starts with the original line.
 *
 * Only rows without the title_rule marker are read, so running it twice is harmless and a second run can never read a
 * title this job wrote back as if it were the board's line. A line that names no company is left alone (the same
 * thin-listing gate the ingest applies) and reported.
 */
const { parseHiringLine, TITLE_RULE } = require('./hiring-line');

const SOURCE = 'hn-whoishiring';
const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const uniq = (a) => [...new Set(a.filter(Boolean))];

/** The board's first line, as the old ingest stored it: the company segment and the rest of the line. */
function legacyLine(row) {
    const company = clip(row && row.company, 120);
    const title = clip(row && row.title, 300);
    if (!company || !title) return title || company || '';
    // rawOfHn joined the title's own parts with " | "; an empty first part left the title starting with "|".
    return title.startsWith('|') ? `${company} ${title}` : `${company} | ${title}`;
}

/** The row's search text, exactly as server/jobs/sources.js's toRow builds it. */
function searchText(row) {
    return [row.title, row.company, row.tags, row.location, row.excerpt, row.salary].filter(Boolean).join(' ').toLowerCase().slice(0, 4000);
}

/**
 * Re-derive every old HN title. Dry by default: with { apply: true } it writes the rows in one transaction and, when
 * a search index (or a config to build one) is given, sweeps it so the changed documents are re-sent.
 * → { scanned, changed, skipped, samples, sent }
 */
async function rederiveHnTitles({ s, config = null, log = console, apply = false, search = null, limit = 0 } = {}) {
    if (!s || !s.db) throw new TypeError('rederiveHnTitles needs the store (s)');
    const rows = await s.db.many(
        `SELECT * FROM work_listings WHERE source = $1 AND (title_rule IS NULL OR title_rule <> $2) ORDER BY id${limit ? ` LIMIT ${Number(limit)}` : ''}`,
        [SOURCE, TITLE_RULE]);
    const changes = [];
    const skipped = [];
    for (const row of rows) {
        const parsed = parseHiringLine(legacyLine(row));
        if (!parsed.company || !parsed.title) { skipped.push(row); continue; }
        const tags = uniq([...String(row.tags || '').split(',').map((t) => t.trim()).filter(Boolean), ...parsed.tags]);
        const next = {
            id: row.id,
            title: parsed.title,
            company: parsed.company,
            location: parsed.location,
            remote: parsed.remote,
            tags: tags.join(', '),
            job_type: parsed.job_type,
            salary: parsed.salary,
            title_rule: TITLE_RULE,
        };
        next.search_text = searchText({ ...row, ...next });
        if (next.title === row.title && next.company === row.company && next.location === (row.location || null)
            && next.remote === row.remote && next.tags === row.tags && next.job_type === (row.job_type || null)
            && next.salary === (row.salary || null) && row.title_rule === TITLE_RULE) continue;
        changes.push({ row, next });
    }

    let sent = null;
    if (apply && changes.length) {
        await s.tx(async () => {
            for (const { next } of changes) {
                await s.db.exec(
                    `UPDATE work_listings SET title = $2, company = $3, location = $4, remote = $5, tags = $6,
                            job_type = $7, salary = $8, search_text = $9, title_rule = $10 WHERE id = $1`,
                    [next.id, next.title, next.company, next.location, next.remote, next.tags, next.job_type,
                        next.salary, next.search_text, next.title_rule]);
            }
        });
        // The rows changed, so Search's sequencer sends their documents again on the next sweep; do it now rather than
        // an hour later. The relay is off in a test and the rows wait there, which is the service's own behaviour.
        const index = search || (config ? require('../search-index').createSearchIndex({ config, s, log }) : null);
        if (index) {
            const out = await index.sweep();
            sent = out && out.job ? out.job : out;
            if (index.outbox && index.outbox.kick) await index.outbox.kick().catch(() => {});
            if (!search && index.stop) index.stop();
        }
    }
    if (log && log.log) {
        log.log(`[Redrive] HN titles: ${rows.length} old listing(s), ${changes.length} to change, ${skipped.length} with no company${apply ? ' (applied)' : ' (dry run)'}`);
    }
    return {
        scanned: rows.length,
        changed: changes.length,
        skipped: skipped.length,
        samples: changes.slice(0, 12).map(({ row, next }) => ({
            id: row.id, before: `${row.title} — ${row.company}`, after: next.title, company: next.company,
            location: next.location, job_type: next.job_type, salary: next.salary, tags: next.tags,
        })),
        sent,
    };
}

module.exports = { rederiveHnTitles, legacyLine, SOURCE, TITLE_RULE };
