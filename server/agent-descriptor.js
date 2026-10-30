'use strict';
// What openvibe.work tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// Every field is something this host really serves: the public pages (the home, the jobs search and one listing,
// companies and one company, the sources, the API reference and the update log), the JSON API under /api/v1 and
// its /docs reference, llms.txt and the sitemap. Reading the listings is public; a saved search is a person's, so
// the API also takes a Network sign-in. No OpenAPI document or MCP endpoint is published here, so none is named.
module.exports = {
    id: 'work',
    name: 'OpenVibe.Work',
    purpose: 'Find work on open job boards: listings from Arbeitnow, We Work Remotely, Remotive and RemoteOK under their terms, searchable with facets and each linking back to the original, plus saved searches and OpenVibe.Watch alerts for a signed-in person.',
    home: 'https://openvibe.work',
    site: 'openvibe.work',
    api: '/api/v1',
    docs: '/docs',
    policy: {
        auth: ['none', 'Network OIDC'],
    },
};
