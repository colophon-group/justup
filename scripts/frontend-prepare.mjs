// Snapshot committed frontend bytes. Read before preparing an exact-candidate preview artifact.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, access, readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function verifyArtifact(output) {
  const release = JSON.parse(await readFile(join(output, 'release.json'), 'utf8'));
  if (!/^[a-f0-9]{40}$/.test(release.sourceSha) || !/^[a-f0-9]{40}$/.test(release.treeSha)) throw new Error('Invalid source identity');
  const paths = [];
  async function walk(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await walk(join(directory, entry.name), `${name}/`);
      else if (entry.isFile()) paths.push(name);
      else throw new Error('Artifact contains a nonregular asset');
    }
  }
  await walk(join(output, 'assets'));
  paths.sort();
  const assets = [];
  for (const path of paths) {
    const bytes = await readFile(join(output, 'assets', path));
    assets.push({ path, sha256: digest(bytes), bytes: bytes.length });
  }
  if (JSON.stringify(assets) !== JSON.stringify(release.assets) || digest(JSON.stringify(assets)) !== release.assetsSha256) throw new Error('Artifact asset bytes differ from manifest');
  const workerSha256 = digest(await readFile(join(output, 'worker.mjs')));
  if (workerSha256 !== release.workerSha256 || digest(JSON.stringify({ assetsSha256: release.assetsSha256, workerSha256 })) !== release.artifactSha256) throw new Error('Artifact worker bytes differ from manifest');
  return release;
}
export async function prepare(source, output, cwd = process.cwd()) {
  if (!/^[a-f0-9]{40}$/.test(source)) throw new Error('Source must be an exact 40-character commit SHA');
  const git = (...args) => execFileSync('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  const sourceSha = git('rev-parse', '--verify', `${source}^{commit}`).toString().trim();
  const treeSha = git('rev-parse', `${sourceSha}^{tree}`).toString().trim();
  const out = resolve(output);
  try { await access(out); throw new Error('Output must not exist; retain previous artifacts separately'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const entries = git('ls-tree', '-rz', '--full-tree', sourceSha, '--', 'prototype/').toString().split('\0').filter(Boolean);
  const files = [];
  for (const entry of entries) {
    const match = /^(100644|100755) blob ([a-f0-9]+)\t(prototype\/.+)$/.exec(entry);
    if (!match) throw new Error('Assets must be regular committed files');
    const name = match[3].slice('prototype/'.length);
    // Asset directory is public. Fail closed on accidental secret/control files.
    if (name.split('/').some(part => part.startsWith('.') || part === '..') || /(^|\/)(?:_worker\.js|_redirects|_headers)$/.test(name) || /\.(?:env|pem|key|map)$/i.test(name)) throw new Error(`Refusing public asset: ${name}`);
    files.push({ name, bytes: git('cat-file', 'blob', match[2]) });
  }
  if (!files.some(file => file.name === 'index.html')) throw new Error('Missing frontend index');
  files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const assets = files.map(({ name, bytes }) => ({ path: name, sha256: digest(bytes), bytes: bytes.length }));
  const assetsSha256 = digest(JSON.stringify(assets));
  const worker = git('show', `${sourceSha}:deploy/frontend/worker.mjs`);
  const workerSha256 = digest(worker);
  const artifactSha256 = digest(JSON.stringify({ assetsSha256, workerSha256 }));
  const release = { sourceSha, treeSha, assetsSha256, workerSha256, artifactSha256, assets };
  await mkdir(join(out, 'assets'), { recursive: true });
  for (const { name, bytes } of files) {
    await mkdir(resolve(out, 'assets', name, '..'), { recursive: true });
    await writeFile(join(out, 'assets', name), bytes);
  }
  await writeFile(join(out, 'worker.mjs'), worker);
  await writeFile(join(out, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
  return release;
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv.length !== 4) throw new Error('Usage: node scripts/frontend-prepare.mjs <exact-commit> <new-output-directory>');
  console.log(JSON.stringify(await prepare(process.argv[2], process.argv[3]), null, 2));
}
