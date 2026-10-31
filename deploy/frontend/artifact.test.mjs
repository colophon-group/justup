// Exact-commit packaging and smoke boundaries, with a temporary Git fixture and no provider access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepare, verifyArtifact } from '../../scripts/frontend-prepare.mjs';
import { smoke } from '../../scripts/frontend-smoke.mjs';
const root = new URL('../../', import.meta.url);

test('artifact snapshots committed bytes, ignores dirty files, has stable digests and detects deployed drift', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'justup-frontend-'));
  try {
    const repository = join(temporary, 'repo'); await mkdir(repository);
    const git = (...args) => execFileSync('git', args, { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
    await mkdir(join(repository, 'prototype')); await mkdir(join(repository, 'deploy/frontend'), { recursive: true });
    await writeFile(join(repository, 'prototype/index.html'), '<h1>Committed</h1>');
    for (const name of ['privacy.html', 'usage.html']) await writeFile(join(repository, 'prototype', name), '<h1>Policy</h1>');
    await writeFile(join(repository, 'deploy/frontend/worker.mjs'), await readFile(new URL('deploy/frontend/worker.mjs', root)));
    git('add', '.'); git('commit', '-qm', 'Fixture');
    const sha = git('rev-parse', 'HEAD');
    await writeFile(join(repository, 'prototype/index.html'), '<h1>Dirty</h1>');
    await writeFile(join(repository, 'prototype/.env'), 'never-publish');
    const first = join(temporary, 'first'); const second = join(temporary, 'second');
    const release = await prepare(sha, first, repository);
    assert.deepEqual(await prepare(sha, second, repository), release);
    assert.equal(await readFile(join(first, 'assets/index.html'), 'utf8'), '<h1>Committed</h1>');
    assert.equal(release.assets.length, 3);
    await assert.rejects(prepare(sha, first, repository), /must not exist/);
    await assert.rejects(prepare('HEAD', join(temporary, 'bad'), repository), /exact/);
    execFileSync(process.execPath, [new URL('scripts/frontend-configure.mjs', root).pathname, first, 'justup-preview-test', 'https://preview.justup.test', 'https://api.justup.test']);
    const config = JSON.parse(await readFile(join(first, 'wrangler.json'), 'utf8'));
    assert.equal(config.assets.run_worker_first, true);
    assert.equal(config.no_bundle, true); assert.equal(config.find_additional_modules, false);
    assert.equal(config.workers_dev, false); assert.equal(config.preview_urls, false);
    const version = { ...JSON.parse(config.vars.RELEASE_JSON), runtimeConfigSha256: config.vars.RUNTIME_CONFIG_SHA256 };
    const fetchFixture = async url => {
      const path = new URL(url).pathname;
      const headers = { 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };
      if (path === '/__preview/version') return new Response(JSON.stringify(version), { headers });
      if (path.startsWith('/api/v1/')) return new Response(JSON.stringify({ user: null, access: { kind: 'guest' } }), { headers });
      if (path === '/robots.txt') return new Response('User-agent: *\nDisallow: /', { headers });
      return new Response(await readFile(join(first, 'assets', path.slice(1))), { headers });
    };
    assert.equal((await smoke('https://preview.justup.test', first, fetchFixture)).result, 'passed');
    await verifyArtifact(first);
    await writeFile(join(first, 'assets/index.html'), 'drift');
    await assert.rejects(verifyArtifact(first), /bytes differ/);
    await assert.rejects(smoke('https://preview.justup.test', first, fetchFixture), /Wrong asset bytes/);
    // Committed secret-looking files fail closed instead of silently joining the public upload.
    git('add', 'prototype/.env'); git('commit', '-qm', 'Unsafe fixture');
    await assert.rejects(prepare(git('rev-parse', 'HEAD'), join(temporary, 'unsafe'), repository), /Refusing public asset/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
