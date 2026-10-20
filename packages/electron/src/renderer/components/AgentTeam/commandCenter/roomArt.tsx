/**
 * The room around the stations: plinth, floor, walls with a cove light, the
 * main team display, the lanes that join the stations to the Coordinator and
 * the glass of the Independent Review Bay. Static architecture plus the few
 * layers that depend on the model (display tiles, lanes, bay), all redrawn
 * from the RoomScene.
 */

import React from 'react';
import { P, PLINTH_DEPTH, VIEW, WALL_HEIGHT, f1, floorRect, planeMatrix, pts, stationFrame, svgId, type Pt } from './iso';
import { IsoBox } from './stationArt';
import { ROOM_WORLD, SLOTS, type RoomScene } from './officeScene';

const { w: RW, d: RD } = ROOM_WORLD;
export const BAY = { x: 378, y: 282, w: RW - 378, d: RD - 282 } as const;

/**
 * Where the bay caption sits, in view pixels: just below the plinth under the
 * bay, in the margin of the drawing, so it can never land on a desk or a label.
 */
export const bayCaptionAnchor = (): Pt => [P(RW + 12, RD + 12, -PLINTH_DEPTH)[0] + 40, VIEW.h - 24];

/** Display on the back wall, in world units. */
const DISPLAY = { x: 140, w: 210, z: 56, h: 80 } as const;

function MainDisplay({ scene }: { scene: RoomScene }) {
  const tiles = scene.tiles;
  const clip = `cc-display-${svgId(scene.rootId)}`;
  const w = DISPLAY.w - 6;
  const h = DISPLAY.h - 6;
  const gap = 3;
  const n = Math.max(tiles.length, 1);
  const tw = Math.min(30, (w - 12 - (n - 1) * gap) / n);
  const x0 = (w - (n * tw + (n - 1) * gap)) / 2;
  const coordinator = scene.stations.find((s) => s.slot === 'C');
  const cycling = coordinator?.state === 'working' && tiles.length > 1;
  const live = scene.workingCount > 0;
  // Two periods wide, so a scroll of -50% loops without a seam.
  const wave = Array.from({ length: 81 }, (_, i) => {
    const x = (i / 40) * w;
    return `${i ? 'L' : 'M'}${f1(x)} ${f1(h * 0.8 - Math.sin((x / w) * Math.PI * 6) * h * 0.1 - Math.sin((x / w) * Math.PI * 14 + 1) * h * 0.035)}`;
  }).join(' ');
  return (
    <g className="cc-display">
      <IsoBox x={DISPLAY.x} y={-2} w={DISPLAY.w} d={6} z={DISPLAY.z} h={DISPLAY.h} mat="panel" />
      <IsoBox x={DISPLAY.x + 60} y={-2} w={DISPLAY.w - 120} d={8} z={DISPLAY.z - 8} h={6} mat="metal" edge={false} />
      <g transform={planeMatrix([DISPLAY.x + 3, 4, DISPLAY.z + DISPLAY.h - 3], [1, 0])}>
        <clipPath id={clip}>
          <rect width={w} height={h} rx={2} />
        </clipPath>
        <rect className="cc-glass" width={w} height={h} rx={2} />
        <g clipPath={`url(#${clip})`}>
          <rect className="cc-display-head" x={0} y={0} width={w} height={7} />
          <rect className="cc-display-title" x={6} y={2.6} width={34} height={1.8} rx={0.9} />
          {tiles.map((tile, i) => (
            <g key={tile.sessionId} className={`cc-tile cc-tile--${tile.state}`}>
              <rect className="body" x={x0 + i * (tw + gap)} y={12} width={tw} height={h * 0.46} rx={2} />
              <rect className="bar" x={x0 + i * (tw + gap)} y={12} width={tw} height={2.2} rx={1.1} />
              <circle className={`dot cc-acc-${tile.accent}`} cx={x0 + i * (tw + gap) + 5} cy={21} r={2.2} />
              <rect className="line" x={x0 + i * (tw + gap) + 3} y={h * 0.46 - 2} width={tw * 0.6} height={1.6} rx={0.8} />
            </g>
          ))}
          {cycling && (
            <rect
              className="cc-focus"
              x={x0 - 1.5}
              y={10.5}
              width={tw + 3}
              height={h * 0.46 + 3}
              rx={2.6}
              style={{ ['--n' as string]: n, ['--step' as string]: `${f1(tw + gap)}px` }}
            />
          )}
          <g className={`cc-display-wave ${live ? 'cc-scroll-x' : ''}`}>
            <path d={wave} />
          </g>
        </g>
      </g>
    </g>
  );
}

