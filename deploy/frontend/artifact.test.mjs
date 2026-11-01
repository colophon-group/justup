// Exact-source builds and smoke boundaries use a dependency-free Git fixture, never provider access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepare, verifyArtifact, digest } from '../../scripts/frontend-prepare.mjs';
import { smoke } from '../../scripts/frontend-smoke.mjs';
const root = new URL('../../', import.meta.url);

async function fixture(temporary) {
  const repository = join(temporary, 'repo'); await mkdir(repository);
  const git = (...args) => execFileSync('git', args, { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  await mkdir(join(repository, 'web/public'), { recursive: true }); await mkdir(join(repository, 'deploy/frontend'), { recursive: true });
  await writeFile(join(repository, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', private: true, scripts: { build: 'node web/build-fixture.mjs' } }));
  await writeFile(join(repository, 'package-lock.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'fixture', version: '1.0.0' } } }));
  await writeFile(join(repository, 'web/index.html'), '<h1>Committed</h1>');
  for (const name of ['privacy.html', 'usage.html']) await writeFile(join(repository, 'web/public', name), '<h1>Policy</h1>');
  await writeFile(join(repository, 'web/build-fixture.mjs'), `
    import {mkdirSync,copyFileSync,writeFileSync} from 'node:fs';
    mkdirSync('web/dist/assets',{recursive:true});
    copyFileSync('web/index.html','web/dist/index.html');
    for(const name of ['privacy.html','usage.html']) copyFileSync('web/public/'+name,'web/dist/'+name);
    writeFileSync('web/dist/assets/app.fixture.js',JSON.stringify({privateBuildValue:process.env.VITE_PRIVATE_CANARY??null}));
  `);
  await writeFile(join(repository, 'deploy/frontend/worker.mjs'), await readFile(new URL('deploy/frontend/worker.mjs', root)));
  git('add', '.'); git('commit', '-qm', 'Fixture');
  return { repository, git, sha: git('rev-parse', 'HEAD') };
}

test('artifact builds committed source, ignores dirty input and filters operator environment before retaining exact bytes', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'justup-frontend-'));
  const previousCanary = process.env.VITE_PRIVATE_CANARY;
  try {
    const { repository, git, sha } = await fixture(temporary);
    await writeFile(join(repository, 'web/index.html'), '<h1>Dirty</h1>');
    await writeFile(join(repository, 'web/.env'), 'never-publish');
    process.env.VITE_PRIVATE_CANARY = 'operator-environment-must-not-build-into-assets';
    const first = join(temporary, 'first'), second = join(temporary, 'second');
    const release = await prepare(sha, first, repository);
    assert.deepEqual(await prepare(sha, second, repository), release);
    assert.equal(await readFile(join(first, 'assets/index.html'), 'utf8'), '<h1>Committed</h1>');
    assert.deepEqual(JSON.parse(await readFile(join(first, 'assets/assets/app.fixture.js'), 'utf8')), { privateBuildValue: null });
    assert.equal(release.assets.length, 4);
    await assert.rejects(prepare(sha, first, repository), /must not exist/);
    await assert.rejects(prepare('HEAD', join(temporary, 'bad'), repository), /exact/);
    await assert.rejects(prepare(sha, join(repository, 'artifact'), repository), /outside the source/);
    await assert.rejects(prepare(sha, join(repository, '..artifact'), repository), /outside the source/);
    const sourceAlias = join(temporary, 'source-link'); await symlink(repository, sourceAlias);
    await assert.rejects(prepare(sha, join(sourceAlias, 'artifact'), repository), /outside the source/);
    execFileSync(process.execPath, [new URL('scripts/frontend-configure.mjs', root).pathname, first, 'justup-preview-test', 'https://preview.justup.test', 'https://api.justup.test']);
    const config = JSON.parse(await readFile(join(first, 'wrangler.json'), 'utf8'));
    assert.equal(config.assets.run_worker_first, true); assert.equal(config.compatibility_date, '2026-10-30');
    assert.equal(config.no_bundle, true); assert.equal(config.find_additional_modules, false);
    assert.equal(config.workers_dev, false); assert.equal(config.preview_urls, false);
    assert.equal(config.vars.DEPLOYMENT_MODE, 'preview');
    const version = { ...JSON.parse(config.vars.RELEASE_JSON), runtimeConfigSha256: config.vars.RUNTIME_CONFIG_SHA256, deploymentMode: config.vars.DEPLOYMENT_MODE };
    const fetchFixture = async url => {
      const path = new URL(url).pathname;
      const headers = { 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };
      if (path === '/__release/version') return new Response(JSON.stringify(version), { headers });
      if (path.startsWith('/api/v1/')) return new Response(JSON.stringify({ user: null, access: { kind: 'guest' } }), { headers });
      if (path === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n', { headers });
      return new Response(await readFile(join(first, 'assets', path === '/' ? 'index.html' : path.slice(1))), { headers });
    };
    assert.equal((await smoke('https://preview.justup.test', first, fetchFixture)).result, 'passed');
    await verifyArtifact(first);
    const production = join(temporary, 'production');
    assert.deepEqual(await prepare(sha, production, repository), release);
    execFileSync(process.execPath, [new URL('scripts/frontend-configure.mjs', root).pathname, production, 'justup-product-test', 'https://justup.test', 'https://api.justup.test', 'production']);
    const productionConfig = JSON.parse(await readFile(join(production, 'wrangler.json'), 'utf8'));
    assert.equal(productionConfig.vars.DEPLOYMENT_MODE, 'production');
    assert.notEqual(productionConfig.vars.RUNTIME_CONFIG_SHA256, config.vars.RUNTIME_CONFIG_SHA256);
    assert.equal(productionConfig.vars.RUNTIME_CONFIG_SHA256, digest(JSON.stringify({ publicOrigin: 'https://justup.test', apiOrigin: 'https://api.justup.test', apiPrefix: '/api/v1', deploymentMode: 'production' })));
    assert.throws(() => execFileSync(process.execPath, [new URL('scripts/frontend-configure.mjs', root).pathname, production, 'justup-product-test', 'https://justup.test', 'https://api.justup.test', 'prod'], { stdio: 'pipe' }), /Command failed/);
    const productionFetch = async url => {
      const path = new URL(url).pathname;
      if (path === '/__release/version') return new Response(JSON.stringify({ ...JSON.parse(productionConfig.vars.RELEASE_JSON), runtimeConfigSha256: productionConfig.vars.RUNTIME_CONFIG_SHA256, deploymentMode: 'production' }), { headers: { 'X-Robots-Tag': 'noindex' } });
      if (path === '/robots.txt') return new Response('User-agent: *\nDisallow: /api/\nDisallow: /__release/\n');
      return fetchFixture(url);
    };
    assert.equal((await smoke('https://justup.test', production, productionFetch)).deploymentMode, 'production');
    const noMode = { ...config, vars: { ...config.vars } }; delete noMode.vars.DEPLOYMENT_MODE;
    await writeFile(join(first, 'wrangler.json'), JSON.stringify(noMode));
    await assert.rejects(smoke('https://preview.justup.test', first, async () => { throw new Error('Must not fetch'); }), /Invalid deployment mode/);
    const changedConfig = { ...config, vars: { ...config.vars, DEPLOYMENT_MODE: 'production' } };
    await writeFile(join(first, 'wrangler.json'), JSON.stringify(changedConfig));
    await assert.rejects(smoke('https://preview.justup.test', first, async () => { throw new Error('Must not fetch'); }), /Runtime configuration identity differs/);
    await writeFile(join(first, 'wrangler.json'), JSON.stringify(config));
    await assert.rejects(smoke('https://preview.justup.test', first, async url => new URL(url).pathname === '/__release/version' ? new Response(JSON.stringify({ ...version, deploymentMode: 'production' }), { headers: { 'X-Robots-Tag': 'noindex' } }) : fetchFixture(url)), /Wrong deployed environment/);
    await writeFile(join(first, 'assets/index.html'), 'drift');
    await assert.rejects(verifyArtifact(first), /bytes differ/);
    await assert.rejects(smoke('https://preview.justup.test', first, fetchFixture), /Wrong root index bytes/);
    git('add', 'web/.env'); git('commit', '-qm', 'Unsafe fixture');
    await assert.rejects(prepare(git('rev-parse', 'HEAD'), join(temporary, 'unsafe'), repository), /Refusing build input/);
  } finally {
    if (previousCanary === undefined) delete process.env.VITE_PRIVATE_CANARY; else process.env.VITE_PRIVATE_CANARY = previousCanary;
    await rm(temporary, { recursive: true, force: true });
  }
});

test('legacy runtime and symlink build inputs cannot be packaged', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'justup-frontend-rejection-'));
  try {
    const { repository, git } = await fixture(temporary);
    await symlink('index.html', join(repository, 'web/link.html'));
    git('add', '.'); git('commit', '-qm', 'Symlink fixture');
    await assert.rejects(prepare(git('rev-parse', 'HEAD'), join(temporary, 'symlink'), repository), /regular committed/);
    git('rm', 'web/link.html'); await mkdir(join(repository, 'prototype')); await writeFile(join(repository, 'prototype/index.html'), 'legacy');
    git('add', '.'); git('commit', '-qm', 'Legacy fixture');
    await assert.rejects(prepare(git('rev-parse', 'HEAD'), join(temporary, 'legacy'), repository), /Legacy runtime remains/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});


test('build output and retained asset roots cannot be symlink directories', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'justup-frontend-root-link-'));
  try {
    const { repository, git, sha } = await fixture(temporary);
    const output = join(temporary, 'retained');
    const release = await prepare(sha, output, repository);
    const linked = join(temporary, 'linked'); await mkdir(linked);
    await symlink(join(output, 'assets'), join(linked, 'assets'));
    await writeFile(join(linked, 'release.json'), JSON.stringify(release));
    await writeFile(join(linked, 'worker.mjs'), await readFile(join(output, 'worker.mjs')));
    await assert.rejects(verifyArtifact(linked), /root must be a regular directory/);
    await writeFile(join(repository, 'web/build-fixture.mjs'), "import { symlinkSync } from 'node:fs'; symlinkSync('public', 'web/dist', 'dir');");
    git('add', '.'); git('commit', '-qm', 'Build output link fixture');
    await assert.rejects(prepare(git('rev-parse', 'HEAD'), join(temporary, 'bad-build'), repository), /root must be a regular directory/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
