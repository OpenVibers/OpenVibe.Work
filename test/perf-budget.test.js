'use strict';
// Size budgets for openvibe.work's home page (roadmap WS-T task 1, openvibe-shared/perf-budget): the
// server as it runs (a fresh database), measured without a browser. Budgets sit about 10% above the
// 2026-10-08 measurement (see below); raising one is a decision to state in the commit.
//   node test/perf-budget.test.js
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { measure, check, format } = require('openvibe-shared/perf-budget');

// Budgets are set from the numbers measured on 2026-10-08 (the real ones, fresh database), rounded up with about 10%
// headroom; file counts are the measured counts and external files stay at 0. The CSS budget was raised from 16.5/4.1
// when the listings arrived (the search form, a listing list and the source blocks in app.css): the measured page is
// 18.2 KB raw / 4.3 KB brotli, still two stylesheets and no external file. The home page itself stayed inside its own
// budget — the listings replace the skeleton's placeholder sections rather than adding to them.
const BUDGETS = {
    htmlRawKB: 47,   // 46.2 with 2026-11-02: Shared 4.93.2 (labels kit, counted footer folds) (2026-11-01); 45.7 with 2026-11-01: the hero orbit (5 places, inline icons) (2026-11-01); 39.3 with openvibe-shared 4.66.0: the mark with depth and motion, ov-fx loaded on request (2026-10-31); 38.1 with the home's pick block and folds (the sections below the search are picked one at a time on a phone, 2026-10-30), plus the Hacker News "Who is hiring" source row (2026-10-31); 36.5 with openvibe-shared 4.53.0: the footer's columns fold on phones (2026-10-30); 31.2 with the Part of OpenVibe section (Shared 4.13, 2026-10-26); measured 24.9 (the home page: hero, features, steps, cta, JSON-LD)
    htmlBrotliKB: 10.5,   // 10.3 with 2026-11-01: the hero orbit (5 places, inline icons) (2026-11-01); 9.1 with the home's pick block and folds (the sections below the search are picked one at a time on a phone, 2026-10-30), plus the Hacker News source row; 7.8 with the Part of OpenVibe section (Shared 4.13, 2026-10-26); 6.2
    jsFiles: 5,   // 5 (theme-loader, web-runtime, navbar, footer, boost: openvibe-shared/shell)
    jsRawKB: 350.2, // 350.2 with openvibe-shared 4.142.0 (2026-11-07: the menu has a close button on a phone);  349.2 with openvibe-shared 4.139.0 (2026-11-07: the menu's feed rows lead with their picture, the footer and glyphs defer 38 KB); 348.2 with openvibe-shared 4.137.0 (2026-11-07: every script by its content hash, one menu button on a phone, the menu warms at idle); 346.1 with openvibe-shared 4.135.0 (2026-11-07: Ask your agent from any page (kit.askAgent), the Dock's Agent panel reads the timeline again, and the menu's feeds follow you); 345.4 with openvibe-shared 4.133.0 (2026-11-07: your feeds in the menu, the navbar keeps the Frame cards again, Messages and the balances on every signed-in site, and your online status); 345.4 with openvibe-shared 4.133.0 (2026-11-07: your feeds in the menu, the navbar keeps the Frame cards again, Messages and the balances on every signed-in site, and your online status); 343 with openvibe-shared 4.129.0 (2026-11-07: the one menu (the burger opens the OpenVibe menu)); 342 with openvibe-shared 4.122.0 (2026-11-06: the featured link's phone button (4.119.0), the Dock's agent view (4.120.0), the agent view in the Dock's pop-out (4.121.0) and the thread start page's head (4.122.0)); 338.4 with openvibe-shared 4.114.0 (2026-11-06: the one Share sheet in the navbar (ov-share.js and ov-qr.js load on the first press); navbar.js gains its click handler); 337.1 with openvibe-shared 4.112.1 (2026-11-06: theme-loader.js (4.111.1) and the footer/appbar phone CSS (4.112.1)); 335.8 with openvibe-shared 4.109.2 (2026-11-03: OpenVibe's own select, the navbar loads ov-forms); 333.1 with openvibe-shared 4.107.0 (2026-11-03: open.<tld> sites are named for their domain; the brand knows its front door); 332.5 with openvibe-shared 4.106.2 (2026-11-02: the site's name reads whole on a signed-in phone; the balances stack); 331.3 with openvibe-shared 4.103.0 (2026-11-02: the puzzle glyph, two-line sidebar rows, boost lets parsed pages go, eight solids) (2026-11-02); 328.2 openvibe-shared 4.70.0 (2026-11-01: the app bar, busy(), skeletons, view transitions); 324.8 with openvibe-shared 4.66.0: the mark with depth and motion, ov-fx loaded on request (2026-10-31); 323.2 with openvibe-shared 4.59.0: the Pair mark beside the name, set in the brand face (2026-10-31); 321.1 with openvibe-shared 4.53.0: the footer's columns fold on phones (2026-10-30); 318.1 with openvibe-shared 4.52.0: the Dock's loader and its Chats tab (2026-10-30); 315.6 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 307.8 with openvibe-shared 4.43.0 (room.css carries the kit tokens, 4.39.1; the kit's 4.39.0 rules); 300.5 openvibe-shared 4.25.0: the menu's orb beside the brand, both balances on phones, messages, the account sheet on phones and the bar stepping away on phones; 293 openvibe-shared 4.22.0: the navbar's magnifier search button and More dropdown (search.js and loading.js load only when used); 287.2 Shared 4.17.0: OpenCoins and Vibes chips (wallet: true) in the navbar; 273.2 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 264.3 with Shared 4.13.0 (2026-10-26: account links); 239.8
    jsBrotliKB: 83.7, // 83.7 with openvibe-shared 4.142.0 (2026-11-07: the menu has a close button on a phone);  83.5 with openvibe-shared 4.139.0 (2026-11-07: the menu's feed rows lead with their picture, the footer and glyphs defer 38 KB); 83.1 with openvibe-shared 4.137.0 (2026-11-07: every script by its content hash, one menu button on a phone, the menu warms at idle); 82.6 with openvibe-shared 4.135.0 (2026-11-07: Ask your agent from any page (kit.askAgent), the Dock's Agent panel reads the timeline again, and the menu's feeds follow you); 82.5 with openvibe-shared 4.133.0 (2026-11-07: your feeds in the menu, the navbar keeps the Frame cards again, Messages and the balances on every signed-in site, and your online status); 82.5 with openvibe-shared 4.133.0 (2026-11-07: your feeds in the menu, the navbar keeps the Frame cards again, Messages and the balances on every signed-in site, and your online status); 81.9 with openvibe-shared 4.129.0 (2026-11-07: the one menu (the burger opens the OpenVibe menu)); 81.7 with openvibe-shared 4.122.0 (2026-11-06: the featured link's phone button (4.119.0), the Dock's agent view (4.120.0), the agent view in the Dock's pop-out (4.121.0) and the thread start page's head (4.122.0)); 81.1 with openvibe-shared 4.114.0 (2026-11-06: the one Share sheet in the navbar (ov-share.js and ov-qr.js load on the first press); navbar.js gains its click handler); 80.9 with openvibe-shared 4.112.1 (2026-11-06: theme-loader.js (4.111.1) and the footer/appbar phone CSS (4.112.1)); 80.2 openvibe-shared 4.70.0 (2026-11-01: the app bar, busy(), skeletons, view transitions); 79.5 with openvibe-shared 4.59.0: the Pair mark beside the name, set in the brand face (2026-10-31); 78.2 with openvibe-shared 4.52.0: the Dock's loader and its Chats tab (2026-10-30); 77.6 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 76.1 with openvibe-shared 4.43.0 (room.css carries the kit tokens, 4.39.1; the kit's 4.39.0 rules); 74.2 openvibe-shared 4.25.0: the menu's orb beside the brand, both balances on phones, messages, the account sheet on phones and the bar stepping away on phones; 70.5 Shared 4.17.0: OpenCoins and Vibes chips (wallet: true) in the navbar; 67.9 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 65.3 Shared 4.12.0: the light/dark switch, the seasonal mark and the theme pairs; 56.5
    cssFiles: 3,   // 3 (app.css, the cached /shared/showcase.css and css/home.css, the curated home's counts, fields, cities, companies and questions, 2026-10-22)
    cssRawKB: 48,   // 47.0 with 2026-11-01: phone table cards (+1.3 KB raw) (2026-11-01); 45.6 with the listings' salary line and the fetch date under the link out (2026-10-31); 45.3 with the home's pick block and folds (the sections below the search are picked one at a time on a phone, 2026-10-30); 41.7 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 39.5 the home's phone rows, limits and fold (2026-10-29); 34.8 openvibe-shared 4.26.1 (hero visual); 29.3 with Shared 4.13.0 (2026-10-26: account links); 23.1 with css/home.css (2026-10-22); 15.0 before the listings; 18.2 after (the search form, the listing list, the source blocks)
    cssBrotliKB: 11,   // 10.4 with 2026-11-01: phone table cards (+1.3 KB raw) (2026-11-01); raised from 10 on 2026-10-31, with the measured page: 45.6 KB raw / 10.1 KB brotli (the listings' salary line, the gone line and the fetch date under the link out); 10.0 with the home's pick block and folds (the sections below the search are picked one at a time on a phone, 2026-10-30); 9.1 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 8.6 the home's phone rows, limits and fold (2026-10-29); 6.6–6.7 with Shared 4.13.0; raised from 8 for openvibe-shared v4.39.0 (+1.5 KB raw of kit/room/showcase CSS); measured 8.3
    externalFiles: 0,   // 0
};

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

(async () => {
    // A database of its own (not the shared dev PGlite in data/pglite, and not whatever the caller's
    // DATABASE_URL names), so the measurement is the server on a fresh database and the run leaves nothing.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-budget-'));
    const pgliteDir = path.join(dir, 'pglite');
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test',
            DATABASE_URL: '', DATABASE_DIRECT_URL: '', VALKEY_URL: '', WORK_PGLITE_DIR: pgliteDir,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    const base = `http://127.0.0.1:${port}`;
    try {
        let up = false;
        for (let i = 0; i < 600 && !up; i++) {
            up = await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
            if (!up) await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(up, `the server did not start:\n${stderr}`);
        assert.ok(fs.existsSync(pgliteDir), 'the server did not use the isolated database (WORK_PGLITE_DIR)');
        const m = await measure({ base });
        const over = check(m, BUDGETS);
        assert.deepStrictEqual(over, [], format(m, over));
        console.log(format(m));
        console.log('perf budget: all checks passed');
    } finally {
        child.kill();
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exitCode = 1; });
