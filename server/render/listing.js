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
});

/** The source's name, linked to the original listing: the attribution its terms require, in one element. */
function sourceLink(row, source) {
    const name = (source && source.name) || row.source;
    return html`<a class="job-source" href="${row.url}" rel="nofollow noopener external" target="_blank">${name}</a>`;
}

/** The one-line provenance: where it came from, linked back, and when we read that. */
function provenance(row, source) {
    return html`<p class="job-provenance"><span class="muted">Listing from</span> ${sourceLink(row, source)}${row.posted_at ? html` <span class="muted">· posted ${dateWords(row.posted_at)}</span>` : ''}</p>`;
}

/** One listing in a list: title, who and where, the excerpt, the tags, and the link back to the board. */
function listingItem(row, { source }) {
    const l = meta(row);
    return html`<li class="job-item" id="${l.id}">
<h3 class="job-title"><a href="/jobs/${l.id}">${l.title}</a></h3>
<p class="job-meta"><span class="job-company">${l.company}</span> · <span class="job-location">${l.location || 'Location not given'}</span>${l.remote ? html` · ${badge('Remote', 'ok')}` : ''}${l.job_type ? html` · <span class="job-type">${l.job_type}</span>` : ''}${l.salary ? html` · <span class="job-salary">${l.salary}</span>` : ''}</p>
<p class="job-excerpt">${l.excerpt}</p>
${l.tags.length ? html`<ul class="job-tags">${l.tags.slice(0, 8).map((t) => html`<li>${t}</li>`)}</ul>` : ''}
${provenance(row, source)}
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

module.exports = { listingItem, listingList, sourceLink, provenance, jobPosting, dateWords, plainExcerpt, meta };
