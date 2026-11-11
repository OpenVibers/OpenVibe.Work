'use strict';
/**
 * A one-line board post split into a listing (server/jobs/hiring-line.js): the two lines from the brief, a URL first,
 * several roles, a role after the place and terms, visa and relocation, no company, and the title helper that stops
 * "Role at Company at Company" on the pages and in Search.
 */
const assert = require('assert');
const { check, done } = require('./helpers/boot');
const { parseHiringLine } = require('../server/jobs/hiring-line');
const { fullTitle } = require('../server/render/listing');

(async () => {
    await check('a URL first, a place, terms and "at COMPANY": title is the company alone', async () => {
        const p = parseHiringLine('https://www.monumental.co/ | Amsterdam, The Netherlands | Full Time | Onsite at MONUMENTAL');
        assert.deepStrictEqual(
            [p.company, p.title, p.location, p.remote, p.job_type, p.salary, p.tags],
            ['MONUMENTAL', 'MONUMENTAL', 'Amsterdam, The Netherlands', false, 'Full time', null, ['Onsite']]);
        assert.ok(!p.title.includes('http'), 'a URL is never a title');
        assert.strictEqual(p.line, 'https://www.monumental.co/ | Amsterdam, The Netherlands | Full Time | Onsite at MONUMENTAL');
    });

    await check('several roles: the first and "+N more roles", with the place, terms and pay in their fields', async () => {
        const p = parseHiringLine('Mechanical Engineer, Electrical Engineer, Robotic Controls Engineer | New York, NY | ONSITE | Full-time | $220K-$300K at Nirvana Robotics');
        assert.strictEqual(p.company, 'Nirvana Robotics');
        assert.strictEqual(p.title, 'Mechanical Engineer +2 more roles at Nirvana Robotics');
        assert.deepStrictEqual(p.roles, ['Mechanical Engineer', 'Electrical Engineer', 'Robotic Controls Engineer']);
        assert.deepStrictEqual([p.location, p.remote, p.job_type, p.salary, p.tags],
            ['New York, NY', false, 'Full time', '$220K-$300K', ['Onsite']]);
    });

    await check('a URL with no "at X": the company is the URL\'s host, and the host is not a title URL', async () => {
        const p = parseHiringLine('https://www.monumental.co/ | Amsterdam, The Netherlands | Full Time | Onsite');
        assert.deepStrictEqual([p.company, p.title, p.location], ['monumental.co', 'monumental.co', 'Amsterdam, The Netherlands']);
        assert.ok(!p.title.includes('http') && !p.title.includes('www.'));
    });

    await check('roles separated by a pipe: "+1 more role"', async () => {
        const p = parseHiringLine('Acme | Software Engineer | Platform Engineer | Remote (US) | Full-time');
        assert.strictEqual(p.title, 'Software Engineer +1 more role at Acme');
        assert.deepStrictEqual(p.roles, ['Software Engineer', 'Platform Engineer']);
        assert.deepStrictEqual([p.location, p.remote, p.job_type], ['Remote (US)', true, 'Full time']);
    });

    await check('a role after the place, terms and pay; visa and relocation are chips', async () => {
        const p = parseHiringLine('KSC Trading | Remote | Full-Time | Senior Backend Software Engineer | $200k to $250k USD Total Compensation + Benefits');
        assert.deepStrictEqual([p.company, p.title, p.location, p.remote, p.job_type, p.salary, p.tags],
            ['KSC Trading', 'Senior Backend Software Engineer at KSC Trading', 'Remote', true, 'Full time',
                '$200k to $250k USD Total Compensation + Benefits', []]);

        const flow = parseHiringLine('Flow Traders | Research Engineer | Hong Kong | Full Time | Visa | Relocation');
        assert.deepStrictEqual([flow.title, flow.location, flow.job_type, flow.tags],
            ['Research Engineer at Flow Traders', 'Hong Kong', 'Full time', ['Visa sponsorship', 'Relocation']]);
    });

    await check('no company: the line is not a listing (the thin-listing gate holds it)', async () => {
        const p = parseHiringLine('Remote (US) | Full-time | Senior Software Engineer');
        assert.strictEqual(p.company, '');
        assert.strictEqual(p.title, 'Senior Software Engineer', 'a role can be read, but there is no company to publish it under');
    });

    await check('real lines: multiple roles, a place list, salary with punctuation, no invented fields', async () => {
        const charge = parseHiringLine('Charge Robotics | Multiple Roles | Full-time | Onsite | SF Bay Area');
        assert.deepStrictEqual([charge.title, charge.company, charge.location, charge.job_type, charge.tags],
            ['Multiple Roles at Charge Robotics', 'Charge Robotics', 'SF Bay Area', 'Full time', ['Onsite']]);

        const stoke = parseHiringLine('Stoke Space | ONSITE in Seattle, WA / Moses Lake, WA / Cape Canaveral, FL | Software Engineer | Full-Time, Internship | Salary: $98k-$289k USD | https://www.stokespace.com');
        assert.deepStrictEqual([stoke.title, stoke.company, stoke.location, stoke.remote, stoke.job_type, stoke.salary, stoke.tags],
            ['Software Engineer at Stoke Space', 'Stoke Space', 'Seattle, WA / Moses Lake, WA / Cape Canaveral, FL', false,
                'Full time, Internship', 'Salary: $98k-$289k USD', ['Onsite']]);

        const discord = parseHiringLine('Discord | Senior Software Engineer, Application Security | REMOTE (US West Coast) or San Francisco, CA | $196K-$245K base + equity');
        assert.deepStrictEqual([discord.title, discord.location, discord.remote, discord.salary],
            ['Senior Software Engineer, Application Security at Discord', 'REMOTE (US West Coast) or San Francisco, CA', true, '$196K-$245K base + equity']);

        const odoo = parseHiringLine('Odoo | Software Developer | Belgium | Full Time | Hybrid');
        assert.deepStrictEqual([odoo.title, odoo.location, odoo.job_type, odoo.tags],
            ['Software Developer at Odoo', 'Belgium', 'Full time', ['Hybrid']]);
    });

    await check('"Role at Company" is not made to say the company twice', async () => {
        assert.strictEqual(fullTitle({ title: 'Senior Engineer at Acme', company: 'Acme' }), 'Senior Engineer at Acme');
        assert.strictEqual(fullTitle({ title: 'Acme', company: 'Acme' }), 'Acme');
        assert.strictEqual(fullTitle({ title: 'Senior Engineer', company: 'Acme' }), 'Senior Engineer at Acme');
        assert.strictEqual(fullTitle({ title: 'Senior Engineer', company: '' }), 'Senior Engineer');
    });

    done();
})().catch((err) => { console.error(err); process.exit(1); });
