/**
 * Label clearance of the fixed slots. The label of a station hangs in front of
 * its desk: role, name, state and (when the model has one) the mission, four
 * short lines. It is tested as a RECTANGLE, not as an anchor point.
 *
 * Size of the rectangle, in view pixels. Label text is sized from the container
 * (0.95cqw) and the drawing is VIEW.w wide, so 1em is about 0.0095 * VIEW.w view
 * pixels at any panel width below the font cap. The name and the mission are
 * capped at 12em (the stylesheet test below pins that), the role at about 11.5em,
 * so a label is at most 12em wide; the rectangle is never narrower than 180 view
 * pixels. Height: four lines, 4.4em.
 *
 * What is checked and for which teams:
 *  - every slot's label rectangle stays on the floor;
 *  - in the reference teams (five members, five with a second advisor, and
 *    eight) no two labels overlap, and no label rectangle covers more than a
 *    corner graze (5% of its area) of another occupied desk;
 *  - the beacon glow of a desk stays off the labels of the other stations.
 * Known residual, recorded in the adjustment report and not hidden here: in the
 * eight-member team the Coordinator's label still touches the desk of the annex
 * station, and with ten or twenty members the room has no free floor for every
 * label (see the report, larger teams).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOM_WORLD, SLOTS, type SlotId } from '../officeScene';
import { P, PLINTH_DEPTH, VIEW, floorRect, stationFrame, type Pt } from '../iso';
import { DESK_DEPTH, DESK_TOP, stationAnchors } from '../stationArt';
import { BAY, bayCaptionAnchor } from '../roomArt';

const css = readFileSync(join(__dirname, '..', 'CommandCenter.css'), 'utf8');

const EM = 0.0095 * VIEW.w;
const LABEL_WIDTH = Math.max(180, 12 * EM);
const LABEL_HEIGHT = 4.4 * EM;
const HALO = 14;
const MARGIN = 4;
/** A label may graze the raised corner of a desk behind it: at most this share of its sample points. */
const COVER_TOLERANCE = 0.05;

type Rect = [left: number, top: number, right: number, bottom: number];

function inside(polygon: readonly Pt[], point: Pt): boolean {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) result = !result;
  }
  return result;
}

function convexHull(points: Pt[]): Pt[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const build = (list: Pt[]) => {
    const out: Pt[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    return out.slice(0, -1);
  };
  return [...build(sorted), ...build([...sorted].reverse())];
}

const anchorsOf = (id: SlotId) => {
  const slot = SLOTS[id];
  return stationAnchors({ orient: slot.orient, cx: slot.cx, cy: slot.cy, width: slot.width } as Parameters<typeof stationAnchors>[0]);
};

function labelRect(id: SlotId): Rect {
  const [x, y] = anchorsOf(id).label;
  return [x - LABEL_WIDTH / 2, y, x + LABEL_WIDTH / 2, y + LABEL_HEIGHT];
}

/** The rectangle sampled as a grid of points, for point-in-polygon tests. */
function samples(rect: Rect, columns = 12, rows = 4): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= columns; i++) for (let j = 0; j <= rows; j++) out.push([rect[0] + ((rect[2] - rect[0]) * i) / columns, rect[1] + ((rect[3] - rect[1]) * j) / rows]);
  return out;
}

/** The desk as the viewer sees it: its footprint raised to the desk top. */
function deskOf(id: SlotId): Pt[] {
  const slot = SLOTS[id];
  const f = stationFrame(slot.orient, slot.cx, slot.cy);
  const points: Pt[] = [];
  for (const u of [-slot.width / 2, slot.width / 2]) for (const v of [-DESK_DEPTH, 0]) for (const z of [0, DESK_TOP]) points.push(P(...f.pt(u, v, z)));
  return convexHull(points);
}

const overlap = (a: Rect, b: Rect, margin = MARGIN) => a[0] < b[2] + margin && b[0] < a[2] + margin && a[1] < b[3] + margin && b[1] < a[3] + margin;

const FLOOR = floorRect(0, 0, ROOM_WORLD.w, ROOM_WORLD.d);
const ids = Object.keys(SLOTS) as SlotId[];

