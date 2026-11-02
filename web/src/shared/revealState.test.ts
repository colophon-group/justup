// Import churn must not retain deleted identities or reset surviving row admissions.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retainRevealedIds } from './revealState.ts';
test('long-open import churn retains only current revealed identities and leaves survivors admitted', () => {
  let admitted: ReadonlySet<string> = new Set(['reading', 'focused']);
  for (let generation = 0; generation < 10_000; generation++) {
    const arrival = `import-${generation}`;
    admitted = new Set([...admitted, arrival]);
    const before = admitted;
    admitted = retainRevealedIds(admitted, new Set(['reading', 'focused', arrival]));
    assert.equal(admitted.size, 3);
    assert.ok(admitted.has('reading') && admitted.has('focused') && admitted.has(arrival));
    assert.ok(before.has(arrival));
    assert.equal(retainRevealedIds(admitted, new Set([...admitted, 'buffered'])), admitted);
  }
});
