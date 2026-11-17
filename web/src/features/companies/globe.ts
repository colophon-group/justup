// Fixed-scale orthographic projection for coastlines and evidenced countries.
import { coastlines } from './coastlines.ts';

export type Orientation = { longitude: number; latitude: number };
export const home: Orientation = { longitude: 0, latitude: 0 };
type Vector = readonly [number, number, number];
export type CountryBoundary = readonly (readonly (readonly (readonly [number, number])[])[])[];
const radians = Math.PI / 180;
const vector = ([longitude, latitude]: readonly [number, number]): Vector => [
  Math.cos(latitude * radians) * Math.sin(longitude * radians),
  Math.sin(latitude * radians),
  Math.cos(latitude * radians) * Math.cos(longitude * radians),
];
const land = coastlines.map(line => line.map(vector));
const grid = [
  ...[-60, -30, 0, 30, 60].map(latitude => Array.from({ length: 91 }, (_, i) => vector([i * 4 - 180, latitude]))),
  ...Array.from({ length: 12 }, (_, i) => Array.from({ length: 46 }, (_, j) => vector([i * 30, j * 4 - 90]))),
];

export function rotate(view: Orientation, longitude: number, latitude = 0): Orientation {
  return { longitude: ((view.longitude + longitude + 180) % 360 + 360) % 360 - 180,
    latitude: Math.max(-60, Math.min(60, view.latitude + latitude)) };
}

export function wheelRotation(event: { deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  if (event.ctrlKey || event.metaKey) return 0;
  const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 240 : 1;
  return Math.max(-30, Math.min(30, delta * scale * .15));
}

function projection(view: Orientation) {
  const yaw = view.longitude * radians, pitch = view.latitude * radians;
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  return ([x, y, z]: Vector): Vector => {
    const depth = sy * x + cy * z;
    return [cy * x - sy * z, cp * y - sp * depth, sp * y + cp * depth];
  };
}

const point = ([x, y]: Vector) => `${(x * 100).toFixed(2)},${(-y * 100).toFixed(2)}`;
function horizonBetween(from: Vector, to: Vector): Vector {
  const t = from[2] / (from[2] - to[2]);
  const x = from[0] + t * (to[0] - from[0]);
  const y = from[1] + t * (to[1] - from[1]);
  const radius = Math.hypot(x, y);
  return [x / radius, y / radius, 0];
}

export function globePaths(view: Orientation): { land: string; grid: string } {
  const project = projection(view);
  const path = (lines: readonly (readonly Vector[])[]) => lines.map(line => {
    let previous: Vector | undefined, drawing = false, result = '';
    for (const source of line) {
      const current = project(source);
      // Clip each coast/grid segment at the horizon, never draw across the back.
      if (previous && (previous[2] >= 0) !== (current[2] >= 0)) {
        const horizon = horizonBetween(previous, current);
        result += `${drawing ? 'L' : 'M'}${point(horizon)}`;
        drawing = current[2] >= 0;
      }
      if (current[2] >= 0) { result += `${drawing ? 'L' : 'M'}${point(current)}`; drawing = true; }
      else drawing = false;
      previous = current;
    }
    return result;
  }).join('');
  return { land: path(land), grid: path(grid) };
}

function clippedRing(ring: readonly Vector[]) {
  const behind = ring.findIndex(vertex => vertex[2] < 0);
  if (behind < 0) return `M${ring.map(point).join('L')}Z`;
  let previous = ring[behind]!;
  let entrance: Vector | undefined;
  let result = '';
  for (let offset = 1; offset <= ring.length; offset++) {
    const current = ring[(behind + offset) % ring.length]!;
    if (current[2] >= 0) {
      if (previous[2] < 0) {
        entrance = horizonBetween(previous, current);
        result += `M${point(entrance)}`;
      }
      result += `L${point(current)}`;
    } else if (entrance) {
      const exit = horizonBetween(previous, current);
      // Close the visible fragment along the near-hemisphere rim. SVG y points down.
      const sweep = exit[1] * entrance[0] - exit[0] * entrance[1] >= 0 ? 1 : 0;
      result += `L${point(exit)}A100,100 0 0,${sweep} ${point(entrance)}Z`;
      entrance = undefined;
    }
    previous = current;
  }
  return result;
}

export function countryPainter(boundaries: Readonly<Record<string, CountryBoundary>>, codes: readonly string[]) {
  const selected = codes.flatMap(code => {
    const boundary = boundaries[code];
    return boundary ? [{ code, rings: boundary.flatMap(polygon => polygon.map(ring => ring.map(vector))) }] : [];
  });
  return (view: Orientation) => {
    const project = projection(view);
    return selected.map(({ code, rings }) => ({ code, path: rings.map(ring => clippedRing(ring.map(project))).join('') }));
  };
}