/** Slots occupied in the reference teams. */
const FIVE: SlotId[] = ['C', 'L1', 'B1', 'L3', 'A1'];
const FIVE_TWO_ADVISORS: SlotId[] = [...FIVE, 'A2'];
const EIGHT: SlotId[] = ['C', 'L1', 'L2', 'F2', 'B1', 'B2', 'L3', 'A1'];

describe('label rectangle assumptions', () => {
  it('pins the stylesheet to the size the rectangle assumes', () => {
    expect(css).toMatch(/\.cc-label\s*\{[^}]*font-size:\s*clamp\(9px,\s*0\.95cqw,\s*12\.5px\)/);
    expect(css).toMatch(/\.cc-label \.name\s*\{[^}]*max-width:\s*12em/);
    expect(css).toMatch(/\.cc-label \.mission\s*\{[^}]*max-width:\s*12em/);
    expect(css).toMatch(/\.cc-label \.mission\s*\{[^}]*text-overflow:\s*ellipsis/);
    expect(LABEL_WIDTH).toBeGreaterThanOrEqual(180);
  });
});

describe('slot label clearance', () => {
  it('keeps the label rectangle of every slot on the floor', () => {
    for (const id of ids) {
      const outside = samples(labelRect(id)).filter((point) => !inside(FLOOR, point));
      expect(outside, `${id} label has ${outside.length} points off the floor`).toEqual([]);
    }
  });

  for (const [name, team] of [
    ['five members', FIVE],
    ['five members with a second advisor', FIVE_TWO_ADVISORS],
    ['eight members', EIGHT],
  ] as const) {
    it(`never overlaps two labels (${name})`, () => {
      for (const a of team) for (const b of team.filter((id) => id > a)) expect(overlap(labelRect(a), labelRect(b)), `${a} and ${b} labels`).toBe(false);
    });

    it(`keeps the beacon glow off the other labels (${name})`, () => {
      for (const from of team) {
        const [x, y] = anchorsOf(from).beacon;
        const halo: Rect = [x - HALO, y - HALO, x + HALO, y + HALO];
        for (const against of team.filter((id) => id !== from)) expect(overlap(halo, labelRect(against), 2), `${from} glow over the ${against} label`).toBe(false);
      }
    });
  }

  for (const [name, team] of [
    ['five members', FIVE],
    ['five members with a second advisor', FIVE_TWO_ADVISORS],
  ] as const) {
    it(`never lets a label rectangle cover another occupied desk (${name})`, () => {
      for (const from of team) {
        for (const onto of team.filter((id) => id !== from)) {
          const all = samples(labelRect(from));
          const covered = all.filter((point) => inside(deskOf(onto), point));
          expect(covered.length / all.length, `${from} label covers ${covered.length} of ${all.length} points of the ${onto} desk`).toBeLessThanOrEqual(COVER_TOLERANCE);
        }
      }
    });
  }

  it('keeps both bay desks inside the bay glass and apart from each other', () => {
    for (const id of ['A1', 'A2'] as const) {
      const slot = SLOTS[id];
      // The floor pad (desk plus its margin) stays within the bay rectangle.
      expect(slot.cx - slot.width / 2 - 14).toBeGreaterThanOrEqual(BAY.x);
      expect(slot.cx + slot.width / 2 + 14).toBeLessThanOrEqual(ROOM_WORLD.w);
      expect(slot.cy - DESK_DEPTH - 10).toBeGreaterThanOrEqual(BAY.y);
      expect(slot.cy + 58).toBeLessThanOrEqual(ROOM_WORLD.d);
    }
    const [a, b] = [SLOTS.A1, SLOTS.A2];
    expect(Math.abs(a.cx - b.cx) >= (a.width + b.width) / 2 || Math.abs(a.cy - b.cy) >= DESK_DEPTH + 16).toBe(true);
  });

  it('puts the bay caption in the margin under the plinth, inside the drawing', () => {
    const [x, y] = bayCaptionAnchor();
    const plinthBottom = P(ROOM_WORLD.w + 12, ROOM_WORLD.d + 12, -PLINTH_DEPTH)[1];
    expect(y).toBeGreaterThan(plinthBottom);
    expect(y + 14).toBeLessThanOrEqual(VIEW.h);
    expect(x - 100).toBeGreaterThanOrEqual(0);
    expect(x + 100).toBeLessThanOrEqual(VIEW.w);
  });
});
