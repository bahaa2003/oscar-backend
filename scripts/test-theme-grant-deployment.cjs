'use strict';

// Real local git deployments + PM2, scoped to an isolated MongoDB and PM2_HOME.
// The caller supplies an already-installed PM2 CLI in OSCAR_TEST_PM2_CLI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const project = path.resolve(__dirname, '..');
const pm2Cli = process.env.OSCAR_TEST_PM2_CLI;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oscar-theme-grant-audit-'));
const remote = path.join(root, 'remote.git');
const source = path.join(root, 'source');
const deployed = path.join(root, 'deployed');
const previous = path.join(root, 'previous-release');
const pm2Home = path.join(root, 'pm2-home');
const appName = `oscar-grant-test-${process.pid}`;
let mongo, childEnv, pm2Started = false;
const run = (file, args, cwd, env = process.env) => execFileSync(file, args, {
    cwd, env, windowsHide: true, encoding: 'utf8', timeout: 35_000, stdio: ['ignore', 'pipe', 'pipe'],
});
const git = (cwd, ...args) => run('git', args, cwd);
const pm2 = (...args) => run(process.execPath, [pm2Cli, ...args], root, childEnv);
const linkDependencies = (target) => fs.symlinkSync(path.join(project, 'node_modules'), path.join(target, 'node_modules'), 'junction');
const freePort = async () => {
    const server = net.createServer();
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return port;
};
const waitForHealth = async (origin) => {
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
        try { if ((await fetch(`${origin}/health`, { signal: AbortSignal.timeout(500) })).ok) return; } catch (_) { /* starting */ }
        await sleep(150);
    }
    throw new Error('Isolated backend did not become healthy.');
};
const getPm2Pid = () => {
    const rows = JSON.parse(pm2('jlist'));
    const app = rows.find((entry) => entry.name === appName);
    assert(app && app.pid > 0 && app.pm2_env?.status === 'online', 'The isolated PM2 app must be online.');
    return app.pid;
};

