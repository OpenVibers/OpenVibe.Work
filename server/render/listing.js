'use strict';

/**
 * How a listing is shown, in one place so the list and the detail page cannot drift apart: the fields the board
 * gave, the short excerpt, and the provenance every listing carries — the source named and the original linked.
 *
 * Everything dynamic goes through the `html` tagged template, so a board's text (a title with <script> in it, a
 * company name with quotes) is escaped where it is shown, and a URL is only ever a link when it is the http(s) URL
 * the ingest kept.
 */
const { html, badge } = require('./html');
const { stripHtml } = require('../jobs/text');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A date out of an ISO instant, in plain words; '' when there is none. */
function dateWords(iso) {
    const d = iso ? new Date(iso) : null;
    if (!d || Number.isNaN(d.getTime())) return '';
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const meta = (row) => ({
    id: row.id,
    url: row.url,
    title: row.title,
    company: row.company,
    location: row.location || '',
    remote: !!row.remote,
    tags: String(row.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
    job_type: row.job_type || '',
    salary: row.salary || '',
    excerpt: row.excerpt,
    posted_at: row.posted_at || null,
    source: row.source,
    source_id: row.source_id || '',
    fetched_at: row.fetched_at || null,
    first_seen_at: row.first_seen_at || null,
    last_seen_at: row.last_seen_at || null,
    expired: !!row.expired,
});

/**
 * The salary, in the board's own words, or the plain truth that the board gave none: never a guess, never a range we
 * worked out ourselves. The same line is on the card and on the listing's own page, so they cannot drift apart.
 */
function salaryLine(row, { note = false } = {}) {
    const salary = String((row && row.salary) || '').trim();
    if (!salary) return html`<p class="job-pay muted">Salary not listed by the employer</p>`;
    return html`<p class="job-pay">Salary: ${salary}${note ? html` <span class="muted small">(as the board gives it)</span>` : ''}</p>`;
}

/** The source's name, linked to the original listing: the attribution its terms require, in one element. */
function sourceLink(row, source) {
    const name = (source && source.name) || row.source;
    return html`<a class="job-source" href="${row.url}" rel="nofollow noopener external" target="_blank">${name}</a>`;
}

/**
 * The one-line provenance: where it came from, linked back, when the board posted it, and when we first saw it — the
 * board named, so a reader can tell one board's freshness from another's.
 */
function provenance(row, source) {
    const name = (source && source.name) || row.source;
    const firstSeen = row.first_seen_at ? dateWords(row.first_seen_at) : '';
    return html`<p class="job-provenance"><span class="muted">Listing from</span> ${sourceLink(row, source)}${row.posted_at ? html` <span class="muted">· posted ${dateWords(row.posted_at)}</span>` : ''}${firstSeen ? html` <span class="muted">· first seen on ${name} on ${firstSeen}</span>` : ''}</p>`;
}

/** A company's initial on a tint picked from its name: the same company always gets the same tile. */
function initialTile(company) {
    const name = String(company || '?').trim();
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 360;
    return html`<span class="job-logo" style="--h:${h}" aria-hidden="true">${(name[0] || '?').toUpperCase()}</span>`;
}

/** One listing in a list, as a card: who, what and where at a glance, two lines of the excerpt, and the link back. */
function listingItem(row, { source }) {
    const l = meta(row);
    return html`<li class="job-item" id="${l.id}">
${initialTile(l.company)}
<div class="job-main">
<h3 class="job-title"><a href="/jobs/${l.id}">${l.title}</a></h3>
<p class="job-meta"><span class="job-company">${l.company}</span><span class="job-location">${l.location || 'Location not given'}</span></p>
<p class="job-chips">${l.remote ? html`<span class="chip chip-ok">Remote</span>` : ''}${l.job_type ? html`<span class="chip">${l.job_type}</span>` : ''}${l.tags.slice(0, 3).map((t) => html`<span class="chip chip-tag">${t}</span>`)}</p>
${salaryLine(row)}
<p class="job-excerpt">${l.excerpt}</p>
${provenance(row, source)}
</div>
</li>`;
}

/** A list of listings, or a line saying there is nothing to show. */
function listingList(rows, { sourceOf, empty = 'No listings match this search.' } = {}) {
    if (!rows.length) return html`<p class="muted">${empty}</p>`;
    return html`<ul class="job-list">${rows.map((row) => listingItem(row, { source: sourceOf(row) }))}</ul>`;
}

/**
 * schema.org JobPosting for one listing, from the fields the board gave and nothing else: the url is the original
 * listing (never this page), and the description is the excerpt we hold — the full text stays on the board.
 */
function jobPosting(row, { siteUrl }) {
    const l = meta(row);
    const node = {
        '@context': 'https://schema.org',
        '@type': 'JobPosting',
        title: l.title,
        description: l.excerpt,
        url: l.url,
        identifier: { '@type': 'PropertyValue', name: l.source, value: row.source_id || l.id },
        hiringOrganization: { '@type': 'Organization', name: l.company },
        directApply: false,
        publisher: { '@type': 'Organization', name: 'OpenVibe.Work', url: siteUrl },
    };
    if (l.posted_at) node.datePosted = l.posted_at;
    if (l.job_type) node.employmentType = l.job_type;
    if (l.remote) node.jobLocationType = 'TELECOMMUTE';
    if (l.location) node.jobLocation = { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: l.location } };
    if (l.salary) node.baseSalary = { '@type': 'MonetaryAmount', description: l.salary };
    return node;
}

/** The excerpt as plain text, for the meta description and the API. */
const plainExcerpt = (row) => stripHtml(row.excerpt || '');

module.exports = { listingItem, listingList, sourceLink, provenance, jobPosting, dateWords, plainExcerpt, meta, salaryLine };