function Lanes({ scene }: { scene: RoomScene }) {
  const hub = SLOTS.C;
  const hubFrame = stationFrame(hub.orient, hub.cx, hub.cy);
  const hubPt = hubFrame.pt(0, 8, 0.4);
  return (
    <g className="cc-lanes" aria-hidden>
      {scene.stations
        .filter((s) => s.slot !== 'C')
        .map((s) => {
          const f = stationFrame(s.orient, s.cx, s.cy);
          const start = f.pt(0, 8, 0.4);
          const mid: [number, number, number] = [hubPt[0], start[1], 0.4];
          const path: Pt[] = [P(...start), P(...mid), P(...hubPt)];
          const d = `M${path.map((p) => `${p[0]} ${p[1]}`).join(' L')}`;
          return (
            <g key={s.sessionId} className={`cc-lane cc-lane--${s.state}`}>
              <path className="base" d={d} />
              {s.state === 'working' && <path className="flow" d={d} />}
            </g>
          );
        })}
    </g>
  );
}

function BayGlass() {
  const post = (x: number, y: number) => {
    const a = P(x, y, 0);
    const b = P(x, y, 80);
    return <line className="post" x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />;
  };
  const pane = (a: [number, number], b: [number, number]) => {
    const q: Pt[] = [P(a[0], a[1], 78), P(b[0], b[1], 78), P(b[0], b[1], 4), P(a[0], a[1], 4)];
    return (
      <g key={`${a}-${b}`}>
        <polygon className="pane" points={pts(q)} />
        <line className="glint" x1={q[0][0] + (q[1][0] - q[0][0]) * 0.25} y1={q[0][1] + (q[1][1] - q[0][1]) * 0.25} x2={q[3][0] + (q[2][0] - q[3][0]) * 0.55} y2={q[3][1] + (q[2][1] - q[3][1]) * 0.55} />
        <polyline className="rail" points={pts([q[0], q[1]])} />
      </g>
    );
  };
  const edges: Array<[[number, number], [number, number]]> = [];
  for (let x = BAY.x; x < RW - 1; x += (RW - BAY.x) / 4) edges.push([[x, BAY.y], [x + (RW - BAY.x) / 4, BAY.y]]);
  for (let y = BAY.y; y < RD - 1; y += (RD - BAY.y) / 4) edges.push([[BAY.x, y], [BAY.x, y + (RD - BAY.y) / 4]]);
  return (
    <g className="cc-bay">
      <polygon className="bay-floor" points={pts(floorRect(BAY.x, BAY.y, BAY.w, BAY.d, 0.1))} />
      {Array.from({ length: Math.floor((BAY.w - 10) / 9.5) }, (_, i) => {
        const a = P(BAY.x + 10 + i * 9.5, BAY.y, 0.2);
        const b = P(BAY.x + 10 + i * 9.5, RD, 0.2);
        return <line key={i} className="plank" x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />;
      })}
      <polyline className="bay-edge" points={pts([P(BAY.x, RD, 0.3), P(BAY.x, BAY.y, 0.3), P(RW, BAY.y, 0.3)])} />
      {edges.map(([a, b]) => pane(a, b))}
      {post(BAY.x, BAY.y)}
      {post(BAY.x + (RW - BAY.x) / 2, BAY.y)}
      {post(RW, BAY.y)}
      {post(BAY.x, BAY.y + (RD - BAY.y) / 2)}
      {post(BAY.x, RD)}
    </g>
  );
}

