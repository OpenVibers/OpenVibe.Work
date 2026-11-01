'use strict';
/**
 * The canonical job types: the mapper that reads a board's own words, the facet that counts the nine types, and the
 * filter that finds them. The listings come from the stand-in boards through the real ingest, so what is counted is
 * what is stored and what is searched.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const jobTypes = require('../server/jobs/job-types');

(async () => {
    await check('the mapper reads the words the boards really use, in every language', () => {
        assert.deepStrictEqual(jobTypes.mapTypes('Full time'), ['full-time']);
        assert.deepStrictEqual(jobTypes.mapTypes('full_time'), ['full-time']);
        assert.deepStrictEqual(jobTypes.mapTypes('Fulltime'), ['full-time']);
        assert.deepStrictEqual(jobTypes.mapTypes('Vollzeit'), ['full-time']);
        assert.deepStrictEqual(jobTypes.mapTypes('Temps plein'), ['full-time']);
        assert.deepStrictEqual(jobTypes.mapTypes('Teilzeit'), ['part-time']);
        assert.deepStrictEqual(jobTypes.mapTypes('Minijob (geringfügige beschäftigung)'), ['part-time']);
        assert.deepStrictEqual(jobTypes.mapTypes('Werkstudent, working student, hilfstätigkeit / student'), ['part-time']);
        assert.deepStrictEqual(jobTypes.mapTypes('unbefristeter arbeitsvertrag'), ['permanent']);
        assert.deepStrictEqual(jobTypes.mapTypes('Festanstellung'), ['permanent']);
        assert.deepStrictEqual(jobTypes.mapTypes('CDI - contrat à durée indéterminée'), ['permanent', 'contract']);
        assert.deepStrictEqual(jobTypes.mapTypes('vaste dienstverband (onbepaalde tijd)'), ['permanent']);
        assert.deepStrictEqual(jobTypes.mapTypes('contrato indefinido'), ['permanent']);
        assert.deepStrictEqual(jobTypes.mapTypes('befristeter arbeitsvertrag'), ['temporary']);
        // A board that writes "contrat" says "contract", so it is both: temporary work, and a contract.
        assert.deepStrictEqual(jobTypes.mapTypes('CDD - contrat à durée déterminée'), ['temporary', 'contract']);
        assert.deepStrictEqual(jobTypes.mapTypes('tijdelijk contract'), ['temporary', 'contract']);
        assert.deepStrictEqual(jobTypes.mapTypes('Contract'), ['contract']);
        assert.deepStrictEqual(jobTypes.mapTypes('Freelancer / selbstständiger'), ['freelance']);
        assert.deepStrictEqual(jobTypes.mapTypes('auto-entrepreneur'), ['freelance']);
        assert.deepStrictEqual(jobTypes.mapTypes('Praktikum'), ['internship']);
        assert.deepStrictEqual(jobTypes.mapTypes('stage de fin d\'études'), ['internship']);
        assert.deepStrictEqual(jobTypes.mapTypes('Traineeship'), ['internship']);
        assert.deepStrictEqual(jobTypes.mapTypes('Ausbildung'), ['apprenticeship']);
        assert.deepStrictEqual(jobTypes.mapTypes('duales studium'), ['apprenticeship']);
        assert.deepStrictEqual(jobTypes.mapTypes('Alternance'), ['apprenticeship']);
        assert.deepStrictEqual(jobTypes.mapTypes('Volunteer'), ['volunteer']);
        assert.deepStrictEqual(jobTypes.mapTypes('bénévolat'), ['volunteer']);
    });

    await check('a listing that names two types is both, and the words that are not types are dropped', () => {
        assert.deepStrictEqual(jobTypes.mapTypes('Experienced, Permanent, Full time'), ['permanent', 'full-time']);
        assert.deepStrictEqual(jobTypes.mapTypes('permanent, full_time'), ['permanent', 'full-time']);
        // A seniority is not a type: it is dropped, and the type beside it is kept.
        assert.deepStrictEqual(jobTypes.mapTypes('Experienced, Permanent, Full time'), ['permanent', 'full-time']);
        assert.deepStrictEqual(jobTypes.mapTypes('Berufserfahren'), []);
        assert.deepStrictEqual(jobTypes.mapTypes('Berufseinsteiger'), []);
        assert.deepStrictEqual(jobTypes.mapTypes('Mid-Senior'), []);
        assert.deepStrictEqual(jobTypes.mapTypes('Teamleitung'), []);
        assert.deepStrictEqual(jobTypes.mapTypes('professional / experienced'), []);
        // A company's name is not a type either, and is never shown raw.
        assert.deepStrictEqual(jobTypes.mapTypes('chocolate factory, keynsham [9025]'), []);
        assert.deepStrictEqual(jobTypes.mapTypes(''), []);
        assert.deepStrictEqual(jobTypes.mapTypes(null), []);
        // A longer word is not a type: "contractor" is not a "contract".
        assert.deepStrictEqual(jobTypes.mapTypes('independent contractor'), ['freelance']);
        assert.deepStrictEqual(jobTypes.mapTypes('unbefristet'), ['permanent']);
        assert.deepStrictEqual(jobTypes.mapTypes('befristet'), ['temporary']);
    });

    await check('the labels are ours, and a reader\'s ?type= is read as a type or as plain words', () => {
        assert.strictEqual(jobTypes.labelText('permanent, full_time'), 'Permanent, Full time');
        assert.strictEqual(jobTypes.labelText('Berufserfahren'), '', 'nothing is shown when no type is named');
        assert.strictEqual(jobTypes.label('full-time'), 'Full time');
        assert.strictEqual(jobTypes.canonicalKey('Full time'), 'full-time');
        assert.strictEqual(jobTypes.canonicalKey('full_time'), 'full-time');
        assert.strictEqual(jobTypes.canonicalKey('FULL-TIME'), 'full-time');
        assert.strictEqual(jobTypes.canonicalKey('unbefristeter arbeitsvertrag'), null, 'not one of the nine');
        assert.strictEqual(jobTypes.canonicalKey(''), null);
    });

    const t = await boot({ env: { WORK_INGEST_PAGES: '2' } });
    try {
        await t.ctx.ingest.runAll();
        // Two listings in the boards' own words: a German one and a French one.
        t.boards.add('arbeitnow', {
            slug: 'support-werkstudent-berlin',
            company_name: 'Nordlicht Systems',
            title: 'Support Werkstudent',
            description: '<p>Support in Berlin.</p>',
            remote: false,
            url: 'https://www.arbeitnow.com/view/support-werkstudent-berlin-45678',
            tags: ['support'],
            job_types: ['Werkstudent', 'hilfstätigkeit'],
            location: 'Berlin, Germany',
            created_at: 1791800000,
        });
        t.boards.add('remotive', {
            id: 1900900, url: 'https://remotive.com/remote-jobs/other/consultant-cdi-1900900',
            title: 'Consultant CDI', company_name: 'Longform Ltd', category: 'Other', tags: ['consulting'],
            job_type: 'CDI - contrat à durée indéterminée', publication_date: '2026-10-02T10:00:00',
            candidate_required_location: 'Worldwide', salary: '', description: '<p>A permanent contract.</p>',
        });
        await t.ctx.ingest.runAll();

        await check('the facet counts the canonical types, most first, and says nothing a board said', async () => {
            const all = (await t.get('/api/v1/jobs')).json();
            assert.ok(all.count > 0, 'a search without a type filter finds nothing');
            const facets = all.facets;
            assert.ok(facets.type.length > 0, 'the facet has types');
            for (const f of facets.type) {
                assert.ok(jobTypes.KEYS.includes(f.type), `not a canonical type: ${f.type}`);
                assert.ok(f.count > 0, `${f.type} has no listings`);
            }
            assert.ok(facets.type.length <= 9, 'at most nine chips');
            const counts = facets.type.map((f) => f.count);
            assert.deepStrictEqual(counts, [...counts].sort((a, b) => b - a), 'most first');
            // The raw strings are gone: no chip carries a board's own wording.
            for (const f of facets.type) assert.ok(!/unbefristet|cdi|berufserfahren|erfahren/i.test(f.type));
        });

        await check('every chip is a filter that finds exactly what the chip counted', async () => {
            const facets = (await t.get('/api/v1/jobs')).json().facets;
            for (const f of facets.type) {
                const page = (await t.get(`/api/v1/jobs?type=${f.type}`)).json();
                assert.strictEqual(page.facets.matches, f.count, `the chip for ${f.type} does not match its count`);
            }
            // A listing that names two types is found by either.
            const permanent = (await t.get('/api/v1/jobs?type=permanent')).json();
            assert.ok(permanent.jobs.some((j) => /Consultant CDI/.test(j.title)), 'the French listing is not permanent');
            const partTime = (await t.get('/api/v1/jobs?type=part-time')).json();
            assert.ok(partTime.jobs.some((j) => /Support Werkstudent/.test(j.title)), 'the German listing is not part time');
            // And it is counted under both.
            const fullTime = (await t.get('/api/v1/jobs?type=full-time')).json();
            assert.ok(fullTime.jobs.some((j) => /Frontend Engineer/.test(j.title)));
        });

        await check('a type in a board\'s own words still works, as the plain search it always was', async () => {
            const raw = (await t.get('/api/v1/jobs?type=Werkstudent')).json();
            assert.ok(raw.jobs.some((j) => /Support Werkstudent/.test(j.title)), 'the raw value finds nothing');
            const unknown = (await t.get('/api/v1/jobs?type=nothinglikethis')).json();
            assert.strictEqual(unknown.count, 0);
            assert.strictEqual(unknown.facets.matches, 0);
        });

        await check('the list page shows the canonical chips, and the cards the canonical labels', async () => {
            const html = (await t.get('/jobs')).text;
            assert.match(html, /aria-label="Job type"/);
            for (const f of (await t.get('/api/v1/jobs')).json().facets.type) {
                assert.ok(html.includes(`type=${f.type}`), `no chip for ${f.type}`);
            }
            assert.ok(!html.includes('unbefristeter arbeitsvertrag'), 'a board\'s own wording is on the page');
            assert.ok(!html.includes('>Berufserfahren'), 'a seniority is on the page');
            // The cards carry the label, not the raw value.
            assert.ok(html.includes('Full time') || html.includes('Permanent'), 'the cards carry no canonical label');
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
