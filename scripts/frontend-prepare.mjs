// Build a committed source snapshot without operator credentials; use only in an unprivileged build job.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir, mkdtemp, rm, lstat, realpath } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, dirname, basename, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const CONFIG = /^(?:package(?:-lock)?\.json|tsconfig(?:\.[\w-]+)?\.json|vite\.config\.(?:ts|mts|js|mjs))$/;
function publicPath(name) {
  if (name.split('/').some(part => !part || part.startsWith('.')) || /(^|\/)(?:_worker\.js|_redirects|_headers|README(?:\.md)?)$/i.test(name) || /\.(?:env|pem|key|map|tsx?|mjs)$/i.test(name)) throw new Error(`Refusing public asset: ${name}`);
}
async function builtAssets(directory) {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Built assets root must be a regular directory');
  const assets = [];
  async function walk(path, prefix = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await walk(join(path, entry.name), name + '/');
      else if (entry.isFile()) {
        if (assets.length >= 200) throw new Error('Built asset count exceeds the smoke allowance');
        publicPath(name);
        const bytes = await readFile(join(path, entry.name));
        if (bytes.length > 25 * 1024 * 1024) throw new Error('Built asset exceeds the hosting file limit');
        assets.push({ path: name, sha256: digest(bytes), bytes: bytes.length });
      } else throw new Error('Artifact contains a nonregular asset');
    }
  }
  await walk(directory);
  assets.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (assets.find(asset => asset.path === 'index.html')?.bytes > 64 * 1024) throw new Error('Public template exceeds the rendering allowance');
  if (!assets.some(asset => asset.path === 'index.html')) throw new Error('Missing built frontend index');
  return assets;
}
export async function verifyArtifact(output) {
  const metadata = await lstat(output);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Artifact root must be a regular directory');
  const release = JSON.parse(await readFile(join(output, 'release.json'), 'utf8'));
  if (!/^[a-f0-9]{40}$/.test(release.sourceSha) || !/^[a-f0-9]{40}$/.test(release.treeSha)) throw new Error('Invalid source identity');
  const assets = await builtAssets(join(output, 'assets'));
  if (JSON.stringify(assets) !== JSON.stringify(release.assets) || digest(JSON.stringify(assets)) !== release.assetsSha256) throw new Error('Artifact asset bytes differ from manifest');
  const workerMetadata = await lstat(join(output, 'worker.mjs'));
  if (!workerMetadata.isFile() || workerMetadata.isSymbolicLink()) throw new Error('Retained Worker must be a regular file');
  const workerSha256 = digest(await readFile(join(output, 'worker.mjs')));
  if (workerSha256 !== release.workerSha256 || digest(JSON.stringify({ assetsSha256: release.assetsSha256, workerSha256 })) !== release.artifactSha256) throw new Error('Artifact worker bytes differ from manifest');
  return release;
}
function buildEnvironment(scratch, emptyNpmConfig, emptyGlobalConfig) {
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TMPDIR', 'TMP', 'TEMP', 'LANG'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  return { ...env, CI: 'true', npm_config_userconfig: emptyNpmConfig, npm_config_globalconfig: emptyGlobalConfig, npm_config_cache: join(scratch, 'npm-cache'), npm_config_registry: 'https://registry.npmjs.org', npm_config_audit: 'false', npm_config_fund: 'false' };
}
export async function prepare(source, output, cwd = process.cwd()) {
  if (!/^[a-f0-9]{40}$/.test(source)) throw new Error('Source must be an exact 40-character commit SHA');
  const git = (...args) => execFileSync('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  const sourceSha = git('rev-parse', '--verify', `${source}^{commit}`).toString().trim();
  const treeSha = git('rev-parse', `${sourceSha}^{tree}`).toString().trim();
  const out = resolve(output);
  // Resolve an existing output parent so a symlink cannot write back into the checkout.
  const physicalOutput = join(await realpath(dirname(out)), basename(out));
  const inside = relative(await realpath(cwd), physicalOutput);
  if (!inside || (inside !== '..' && !inside.startsWith('..' + sep) && !isAbsolute(inside))) throw new Error('Artifact output must be outside the source checkout');
  try { await lstat(out); throw new Error('Output must not exist; retain previous artifacts separately'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const entries = git('ls-tree', '-rz', '--full-tree', sourceSha).toString().split('\0').filter(Boolean);
  const inputs = [];
  if (entries.some(entry => entry.slice(entry.indexOf('\t') + 1).startsWith('prototype/'))) throw new Error('Legacy runtime remains in the candidate tree');
  const workerEntry = entries.find(entry => entry.endsWith('\tdeploy/frontend/worker.mjs'));
  if (!workerEntry || !/^(100644|100755) blob /.test(workerEntry)) throw new Error('Worker must be a regular committed file');
  for (const entry of entries) {
    const split = entry.indexOf('\t'), name = entry.slice(split + 1);
    if (!(name.startsWith('web/') || name === 'deploy/frontend/worker.mjs' || CONFIG.test(name))) continue;
    const match = /^(100644|100755) blob ([a-f0-9]+)$/.exec(entry.slice(0, split));
    if (!match) throw new Error('Build inputs must be regular committed files');
    if ((name.startsWith('web/dist/') || name.startsWith('web/worker-dist/')) || name.split('/').some(part => part.startsWith('.')) || /\.(?:env|pem|key)$/i.test(name)) throw new Error(`Refusing build input: ${name}`);
    if (name.startsWith('web/public/')) publicPath(name.slice('web/public/'.length));
    inputs.push({ name, bytes: git('cat-file', 'blob', match[2]) });
  }
  for (const name of ['package.json', 'package-lock.json', 'web/index.html']) if (!inputs.some(file => file.name === name)) throw new Error(`Missing committed build input: ${name}`);
  const lock = JSON.parse(inputs.find(file => file.name === 'package-lock.json').bytes.toString());
  for (const value of Object.values(lock.packages || {})) if (value.resolved) {
    const url = new URL(value.resolved);
    if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.username || url.password) throw new Error('Build dependencies must resolve through the reviewed public npm registry');
  }
  const scratch = await mkdtemp(join(tmpdir(), 'justup-source-build-'));
  try {
    const snapshot = join(scratch, 'source'); await mkdir(snapshot);
    for (const { name, bytes } of inputs) { await mkdir(resolve(snapshot, name, '..'), { recursive: true }); await writeFile(join(snapshot, name), bytes); }
    const emptyNpmConfig = join(scratch, 'user.npmrc'), emptyGlobalConfig = join(scratch, 'global.npmrc');
    await writeFile(emptyNpmConfig, ''); await writeFile(emptyGlobalConfig, '');
    const options = { cwd: snapshot, env: buildEnvironment(scratch, emptyNpmConfig, emptyGlobalConfig), maxBuffer: 8 * 1024 * 1024, timeout: 180000 };
    // Candidate code runs here. The caller must use a credential-free, unprivileged builder;
    // a temporary directory and environment filtering are not an operating-system sandbox.
    execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], options);
    execFileSync('npm', ['run', 'build'], options);
    const built = join(snapshot, 'web/dist'), assets = await builtAssets(built);
    const assetsSha256 = digest(JSON.stringify(assets));
    const privateOutput = join(snapshot, 'web/worker-dist');
    const privateFiles = await readdir(privateOutput);
    if (privateFiles.length !== 1 || privateFiles[0] !== 'worker.mjs') throw new Error('Worker output must contain exactly one self-contained bundle');
    const workerMetadata = await lstat(join(privateOutput, 'worker.mjs'));
    if (!workerMetadata.isFile() || workerMetadata.isSymbolicLink()) throw new Error('Built Worker must be a regular file');
    const worker = await readFile(join(privateOutput, 'worker.mjs')), workerSha256 = digest(worker);
    if (worker.length > 3 * 1024 * 1024 || /(?:^|\n)import\s/m.test(worker.toString())) throw new Error('Worker must be a bounded self-contained bundle');
    const artifactSha256 = digest(JSON.stringify({ assetsSha256, workerSha256 }));
    const release = { sourceSha, treeSha, assetsSha256, workerSha256, artifactSha256, assets };
    await mkdir(join(out, 'assets'), { recursive: true });
    for (const asset of assets) { await mkdir(resolve(out, 'assets', asset.path, '..'), { recursive: true }); await writeFile(join(out, 'assets', asset.path), await readFile(join(built, asset.path))); }
    await writeFile(join(out, 'worker.mjs'), worker);
    await writeFile(join(out, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
    return release;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv.length !== 4) throw new Error('Usage: node scripts/frontend-prepare.mjs <exact-commit> <new-output-directory>');
  console.log(JSON.stringify(await prepare(process.argv[2], process.argv[3]), null, 2));
}