async function main() {
    assert(pm2Cli && fs.existsSync(pm2Cli), 'Set OSCAR_TEST_PM2_CLI to an installed PM2 CLI file.');
    assert(fs.existsSync(path.join(project, 'node_modules')), 'Backend dependencies must be installed.');
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    const mongoUri = mongo.getUri('isolated_grant_deploy');
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    childEnv = { ...process.env, MONGO_URI: mongoUri, MONGO_TEST_URI: mongoUri, PORT: String(port),
        NODE_ENV: 'test', JWT_SECRET: 'isolated-grant-deploy-secret', BCRYPT_ROUNDS: '1',
        WHATSAPP_ENABLED: 'false', PM2_HOME: pm2Home };
    delete childEnv.THEME_GRANT_OWNER_ID;
    Object.assign(process.env, { MONGO_URI: mongoUri, MONGO_TEST_URI: mongoUri, NODE_ENV: 'test',
        JWT_SECRET: childEnv.JWT_SECRET, BCRYPT_ROUNDS: '1', WHATSAPP_ENABLED: 'false' });
    delete process.env.THEME_GRANT_OWNER_ID;
    const helpers = require('../src/tests/testHelpers');
    const Grant = require('../src/modules/theme/theme.grant.model');
    const { ThemeSubscription, ThemePayment } = require('../src/modules/theme/subscription.model');
    const theme = require('../src/modules/theme/theme.service');
    const { preset } = require('../src/modules/theme/theme.validation');
    await helpers.connectTestDB();
    const owner = await helpers.createAdmin();
    const start = new Date(Date.now() - 60_000);
    const end = new Date(Date.now() + 30 * 86_400_000);
    const grant = await Grant.create({ scopeKey: 'main', planId: 'THEME_ULTRA', status: 'ACTIVE',
        grantedToUserId: owner._id, grantedByUserId: owner._id, reason: 'isolated deployment test', startsAt: start, expiresAt: end });
    const before = await Grant.findById(grant._id).lean();
    const token = require('jsonwebtoken').sign({ id: owner._id.toString(), role: owner.role }, childEnv.JWT_SECRET);
    const headers = { Authorization: `Bearer ${token}` };
    const assertPersisted = async (label) => {
        assert.deepEqual(await Grant.findById(grant._id).lean(), before, 'Deployment must not update the grant.');
        assert.equal(await Grant.countDocuments({}), 1, 'Restart must not create grants.');
        assert.equal(await ThemeSubscription.countDocuments({}), 0);
        assert.equal(await ThemePayment.countDocuments({}), 0);
        const current = await theme.currentEntitlement();
        assert.equal(current.planId, 'THEME_ULTRA');
        assert.equal(current.expiresAt.getTime(), end.getTime());
        const response = await fetch(`${origin}/api/admin/theme/entitlement`, { headers });
        assert.equal(response.status, 200);
        const { data } = await response.json();
        assert.equal(data.eligibility.plan, 'THEME_ULTRA');
        assert.equal(data.eligibility.subscription.status, 'ACTIVE');
        assert.equal(data.eligibility.subscription.startsAt, start.toISOString());
        assert.equal(data.eligibility.subscription.expiresAt, end.toISOString());
        console.log(`PASS ${label}`);
    };

    fs.mkdirSync(source);
    fs.cpSync(path.join(project, 'src'), path.join(source, 'src'), { recursive: true });
    fs.copyFileSync(path.join(project, 'package.json'), path.join(source, 'package.json'));
    fs.writeFileSync(path.join(source, 'RELEASE_MARKER.txt'), 'isolated release 1\n');
    git(root, 'init', '--bare', remote);
    git(source, 'init', '-b', 'main');
    git(source, 'add', 'src', 'package.json', 'RELEASE_MARKER.txt');
    git(source, '-c', 'user.name=OSCAR Test', '-c', 'user.email=oscar-test@example.invalid', 'commit', '-m', 'isolated release 1');
    git(source, 'remote', 'add', 'origin', remote);
    git(source, 'push', '-u', 'origin', 'main');
    git(root, 'clone', '--branch', 'main', remote, deployed);
    linkDependencies(deployed);
    assert.equal((await theme.currentEntitlement()).planId, 'THEME_ULTRA');
    console.log('PASS original grant exists before deployment');

    pm2('start', path.join(deployed, 'src/server.js'), '--name', appName, '--cwd', deployed, '--interpreter', process.execPath);
    pm2Started = true;
    await waitForHealth(origin);
    let pid = getPm2Pid();
    await assertPersisted('initial deployment reads the existing grant');
    for (let attempt = 0; attempt < 2; attempt++) {
        pm2('restart', appName, '--update-env');
        await waitForHealth(origin);
        const nextPid = getPm2Pid();
        assert.notEqual(nextPid, pid, 'PM2 restart must start a new Node process.');
        pid = nextPid;
        await assertPersisted(`real PM2 restart ${attempt + 1}`);
    }

    fs.writeFileSync(path.join(source, 'RELEASE_MARKER.txt'), 'isolated release 2\n');
    git(source, 'add', 'RELEASE_MARKER.txt');
    git(source, '-c', 'user.name=OSCAR Test', '-c', 'user.email=oscar-test@example.invalid', 'commit', '-m', 'isolated release 2');
    git(source, 'push', 'origin', 'main');
    git(deployed, 'pull', '--ff-only');
    assert.equal(fs.readFileSync(path.join(deployed, 'RELEASE_MARKER.txt'), 'utf8').trim(), 'isolated release 2');
    pm2('restart', appName, '--update-env');
    await waitForHealth(origin);
    assert.notEqual(getPm2Pid(), pid);
    await assertPersisted('git pull and PM2 restart');

    pm2('stop', appName);
    fs.renameSync(deployed, previous);
    git(root, 'clone', '--branch', 'main', remote, deployed);
    linkDependencies(deployed);
    assert.equal(fs.existsSync(path.join(deployed, '.env')), false);
    pm2('restart', appName, '--update-env');
    await waitForHealth(origin);
    await assertPersisted('replace the release directory and restart without an activation script or owner env variable');

    const configuration = preset('gold');
    configuration.brand.sidebarTemplate = 'royal';
    const published = await fetch(`${origin}/api/admin/theme/publish`, { method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(configuration) });
    assert.equal(published.status, 200, await published.text());
    const sharp = require('sharp');
    const bytes = await sharp({ create: { width: 128, height: 128, channels: 3, background: '#234567' } }).png().toBuffer();
    const form = new FormData(); form.append('image', new Blob([bytes], { type: 'image/png' }), 'isolated-grant.png');
    const uploaded = await fetch(`${origin}/api/admin/theme/media/upload`, { method: 'POST', headers, body: form });
    assert.equal(uploaded.status, 200, await uploaded.text());
    await assertPersisted('ULTRA publish and actual image upload still work after replacement');
    console.log('PASS no payment, subscription, grant renewal, production database or production PM2 process was used');
}

main().catch((error) => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
    if (childEnv && pm2Cli && fs.existsSync(pm2Cli)) {
        if (pm2Started) { try { pm2('delete', appName); } catch (error) { console.error('Failed to delete isolated PM2 app:', error.message); process.exitCode = 1; } }
        try { pm2('kill'); } catch (error) { console.error('Failed to stop isolated PM2 daemon:', error.message); process.exitCode = 1; }
    }
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
    // Remove only this test's known junctions and its fresh temporary directory.
    for (const release of [deployed, previous]) {
        const dependencyLink = path.join(release, 'node_modules');
        if (fs.existsSync(dependencyLink) && fs.lstatSync(dependencyLink).isSymbolicLink()) fs.unlinkSync(dependencyLink);
    }
    if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('oscar-theme-grant-audit-')) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
