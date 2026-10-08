#!/usr/bin/env node
'use strict';

/**
 * new-service.js — make a new OpenVibe service from this skeleton.
 *
 *   node scripts/new-service.js --id work --name OpenVibe.Work --domain openvibe.work --port 4960 \
 *       --tagline "Find work, with an agent on your side." --env WORK --out ../openvibe-work
 *
 * It copies the tree this file lives in (everything except node_modules/, .git/ and .claude/) to --out, replaces
 * the six placeholders in file contents AND in file names, and prints the next steps. Nothing else is touched:
 * no install, no commit, no deploy.
 *
 * The placeholders say: the service id (lowercase; config.service, the session cookies, the OAuth client id, the
 * systemd unit), the display name ("OpenVibe.Work"), the site ("openvibe.work"), the loopback port, the tagline,
 * and the environment prefix (WORK_LIMITS_MINUTE, WORK_PGLITE_DIR, WORK_TEST_STORE …). They are the TOKENS below,
 * built from parts on purpose: this file lives in the tree it copies, and a literal placeholder here would be
 * rewritten when a service is generated from a generated service.
 */
const fs = require('fs');
const path = require('path');

const T = (name) => `__${name}__`;
const TOKENS = [T('ID'), T('NAME'), T('DOMAIN'), T('PORT'), T('TAGLINE'), T('ENV')];
const TOKEN_RE = new RegExp(TOKENS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');

const SKIP = new Set(['node_modules', '.git', '.claude']);

function usage(msg) {
    if (msg) process.stderr.write(`new-service: ${msg}\n\n`);
    process.stderr.write(`Usage: node scripts/new-service.js --id <id> --name <name> --domain <domain> --port <port> ` +
        `--tagline "<line>" --env <ENV> --out <dir>\n\n` +
        `  --id       service id, lowercase (work)\n` +
        `  --name     display name (OpenVibe.Work)\n` +
        `  --domain   site (openvibe.work)\n` +
        `  --port     loopback port (4960)\n` +
        `  --tagline  one line (Find work, with an agent on your side.)\n` +
        `  --env      environment prefix, uppercase (WORK)\n` +
        `  --out      directory to write the new service into (must not exist, or be empty)\n`);
    process.exit(2);
}

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const eq = a.indexOf('=');
        if (eq !== -1) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
        const next = argv[i + 1];
        if (next == null || next.startsWith('--')) { out[a.slice(2)] = ''; continue; }
        out[a.slice(2)] = next;
        i++;
    }
    return out;
}

function replacements(args) {
    const id = String(args.id || '');
    const name = String(args.name || '');
    const domain = String(args.domain || '');
    const env = String(args.env || '');
    const port = String(args.port || '');
    const tagline = String(args.tagline || '').trim();

    if (!/^[a-z][a-z0-9-]{1,39}$/.test(id)) usage(`--id must be lowercase letters, digits and dashes (got ${JSON.stringify(id)})`);
    if (!name) usage('--name is required');
    if (!/^[a-z0-9][a-z0-9.-]{1,80}$/.test(domain)) usage(`--domain looks wrong (got ${JSON.stringify(domain)})`);
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) usage(`--port must be 1-65535 (got ${JSON.stringify(port)})`);
    if (!/^[A-Z][A-Z0-9_]{0,31}$/.test(env)) usage(`--env must be uppercase letters, digits and underscores (got ${JSON.stringify(env)})`);
    if (!tagline) usage('--tagline is required');
    if (!String(args.out || '')) usage('--out is required');

    return {
        values: { [T('ID')]: id, [T('NAME')]: name, [T('DOMAIN')]: domain, [T('PORT')]: port, [T('TAGLINE')]: tagline, [T('ENV')]: env },
        meta: { id, name, domain, port, env, tagline },
    };
}

const looksBinary = (buf) => buf.includes(0);

function copyTree(src, dest, values) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) continue;
        const from = path.join(src, entry.name);
        const to = path.join(dest, entry.name.replace(TOKEN_RE, (t) => values[t]));
        if (entry.isDirectory()) { copyTree(from, to, values); continue; }
        if (entry.isSymbolicLink()) continue;   // node_modules is the only symlink; anything else is environment
        const buf = fs.readFileSync(from);
        const out = looksBinary(buf) ? buf : Buffer.from(buf.toString('utf8').replace(TOKEN_RE, (t) => values[t]), 'utf8');
        fs.writeFileSync(to, out);
    }
}

function main(argv) {
    const args = parseArgs(argv);
    if (args.help != null) usage();
    const { values, meta } = replacements(args);

    const root = path.join(__dirname, '..');
    const out = path.resolve(process.cwd(), String(args.out));
    if (fs.existsSync(out) && fs.readdirSync(out).length) usage(`--out ${out} exists and is not empty`);
    if (out === root || root.startsWith(`${out}${path.sep}`) || out.startsWith(`${root}${path.sep}`)) {
        usage('--out must be outside the skeleton, and must not contain it');
    }

    copyTree(root, out, values);

    process.stdout.write(`Generated ${meta.name} in ${out}\n\n`
        + `  service id    ${meta.id}\n`
        + `  name          ${meta.name}\n`
        + `  domain        ${meta.domain}\n`
        + `  port          ${meta.port}\n`
        + `  tagline       ${meta.tagline}\n`
        + `  env prefix    ${meta.env}\n\n`
        + `Next steps:\n`
        + `  1. cd ${out}\n`
        + `  2. npm install\n`
        + `  3. npm test                     # every test/*.test.js on temp PGlite databases, with a mock Network\n`
        + `  4. npm run dev                  # http://localhost:${meta.port}, PGlite in data/pglite\n`
        + `  5. Register the service and its capabilities in OpenVibe.Contracts (CI: contracts-service: ${meta.id})\n`
        + `     and with OpenVibe.Services; write its tables in migrations/0001_initial.sql, its routes in\n`
        + `     server/http/api.js (capabilities in server/http/principal.js, budgets in server/http/caller-limits.js)\n`
        + `     and its pages in server/http/pages.js.\n`
        + `  6. Fill in STATUS.json, README.md and CHANGELOG.md, then deploy with the unit and vhost in deploy/.\n`);
}

main(process.argv.slice(2));
