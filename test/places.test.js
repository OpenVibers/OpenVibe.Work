'use strict';
/**
 * One city, however a board spells it (server/jobs/places.js): a search for one spelling finds every spelling, the
 * home page names the city once with the count its link's search finds, and a company page counts it once. A place
 * that only contains a city's name ("Romania", "Bay Area") is not mistaken for one.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const places = require('../server/jobs/places');
const store = require('../server/jobs/store');

(async () => {
    await check('the helpers: spellings, noise words, literal % and _', async () => {
        assert.deepStrictEqual(places.patternsOf('MÜNCHEN'), ['%munich%', '%münchen%', '%muenchen%']);
        assert.deepStrictEqual(places.patternsOf('Munich'), places.patternsOf('muenchen'));
        assert.deepStrictEqual(places.patternsOf('London Office'), ['%london%']);
        assert.deepStrictEqual(places.patternsOf('50%_off'), ['%50\\%\\_off%']);
        assert.deepStrictEqual(places.patternsOf(''), []);
        assert.deepStrictEqual(places.placeOf('Zürich, Zürich, Switzerland'), { key: 'zurich', name: 'Zurich' });
        assert.deepStrictEqual(places.placeOf('Berlin (Hybrid)'), { key: 'berlin', name: 'Berlin' });
        assert.deepStrictEqual(places.placeOf('San Francisco Bay Area'), { key: 'san francisco bay area', name: 'San Francisco Bay Area' });
        assert.deepStrictEqual(places.mergePlaces([{ p: 'Munich', n: 4 }, { p: 'München', n: 2 }, { p: 'London Office', n: 1 }, { p: 'London', n: 3 }]),
            [{ place: 'Munich', count: 6 }, { place: 'London', count: 4 }]);
    });

    const t = await boot();
    try {
        const s = t.ctx.s;
        const now = new Date().toISOString();
        const row = (sourceId, company, location) => ({
            id: store.idOf('probe', sourceId), source: 'probe', source_id: sourceId, url: `https://jobs.example/${sourceId}`, title: `Engineer ${sourceId}`,
            company, location, remote: false, tags: '', job_type: 'full time', salary: null, excerpt: 'x', search_text: `engineer ${company}`.toLowerCase(),
            posted_at: now, sort_at: now,
        });
        await store.upsertListings(s, [
            row('m1', 'Alpenwerk', 'München'), row('m2', 'Alpenwerk', 'Munich, Bavaria'), row('m3', 'Isar Labs', 'Muenchen'),
            row('r1', 'Carpati', 'Bucharest, Romania'), row('l1', 'Thames Ltd', 'London Office'), row('l2', 'Thames Ltd', 'London'),
        ], { sourceId: 'probe', fetchedAt: now });

        await check('a search for one spelling finds every spelling, and only them', async () => {
            const ids = async (q) => (await (await t.get(`/api/v1/jobs?location=${encodeURIComponent(q)}&limit=100`)).json()).jobs.filter((j) => j.source === 'probe').map((j) => j.title).sort();
            assert.deepStrictEqual(await ids('munich'), ['Engineer m1', 'Engineer m2', 'Engineer m3']);
            assert.deepStrictEqual(await ids('München'), ['Engineer m1', 'Engineer m2', 'Engineer m3']);
            assert.deepStrictEqual(await ids('Romania'), ['Engineer r1'], 'a country still finds its places');
            assert.deepStrictEqual(await ids('london office'), ['Engineer l1', 'Engineer l2']);
        });

        await check('a saved search counts new listings with the same spellings', async () => {
            const n = await store.newCount(s, { query: '', remote: '', type: '', location: 'münchen', last_seen_at: '1970-01-01T00:00:00.000Z' });
            assert.ok(n >= 3, `new since: ${n}`);
        });

        await check('the home names the city once, with the count its search finds', async () => {
            const sum = await store.homeSummary(s, { now: Date.now() + 3600e3, places: 40 });
            const munich = sum.places.filter((p) => /m(u|ü|ue)nchen|munich/i.test(p.place));
            assert.deepStrictEqual(munich.map((p) => p.place), ['Munich']);
            const found = (await (await t.get(`/api/v1/jobs?location=Munich&limit=100`)).json()).count;
            assert.strictEqual(munich[0].count, found);
        });

        await check('a company page counts its city once', async () => {
            const companies = require('../server/jobs/companies');
            const c = await companies.bySlug(s, 'alpenwerk');
            assert.deepStrictEqual(c.places, [{ place: 'Munich', count: 2 }]);
        });
    } finally {
        await t.close();
    }
    done();
})();