/** Furniture that carries no state: a cabinet on the back wall and a lounge in the front corner. */
function Fixtures() {
  const leds = [0, 1, 2, 3, 4, 5].map((i) => P(228, 18 + i * 3.4, 40));
  return (
    <g className="cc-fixtures">
      <IsoBox x={150} y={6} w={78} d={26} z={0} h={62} mat="fixture" />
      <IsoBox x={158} y={6} w={62} d={26} z={62} h={2} mat="fixture" edge={false} />
      {leds.map((p, i) => (
        <circle key={i} className="cc-fixture-led" cx={p[0]} cy={p[1]} r={0.9} />
      ))}
      <IsoBox x={24} y={RD - 28} w={104} d={24} z={0} h={11} mat="sofa" />
      <IsoBox x={24} y={RD - 10} w={104} d={8} z={11} h={20} mat="sofa" />
      <IsoBox x={24} y={RD - 28} w={9} d={24} z={11} h={10} mat="sofa" />
      <IsoBox x={119} y={RD - 28} w={9} d={24} z={11} h={10} mat="sofa" />
    </g>
  );
}

function Plant({ x, y }: { x: number; y: number }) {
  const base = P(x, y, 20);
  const leaves = [-14, -8, -2, 4, 10, 16].map((dx, i) => `M${base[0]} ${base[1]} Q${base[0] + dx * 0.6} ${base[1] - 18 - (i % 3) * 5} ${base[0] + dx} ${base[1] - 34 - (i % 3) * 8}`);
  return (
    <g className="cc-plant">
      <IsoBox x={x - 8} y={y - 8} w={16} d={16} z={0} h={20} mat="pot" />
      {leaves.map((d, i) => (
        <path key={i} className={`leaf leaf-${i % 3}`} d={d} />
      ))}
    </g>
  );
}

export function RoomShell({ scene }: { scene: RoomScene }) {
  const grid: React.ReactElement[] = [];
  for (let x = 80; x < RW; x += 80) {
    const a = P(x, 0, 0);
    const b = P(x, RD, 0);
    grid.push(<line key={`x${x}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />);
  }
  for (let y = 80; y < RD; y += 80) {
    const a = P(0, y, 0);
    const b = P(RW, y, 0);
    grid.push(<line key={`y${y}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />);
  }
  const back: Pt[] = [P(0, 0, WALL_HEIGHT), P(RW, 0, WALL_HEIGHT), P(RW, 0, 0), P(0, 0, 0)];
  const left: Pt[] = [P(0, 0, WALL_HEIGHT), P(0, RD, WALL_HEIGHT), P(0, RD, 0), P(0, 0, 0)];
  return (
    <svg className="cc-shell" viewBox={`0 0 ${VIEW.w} ${VIEW.h}`} aria-hidden focusable="false">
      <IsoBox x={-14} y={-14} w={RW + 14 + 12} d={RD + 14 + 12} z={-PLINTH_DEPTH} h={PLINTH_DEPTH} mat="plinth" edge={false} />
      <polyline className="cc-plinth-led" points={pts([P(RW + 12, -6, -9), P(RW + 12, RD + 4, -9), P(-6, RD + 12, -9)])} />
      <polygon className="cc-floor" points={pts(floorRect(0, 0, RW, RD))} />
      <g className="cc-floor-grid">{grid}</g>
      {scene.hasBay && <BayGlass />}
      <IsoBox x={-14} y={-14} w={RW + 14} d={14} z={0} h={WALL_HEIGHT} mat="wall" edge={false} />
      <IsoBox x={-14} y={0} w={14} d={RD} z={0} h={WALL_HEIGHT} mat="wall" edge={false} />
      <polygon className="cc-wall-face cc-wall-back" points={pts(back)} />
      <polygon className="cc-wall-face cc-wall-left" points={pts(left)} />
      <polyline className="cc-cove" points={pts([P(0, 0.4, WALL_HEIGHT - 8), P(RW, 0.4, WALL_HEIGHT - 8)])} />
      <polyline className="cc-cove" points={pts([P(0.4, 0, WALL_HEIGHT - 8), P(0.4, RD, WALL_HEIGHT - 8)])} />
      <polyline className="cc-baseboard" points={pts([P(0, 0.4, 4), P(RW, 0.4, 4)])} />
      <polyline className="cc-baseboard" points={pts([P(0.4, 0, 4), P(0.4, RD, 4)])} />
      <MainDisplay scene={scene} />
      <Fixtures />
      <Plant x={18} y={24} />
      <Plant x={RW - 22} y={30} />
      <Plant x={28} y={200} />
      <Lanes scene={scene} />
    </svg>
  );
}
