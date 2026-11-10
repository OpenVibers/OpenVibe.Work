'use strict';
// The home's picture is the thing itself: the newest remote listing as a card that leads with the board it came from,
// on a small stack of the next two (the owner, 2026-11-09: no more "generic circled" homes). Real rows only: with no
// listings there is no picture, and never an invented one.
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();

    await check('with no listings the hero has no picture (and no orbit)', async () => {
        const r = await t.get('/');
        assert.strictEqual(r.status, 200);
        assert.ok(!r.text.includes('class="wk-scene"'), 'no picture without a listing');
        assert.ok(!/class="sc-orbit|sc-orbit-/.test(r.text), 'the generic orbit is gone');
    });

    const rows = [
        { title: 'Backend engineer', company: 'Nordlicht Systems', location: 'Berlin, Germany', at: '2026-11-09T10:00:00.000Z' },
        { title: 'Data scientist', company: 'Helles Werk', location: 'Remote, Europe', at: '2026-11-09T11:00:00.000Z' },
        { title: 'Support lead', company: 'Kleine Post', location: '', at: '2026-11-09T12:00:00.000Z' },
    ];
    await Promise.all(rows.map((row, i) => t.ctx.s.db.query(
        `INSERT INTO work_listings (id, source, source_id, url, title, company, location, remote, tags, job_type, salary, excerpt, search_text, posted_at, sort_at, fetched_at, first_seen_at, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$14,$14,$14)`,
        [`job_pic${'0'.repeat(22)}${i}`, 'arbeitnow', `pic-${i}`, `https://example.org/job/${i}`, row.title, row.company, row.location,
            true, 'nodejs', 'permanent', '', 'A short excerpt of the listing.', `${row.title} ${row.company}`.toLowerCase(), row.at])));

    await check('with listings the picture is the newest one, leading with its board, over the next two', async () => {
        const r = await t.get('/');
        const scene = (r.text.match(/<figure class="wk-scene"[\s\S]*?<\/figure>/) || [''])[0];
        assert.ok(scene, 'the picture is in the hero');
        const cards = Array.from(scene.matchAll(/<a class="wk-scene-card (is-front|is-second|is-third)" href="(\/jobs\/[^"]+)"([^>]*)>\s*<span class="wk-scene-src"><i aria-hidden="true"><\/i>From ([^<]+)<\/span>\s*<b>([^<]+)<\/b>/g));
        assert.deepStrictEqual(cards.map((m) => m[1]), ['is-third', 'is-second', 'is-front'], 'the front card is last in the markup, so it is on top');
        const front = cards[2];
        assert.strictEqual(front[5], 'Support lead', 'the front card is the newest listing');
        assert.ok(front[4].length > 2 && front[4] !== 'a public board', `it names its board: ${front[4]}`);
        assert.ok(!/aria-hidden/.test(front[3]), 'the front card is a real link');
        cards.slice(0, 2).forEach((m) => assert.ok(/tabindex="-1" aria-hidden="true"/.test(m[3]), 'the cards behind are decoration: out of the tab order'));
        assert.match(scene, /<figcaption>The newest remote listing right now\. Every listing names its board\.<\/figcaption>/);
        assert.ok(!/class="sc-orbit|sc-orbit-/.test(r.text), 'the generic orbit is gone');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
