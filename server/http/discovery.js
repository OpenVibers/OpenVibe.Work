'use strict';

/**
 * Crawl artifacts for openvibe.work, built with openvibe-shared/seo: robots.txt, sitemap.xml, llms.txt and
 * llms-full.txt, and the home page's JSON-LD. The public pages are for search engines and AI crawlers; sign-in and
 * the API are not, and neither are a person's saved searches.
 *
 * The sitemap lists the site's own pages plus the newest listings (their links back to the board are what a crawler
 * wants to follow), capped at SITEMAP_JOBS. llms-full.txt describes the site's own pages, not every listing: a
 * crawler wanting the listings has /jobs and the sitemap.
 */
const fs = require('fs');
const path = require('path');
const seo = require('openvibe-shared/seo');
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');
const store = require('../jobs/store');
const sources = require('../jobs/sources');

const SITE_NAME = 'OpenVibe.Work';
const DESCRIPTION = 'OpenVibe.Work — Find work, with an agent on your side. Job listings from open boards with their source, searchable and free to read.';
const DISALLOW = ['/auth/', '/api/', '/saved'];
const SITEMAP_JOBS = 1000;

const PAGE_TEXT = {
    '/': ['OpenVibe.Work home', 'OpenVibe.Work gathers job listings from public job boards, names the source of every one and links back to the original listing. Search is free and needs no account.'],
    '/jobs': ['Jobs', 'Search job listings gathered from Arbeitnow, Remotive and RemoteOK, newest first, filterable by words, workplace, job type and location.'],
    '/sources': ['Sources', 'The public job boards OpenVibe.Work gathers from, the terms each is used under as applied here, and when each was last read.'],
    '/docs': ['API', 'The OpenVibe.Work API: search the listings, read one with its provenance, list the sources and their terms, keep saved searches.'],
    '/updates': ['What shipped on OpenVibe.Work', 'This site\'s update log, from the network changelog feed.'],
};

function dayOf(ts) {
    const m = String(ts == null ? '' : ts).match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
}
function siteUpdated() {
    try { return dayOf(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'STATUS.json'), 'utf8')).updated); } catch { return null; }
}

function homeJsonLd(config) {
    const site = String(config.baseUrl).replace(/\/+$/, '');
    return [
        seo.jsonLd.website({ name: SITE_NAME, url: site, description: DESCRIPTION, searchUrl: `${site}/jobs?q={q}` }),
        seo.jsonLd.softwareApp({ name: SITE_NAME, url: site, description: DESCRIPTION, category: 'BusinessApplication', keywords: 'openvibe, jobs, job search, remote jobs' }),
        seo.jsonLd.webPage({ name: SITE_NAME, url: `${site}/`, description: DESCRIPTION, siteUrl: site }),
    ];
}

const publicPages = () => [
    { path: '/', changefreq: 'daily', priority: 1.0 },
    { path: '/jobs', changefreq: 'hourly', priority: 0.9 },
    { path: '/sources', changefreq: 'weekly', priority: 0.6 },
    { path: '/docs', changefreq: 'monthly', priority: 0.5 },
    { path: '/updates', changefreq: 'daily', priority: 0.5 },
];

function createDiscoveryRoutes(ctx) {
    const { config, s } = ctx;
    const r = asyncRouter();
    const site = String(config.baseUrl).replace(/\/+$/, '');
    const abs = (p) => `${site}${p}`;
    const TEXT = cache.htmlHeaders({ maxAge: 3600 });

    r.get('/robots.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(
            '# openvibe.work: the public pages are for search and AI crawlers; sign-in, the API and saved searches are not.\n'
            + seo.robotsTxt({ sitemaps: [abs('/sitemap.xml')], disallow: DISALLOW }));
    });

    r.get('/llms.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(seo.llmsTxt({
            name: SITE_NAME,
            summary: DESCRIPTION,
            details: 'Every page is server-rendered and readable without JavaScript. Listings come from public job boards under their terms: the source is named and the original listing is linked; only a short excerpt is kept here.',
            sections: [
                { title: 'Start here', links: [
                    { title: 'OpenVibe.Work', url: abs('/'), note: 'Find work, with an agent on your side.' },
                    { title: 'Search the listings', url: abs('/jobs'), note: 'Filter by words, workplace, job type and location.' },
                    { title: 'Where the listings come from', url: abs('/sources'), note: `${sources.SOURCES.map((x) => x.name).join(', ')}, with the terms each is used under.` },
                    { title: 'What shipped on OpenVibe.Work', url: abs('/updates') },
                ] },
                { title: 'For machines', links: [
                    { title: 'The API', url: abs('/docs'), note: 'GET /api/v1/jobs, /jobs/:id, /sources — public.' },
                    { title: 'The API, live', url: abs('/api/v1/jobs'), note: 'JSON listings with their source and the original URL.' },
                    { title: 'Sitemap', url: abs('/sitemap.xml') },
                    { title: 'Full text for language models', url: abs('/llms-full.txt') },
                    { title: 'Release metadata (JSON)', url: abs('/release.json') },
                ] },
                { title: 'Elsewhere', links: [
                    { title: 'OpenVibe.Network', url: 'https://openvibe.network', note: 'accounts, apps and grants' },
                    { title: 'OpenVibe.Services', url: 'https://openvibe.services', note: 'apps, keys and capability grants' },
                ] },
            ],
        }));
    });

    r.get('/llms-full.txt', (_req, res) => {
        const pages = publicPages().map((p) => ({ url: p.path, title: PAGE_TEXT[p.path][0], text: PAGE_TEXT[p.path][1] }));
        res.type('text/plain').set('Cache-Control', TEXT).send(seo.llmsFull({
            site: SITE_NAME,
            summary: 'Every public page of OpenVibe.Work, one paragraph each; the listings themselves are at /jobs.',
            base: site,
            maxBytes: 64 * 1024,
            sections: [{ title: 'Pages', pages }],
        }));
    });

    r.get('/sitemap.xml', async (_req, res) => {
        const lastmod = siteUpdated();
        const urls = publicPages().map((e) => ({ loc: abs(e.path), ...(lastmod ? { lastmod } : {}), changefreq: e.changefreq, priority: e.priority }));
        // The newest listings, so a crawler reaches each board's own page through ours. No lastmod: these entries turn
        // over with every ingest, and the site's own freshness is the pages above.
        for (const row of await store.recentIds(s, SITEMAP_JOBS)) urls.push({ loc: abs(`/jobs/${row.id}`), changefreq: 'daily', priority: 0.4 });
        res.type('application/xml').set('Cache-Control', TEXT).send(seo.sitemapXml(urls));
    });

    return r;
}

module.exports = { createDiscoveryRoutes, homeJsonLd, publicPages, DESCRIPTION, SITE_NAME, DISALLOW, PAGE_TEXT };
