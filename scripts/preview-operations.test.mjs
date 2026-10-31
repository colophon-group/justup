// Register the real Python host/recovery contracts with the deployment test lane.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('preview artifact, host, privacy and recovery contracts pass', { timeout: 30_000 }, () => {
  const result = spawnSync('python3', [fileURLToPath(new URL('./preview-operations.test.py', import.meta.url))], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { PATH: process.env.PATH, LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout || 'Python operations suite did not report success.');
});
