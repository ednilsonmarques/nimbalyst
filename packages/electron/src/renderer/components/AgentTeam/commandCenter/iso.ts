/**
 * Isometric projection for the Command Center. Pure maths: world units (x to
 * the right/down, y to the left/down, z up) to SVG pixels, plus the few
 * helpers the SVG art needs. Azimuth 42 degrees, elevation 33 degrees, the
 * same camera the earlier prototypes used.
 */

import { ROOM_WORLD } from './officeScene';

const AZIMUTH = (42 * Math.PI) / 180;
const ELEVATION = (33 * Math.PI) / 180;
const SCALE = 1.3;
const SIN_A = Math.sin(AZIMUTH);
const COS_A = Math.cos(AZIMUTH);
const SIN_E = Math.sin(ELEVATION);
const COS_E = Math.cos(ELEVATION);

export const WALL_HEIGHT = 150;
export const WALL_THICKNESS = 14;
export const PLINTH_DEPTH = 22;
const PAD = 26;

function raw(x: number, y: number, z: number): [number, number] {
  return [(x * SIN_A - y * COS_A) * SCALE, ((x * COS_A + y * SIN_A) * SIN_E - z * COS_E) * SCALE];
}

const corners: Array<[number, number]> = [
  raw(-WALL_THICKNESS, -WALL_THICKNESS, WALL_HEIGHT),
  raw(ROOM_WORLD.w + 12, -WALL_THICKNESS, WALL_HEIGHT),
  raw(-WALL_THICKNESS, ROOM_WORLD.d + 12, WALL_HEIGHT),
  raw(ROOM_WORLD.w + 12, ROOM_WORLD.d + 12, -PLINTH_DEPTH),
  raw(-WALL_THICKNESS, ROOM_WORLD.d + 12, -PLINTH_DEPTH),
  raw(ROOM_WORLD.w + 12, -WALL_THICKNESS, -PLINTH_DEPTH),
];
const MIN_X = Math.min(...corners.map((c) => c[0]));
const MAX_X = Math.max(...corners.map((c) => c[0]));
const MIN_Y = Math.min(...corners.map((c) => c[1]));
const MAX_Y = Math.max(...corners.map((c) => c[1]));

/** SVG viewBox size of one room. */
export const VIEW = { w: Math.ceil(MAX_X - MIN_X + PAD * 2), h: Math.ceil(MAX_Y - MIN_Y + PAD * 2) } as const;

export type Pt = readonly [number, number];

export function P(x: number, y: number, z = 0): Pt {
  const [sx, sy] = raw(x, y, z);
  return [Math.round((sx - MIN_X + PAD) * 10) / 10, Math.round((sy - MIN_Y + PAD) * 10) / 10];
}

/** Pixels of one world unit along the screen x axis of a plane along world x (and along y). */
export const UNIT_X = SIN_A * SCALE;
export const UNIT_Y = COS_A * SCALE;
/** Vertical pixels of one world unit of height. */
export const UNIT_Z = COS_E * SCALE;

/**
 * An id fragment safe for an SVG/DOM id and different for every input: each
 * character outside [A-Za-z0-9-] becomes `_<hex>_` (the underscore is encoded
 * too), so "a:b" and "ab" can never share a clipPath or gradient id.
 */
export const svgId = (id: string): string => id.replace(/[^A-Za-z0-9-]/gu, (ch) => `_${ch.codePointAt(0)!.toString(16)}_`);

export const pts = (list: readonly Pt[]): string => list.map(([x, y]) => `${x},${y}`).join(' ');
export const f1 = (n: number): number => Math.round(n * 10) / 10;

/** A world point on the floor to a percentage of the view, for HTML layers placed over the SVG. */
export function toPercent(point: Pt): { left: string; top: string } {
  return { left: `${f1((point[0] / VIEW.w) * 1000) / 10}%`, top: `${f1((point[1] / VIEW.h) * 1000) / 10}%` };
}

/** matrix() of a vertical plane: local x along the floor direction `dir`, local y downward. */
export function planeMatrix(origin: readonly [number, number, number], dir: readonly [number, number]): string {
  const p0 = P(origin[0], origin[1], origin[2]);
  const pu = P(origin[0] + dir[0], origin[1] + dir[1], origin[2]);
  const pd = P(origin[0], origin[1], origin[2] - 1);
  return `matrix(${[pu[0] - p0[0], pu[1] - p0[1], pd[0] - p0[0], pd[1] - p0[1], p0[0], p0[1]].map((v) => Math.round(v * 1000) / 1000).join(' ')})`;
}

export interface BoxFaces {
  top: Pt[];
  left: Pt[];
  right: Pt[];
  /** Highlight along the near top edges (left face to top, right face to top). */
  edgeLeft: [Pt, Pt];
  edgeRight: [Pt, Pt];
  /** Vertical corner nearest the viewer. */
  corner: [Pt, Pt];
}

/** The three faces the camera sees: top, the +y face (left on screen) and the +x face (right on screen). */
export function boxFaces(x: number, y: number, w: number, d: number, z: number, h: number): BoxFaces {
  const z1 = z + h;
  const a = P(x, y, z1);
  const b = P(x + w, y, z1);
  const c = P(x + w, y + d, z1);
  const dd = P(x, y + d, z1);
  const b0 = P(x + w, y, z);
  const c0 = P(x + w, y + d, z);
  const d0 = P(x, y + d, z);
  return {
    top: [a, b, c, dd],
    left: [dd, c, c0, d0],
    right: [c, b, b0, c0],
    edgeLeft: [dd, c],
    edgeRight: [c, b],
    corner: [c, c0],
  };
}

/** A flat polygon on the floor (or any horizontal plane). */
export function floorRect(x: number, y: number, w: number, d: number, z = 0): Pt[] {
  return [P(x, y, z), P(x + w, y, z), P(x + w, y + d, z), P(x, y + d, z)];
}

/**
 * Station frame: (u across the desk, v toward the person) to world units.
 * N desks face the back wall (-y), W desks face the left wall (-x).
 */
export interface StationFrame {
  pt(u: number, v: number, z?: number): [number, number, number];
  /** Axis-aligned world rect [x, y, w, d] of a rect given in (u, v). */
  rect(u0: number, v0: number, w: number, d: number): [number, number, number, number];
  dirU: readonly [number, number];
  /** True when the person's back faces the +y side of the room (N desks). */
  facesBack: boolean;
}

export function stationFrame(orient: 'N' | 'W', cx: number, cy: number): StationFrame {
  if (orient === 'N') {
    return {
      pt: (u, v, z = 0) => [cx + u, cy + v, z],
      rect: (u0, v0, w, d) => [cx + u0, cy + v0, w, d],
      dirU: [1, 0],
      facesBack: true,
    };
  }
  return {
    pt: (u, v, z = 0) => [cx + v, cy - u, z],
    rect: (u0, v0, w, d) => [cx + v0, cy - (u0 + w), d, w],
    dirU: [0, -1],
    facesBack: false,
  };
}
