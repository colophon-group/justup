// Pure geometry and input bounds complement the browser's native gesture contracts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { coastlines } from './coastlines.ts';
import { globePaths, home, rotate, wheelRotation } from './globe.ts';

test('global coastlines include east/west, both hemispheres and Antarctica within a bounded asset', () => {
  const points = coastlines.flat();
  assert.equal(coastlines.length, 128); assert.ok(points.length <= 5200);
  for (const [west, east, south, north] of [[-170, -40, 0, 75], [-80, -35, -55, 0], [-15, 150, 0, 75], [110, 155, -45, -10], [-180, 180, -90, -70]]) {
    assert.ok(points.some(([x, y]) => x >= west! && x <= east! && y >= south! && y <= north!));
  }
});

test('orthographic coastlines stay circular and finite through eastern, western and polar views', () => {
  const initial = globePaths(home);
  for (const view of [home, rotate(home, 180), rotate(home, 90, 60), rotate(home, -90, -60)]) {
    const paths = globePaths(view);
    assert.ok(paths.land.length > 10000);
    for (const path of Object.values(paths)) {
      assert.doesNotMatch(path, /NaN|Infinity/);
      for (const [, x, y] of path.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)) assert.ok(Math.hypot(Number(x), Number(y)) <= 100.01);
    }
  }
  assert.notEqual(initial.land, globePaths(rotate(home, 180)).land);
  assert.deepEqual(rotate(home, 360), home);
  assert.deepEqual(rotate(home, -100000, 100000), { longitude: 80, latitude: 60 });
});

test('wheel units and bursts are bounded while Ctrl and Command zoom never rotate', () => {
  const base = { deltaX: 0, deltaY: 10, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false };
  for (const [input, expected] of [
    [base, 1.5], [{ ...base, deltaX: -20 }, -3], [{ ...base, deltaMode: 1 }, 24],
    [{ ...base, deltaMode: 2 }, 30], [{ ...base, deltaY: -100000 }, -30],
    [{ ...base, shiftKey: true }, 1.5], [{ ...base, ctrlKey: true }, 0], [{ ...base, metaKey: true }, 0],
  ] as const) assert.equal(wheelRotation(input), expected);
});
