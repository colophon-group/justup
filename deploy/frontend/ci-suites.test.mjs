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
    writeFileSync(join(root, 'scripts/import-demo-jobs.py'), '# fixture');
    assert.notEqual(run().status, 0);
    writeFileSync(join(root, 'scripts/test_import_demo_jobs.py'), 'import unittest\nclass Importer(unittest.TestCase):\n def test_fixture(self): self.assertTrue(False)\n');
    assert.notEqual(run().status, 0);
    writeFileSync(join(root, 'scripts/test_import_demo_jobs.py'), 'import unittest\nclass Importer(unittest.TestCase):\n def test_fixture(self): self.assertTrue(True)\n');
    assert.equal(run().status, 0);
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
