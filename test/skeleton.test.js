'use strict';
/**
 * The skeleton's own test: generating a service from it must leave no placeholder behind, in file names or in file
 * contents, and the names the generator derives (the package, the config, the deploy files, the environment) must be
 * the ones a service needs. It runs scripts/new-service.js into a temp directory with fixed sample values, inspects
 * the result, and leaves nothing behind.
 *
 * The placeholder strings are built from parts: this file is copied into every generated service, and a literal
 * placeholder here would be rewritten on the way in.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { check, done } = require('./helpers/boot');

const TOKEN_NAMES = ['ID', 'NAME', 'DOMAIN', 'PORT', 'TAGLINE', 'ENV'];
const TOKEN_RE = new RegExp(`__(${TOKEN_NAMES.join('|')})__`);
const token = (name) => `__${name}__`;

const ROOT = path.join(__dirname, '..');
const SAMPLE = { id: 'sample', name: 'OpenVibe.Sample', domain: 'openvibe.sample', port: '4999', tagline: 'A sample service.', env: 'SAMPLE' };

const created = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); created.push(d); return d; };

function runGenerator(out) {
    const args = [
        path.join(ROOT, 'scripts', 'new-service.js'),
        '--id', SAMPLE.id, '--name', SAMPLE.name, '--domain', SAMPLE.domain,
        '--port', SAMPLE.port, '--tagline', SAMPLE.tagline, '--env', SAMPLE.env, '--out', out,
    ];
    // stderr is captured, not shown: the generator's refusals are checked below, and a test file's output stays clean.
    return execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out); else out.push(p);
    }
    return out;
}
const rel = (p, dir) => path.relative(dir, p).split(path.sep).join('/');
const text = (p) => fs.readFileSync(p, 'utf8');

(async () => {
    const base = tmpDir('ov-new-service-');
    const dir = path.join(base, 'openvibe-sample');
    const printed = runGenerator(dir);

    await check('the generator writes a service and prints the next steps', () => {
        assert.ok(fs.existsSync(dir), 'no output directory');
        assert.ok(printed.includes(`Generated ${SAMPLE.name} in ${dir}`), printed.slice(0, 200));
        assert.ok(printed.includes('npm install') && printed.includes('npm test'), 'the next steps name the first commands');
        assert.ok(!printed.includes(token('ID')) && !printed.includes(token('NAME')), 'the output still carries a placeholder');
    });

    await check('no placeholder is left in any file name or file content', () => {
        const files = walk(dir);
        assert.ok(files.length > 30, `only ${files.length} files were generated`);
        const badNames = files.map((f) => rel(f, dir)).filter((r) => TOKEN_RE.test(r));
        assert.deepStrictEqual(badNames, [], 'a file name still carries a placeholder');
        const badContents = files.filter((f) => TOKEN_RE.test(text(f))).map((f) => rel(f, dir));
        assert.deepStrictEqual(badContents, [], 'a file still carries a placeholder');
    });

    await check('the package, the config and the environment are the generated service\'s', () => {
        const pkg = JSON.parse(text(path.join(dir, 'package.json')));
        assert.strictEqual(pkg.name, `openvibe-${SAMPLE.id}`);
        assert.strictEqual(pkg.version, '0.1.0');
        // A generated service's own description is the name and its tagline; the skeleton's is the placeholders.
        assert.ok(pkg.description.startsWith(SAMPLE.name), pkg.description);
        assert.ok(pkg.scripts['test:pg'].includes(`${SAMPLE.env}_TEST_STORE=pg`), pkg.scripts['test:pg']);

        const config = text(path.join(dir, 'server', 'config.js'));
        assert.ok(config.includes(`service: '${SAMPLE.id}'`), 'config.service');
        assert.ok(config.includes(`env.PORT, ${SAMPLE.port}`), 'the default port');
        assert.ok(config.includes(`'https://${SAMPLE.domain}'`), 'the production base URL');
        assert.ok(config.includes(`'ov:${SAMPLE.id}:'`), 'the Valkey prefix');
        assert.ok(config.includes(`${SAMPLE.env}_LIMITS_MINUTE`), 'the limits env prefix');
        assert.ok(config.includes(`${SAMPLE.env}_PGLITE_DIR`), 'the PGlite env prefix');

        const env = text(path.join(dir, '.env.example'));
        for (const line of [`PORT=${SAMPLE.port}`, `BASE_URL=https://${SAMPLE.domain}`, `OV_OAUTH_CLIENT_ID=${SAMPLE.id}`, `VALKEY_PREFIX=ov:${SAMPLE.id}:`]) {
            assert.ok(env.includes(line), `.env.example is missing ${line}`);
        }

        const auth = text(path.join(dir, 'server', 'auth', 'sso.js'));
        assert.ok(auth.includes(`'${SAMPLE.id}_at'`) && auth.includes(`'${SAMPLE.id}_rt'`) && auth.includes(`'${SAMPLE.id}_oauth'`), 'the session cookies');

        const status = JSON.parse(text(path.join(dir, 'STATUS.json')));
        assert.strictEqual(status.domain, SAMPLE.domain);
        assert.ok(text(path.join(dir, 'README.md')).includes(SAMPLE.name), 'the README names the service');
    });

    await check('the deploy files carry the domain, the id and the port', () => {
        const nginx = text(path.join(dir, 'deploy', 'nginx', `${SAMPLE.domain}.conf`));
        assert.ok(nginx.includes(`server_name ${SAMPLE.domain} www.${SAMPLE.domain};`), 'the vhost name');
        assert.ok(nginx.includes(`proxy_pass http://127.0.0.1:${SAMPLE.port};`), 'the upstream port');
        assert.ok(nginx.includes(`zone=${SAMPLE.id}_api`), 'the api limit zone');
        assert.ok(!fs.existsSync(path.join(dir, 'deploy', 'nginx', `${token('DOMAIN')}.conf`)), 'the template name is still there');

        const unit = text(path.join(dir, 'deploy', 'systemd', `openvibe-${SAMPLE.id}.service`));
        assert.ok(unit.includes(`Description=${SAMPLE.name}`), 'the unit description');
        assert.ok(unit.includes(`Environment=PORT=${SAMPLE.port}`), 'the unit port');
        assert.ok(unit.includes(`/etc/openvibe/${SAMPLE.id}.env`), 'the environment file');

        assert.ok(fs.existsSync(path.join(dir, 'migrations', '0001_initial.sql')), 'the initial migration');
        assert.ok(fs.existsSync(path.join(dir, 'public', 'css', 'app.css')), 'the stylesheet');
    });

    await check('the copy skips node_modules and .git, and the skeleton\'s own tools travel with it', () => {
        assert.ok(!fs.existsSync(path.join(dir, 'node_modules')), 'node_modules was copied');
        assert.ok(!fs.existsSync(path.join(dir, '.git')), '.git was copied');
        assert.ok(fs.existsSync(path.join(dir, 'scripts', 'new-service.js')), 'the generator is in the generated tree');
        assert.ok(fs.existsSync(path.join(dir, 'test', 'run.js')), 'the test runner is in the generated tree');
    });

    await check('generating refuses to overwrite a directory that has something in it', () => {
        let failed = null;
        try { runGenerator(dir); } catch (err) { failed = err; }
        assert.ok(failed, 'a second run into the same directory must fail');
        assert.match(String((failed && failed.stderr) || ''), /not empty/);
    });

    for (const d of created) fs.rmSync(d, { recursive: true, force: true });
    done();
})().catch((err) => { console.error(err); process.exit(1); });
