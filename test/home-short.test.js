'use strict';
// The home on a phone (the owner's short-pages rule, 2026-10-30): the sections below the search are one at a time,
// picked with a row of chips, and the parts a reader rarely needs fold closed. Radio inputs and :has() for the chips
// and a checkbox and a label for the folds, no script: every section and every part stays in the page for the
// crawlers, and a wider screen shows them all and no chips.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    // A few listings, so the home has a field, a city, a company and a pay to show: the sections below the search
    // are the panes of the pick block, and a pane only exists when the site has something for it.
    const now = new Date().toISOString();
    for (const [i, row] of [
        { title: 'Backend engineer', company: 'Nordlicht Systems', location: 'Berlin, Germany', remote: true, tags: 'nodejs,postgresql', salary: '60,000 EUR a year' },
        { title: 'Frontend engineer', company: 'Helles Werk', location: 'Amsterdam, Netherlands', remote: false, tags: 'typescript,css', salary: '' },
        { title: 'Data scientist', company: 'Nordlicht Systems', location: 'Berlin, Germany', remote: true, tags: 'python,ml', salary: '70,000 EUR a year' },
    ].entries()) {
        await t.ctx.s.db.query(
            `INSERT INTO work_listings (id, source, source_id, url, title, company, location, remote, tags, job_type, salary, excerpt, search_text, posted_at, sort_at, fetched_at, first_seen_at, last_seen_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$14,$14,$14)`,
            [`job_short${'0'.repeat(20)}${i}`, 'arbeitnow', `short-${i}`, `https://example.org/job/${i}`, row.title, row.company, row.location,
                row.remote, row.tags, 'permanent', row.salary, 'A short excerpt of the listing.', `${row.title} ${row.company} ${row.tags}`.toLowerCase(), now]);
    }

    await check('the home shows every section on a phone, and keeps every one in the page', async () => {
        const r = await t.get('/');
        assert.strictEqual(r.status, 200, r.text.slice(0, 300));
        const home = r.text;
        assert.ok(!home.includes('pick-browse'), 'the browse chip row is gone');
        const panes = [...home.matchAll(/<div class="pick-pane" id="pp-browse-([a-z]+)">/g)].map((m) => m[1]);
        assert.ok(panes.length >= 3, `the sections are all in the page (${panes.length})`);
        // The sections themselves are in the page, not removed.
        for (const h of ['Browse by field', 'Jobs by city', 'Latest remote jobs', 'Newest jobs that state the pay', 'Companies with the most openings']) {
            assert.ok(home.includes(`>${h}</h2>`), `${h} is in the page`);
        }
        // The search stays first, and the newest listings come with it.
        assert.ok(home.indexOf('id="search"') < home.indexOf('id="h-latest"'), 'the newest listings stay with the search');
    });

    await check('the parts a reader rarely need start open, and no card or chip is hidden', async () => {
        const r = await t.get('/');
        const home = r.text;
        for (const [id, title] of [['faq', 'Questions people ask'], ['network', 'Part of OpenVibe'], ['shipped', 'Recently shipped on OpenVibe.Work']]) {
            const re = new RegExp(`<div class="fold[^"]*" id="fold-${id}"><input class="fold-toggle" type="checkbox" id="fold-${id}-open" checked>`
                + `<label class="fold-h" for="fold-${id}-open"><h2[^>]*>[^<]*${title}[^<]*</h2>.*?<div class="fold-body">`);
            assert.ok(re.test(home), `the ${title} fold is on the home and starts open`);
        }
        // The parts themselves are in the page, not removed.
        assert.match(home, /<div class="home-faq">/, 'the questions are in the page');
        assert.match(home, /class="sc-net"/, 'the rest of OpenVibe is in the page');
        assert.match(home, /data-ov-shipped="list"/, 'what shipped is in the page');
        const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'home.css'), 'utf8');
        assert.ok(!/\.home-cards\.short > li:nth-child\(n\+7\)/.test(css), 'no job card is hidden');
        assert.ok(!/\.home-chips > li:nth-child\(n\+9\)/.test(css), 'no chip is hidden');
        const fold = css.slice(css.indexOf('/* The fold (the owner'));
        assert.match(fold, /\.fold-toggle:checked ~ \.fold-body \{ display: block; \}/, 'an open fold shows its body');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
