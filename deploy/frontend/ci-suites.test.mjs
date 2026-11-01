// Test backend suite availability without pretending an absent backend has passed its contracts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { deploymentTests } from '../../scripts/test-deployment.mjs';
import { serverTests } from '../../scripts/test-server.mjs';
import { webTests } from '../../scripts/test-web.mjs';

test('server absence is explicit, while a present server without tests fails closed and nested tests are discovered', () => {
  const root = mkdtempSync(join(tmpdir(), 'justup-suite-'));
  try {
    assert.equal(serverTests(root), null);
    mkdirSync(join(root, 'server'));
    writeFileSync(join(root, 'server/auth.mjs'), '// fixture');
    assert.throws(() => serverTests(root), /without registered/);
    mkdirSync(join(root, 'server/nested'));
    writeFileSync(join(root, 'server/auth.test.mjs'), '// fixture');
    writeFileSync(join(root, 'server/nested/api.test.mjs'), '// fixture');
    assert.deepEqual(serverTests(root), [join(root, 'server/auth.test.mjs'), join(root, 'server/nested/api.test.mjs')]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Python importer cannot exist without behavioral tests and real test failures propagate', () => {
  const root = mkdtempSync(join(tmpdir(), 'justup-python-suite-'));
  const runner = new URL('../../scripts/test-python.py', import.meta.url).pathname;
  const run = () => spawnSync('python3', ['-B', runner], { cwd: root, encoding: 'utf8' });
  try {
    mkdirSync(join(root, 'scripts'));
    assert.match(run().stdout, /unavailable/);
    writeFileSync(join(root, 'scripts/import-jobs.py'), '# fixture');
    const missing = run();
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Importer implementation exists without test_\*\.py behavioral contracts/);
    writeFileSync(join(root, 'scripts/test_other.py'), 'import unittest\nclass Other(unittest.TestCase):\n def test_fixture(self): self.assertTrue(True)\n');
    const missingImporter = run();
    assert.notEqual(missingImporter.status, 0);
    assert.match(missingImporter.stderr, /Job importer requires scripts\/test_import_jobs\.py/);
    writeFileSync(join(root, 'scripts/test_import_jobs.py'), 'import unittest\nclass Importer(unittest.TestCase):\n def test_fixture(self): self.assertTrue(False)\n');
    const failing = run();
    assert.notEqual(failing.status, 0);
    assert.match(failing.stderr, /FAILED \(failures=1\)/);
    writeFileSync(join(root, 'scripts/test_import_jobs.py'), 'import unittest\nclass Importer(unittest.TestCase):\n def test_fixture(self): self.assertTrue(True)\n');
    const passing = run();
    assert.equal(passing.status, 0);
    assert.match(passing.stdout, /scripts\/test_import_jobs\.py/);
    assert.match(passing.stderr, /Ran 2 tests/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('backend preview scripts need their own contracts instead of passing on frontend tests alone', () => {
  const root = mkdtempSync(join(tmpdir(), 'justup-preview-suite-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'deploy/frontend'), { recursive: true });
    writeFileSync(join(root, 'deploy/frontend/edge.test.mjs'), '// fixture');
    assert.equal(deploymentTests(root).length, 1);
    writeFileSync(join(root, 'scripts/preview-install.sh'), '# fixture');
    assert.throws(() => deploymentTests(root), /without registered/);
    writeFileSync(join(root, 'scripts/preview-limits.test.mjs'), '// fixture');
    assert.equal(deploymentTests(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('the typed web application cannot skip unit contracts and nested pure TypeScript tests are discovered', () => {
  const root = mkdtempSync(join(tmpdir(), 'justup-web-suite-'));
  try {
    mkdirSync(join(root, 'web/src/api'), { recursive: true });
    writeFileSync(join(root, 'web/src/api/client.ts'), '// fixture');
    assert.throws(() => webTests(root), /no registered/);
    writeFileSync(join(root, 'web/src/api/client.test.ts'), '// fixture');
    mkdirSync(join(root, 'web/src/features/search'), { recursive: true });
    writeFileSync(join(root, 'web/src/features/search/state.test.ts'), '// fixture');
    assert.deepEqual(webTests(root), [join(root, 'web/src/api/client.test.ts'), join(root, 'web/src/features/search/state.test.ts')]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
