// Test backend suite availability without pretending an absent backend has passed its contracts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serverTests } from '../../scripts/test-server.mjs';

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
