/**
 * Station art for the Command Center: one workstation drawn in SVG by code,
 * from the SceneStation it receives. Nothing is baked: the pose of the agent,
 * the screens and the lights are all functions of `station.state`, so a state
 * change in the model redraws them. Presentation only.
 *
 * Motion is CSS (CommandCenter.css): small groups animate transform/opacity;
 * the work loop exists only under `.cc-state-working`. Poses change through
 * CSS transitions so a change of state reads as a short movement, not a cut.
 */

import React from 'react';
import {
  P,
  boxFaces,
  f1,
  planeMatrix,
  pts,
  stationFrame,
  svgId,
  type Pt,
  type StationFrame,
} from './iso';
import type { SceneStation, StationKit, StationVisualState } from './officeScene';

export const DESK_Z = 44;
const TOP_T = 3;
export const DESK_TOP = DESK_Z + TOP_T;
export const DESK_DEPTH = 52;
const SEAT_V = 20;
/** How far in front of the desk's back edge the label hangs, in world units. */
export const LABEL_V = SEAT_V + 44;
const SEAT_Z = 22;

export type ScreenKind = 'grid' | 'wave' | 'log' | 'chips';

interface MonitorSpec {
  u: number;
  w: number;
  h: number;
  kind: ScreenKind;
}

const MONITORS: Record<StationKit, MonitorSpec[]> = {
  console: [
    { u: -66, w: 60, h: 36, kind: 'grid' },
    { u: 0, w: 72, h: 42, kind: 'wave' },
    { u: 66, w: 60, h: 36, kind: 'log' },
  ],
  research: [
    { u: -30, w: 54, h: 40, kind: 'wave' },
    { u: 30, w: 54, h: 40, kind: 'log' },
  ],
  dev: [
    { u: -38, w: 46, h: 34, kind: 'log' },
    { u: 12, w: 50, h: 40, kind: 'log' },
    { u: 48, w: 22, h: 44, kind: 'chips' },
  ],
  review: [{ u: 0, w: 96, h: 36, kind: 'log' }],
  bay: [{ u: 0, w: 60, h: 40, kind: 'log' }],
  generic: [{ u: 0, w: 56, h: 38, kind: 'wave' }],
};

/* ------------------------------------------------------------------ boxes */

interface BoxProps {
  x: number;
  y: number;
  w: number;
  d: number;
  z: number;
  h: number;
  mat: string;
  edge?: boolean;
}

export function IsoBox({ x, y, w, d, z, h, mat, edge = true }: BoxProps) {
  const f = boxFaces(x, y, w, d, z, h);
  return (
    <g className={`cc-box cc-m-${mat}`}>
      <polygon className="l" points={pts(f.left)} />
      <polygon className="r" points={pts(f.right)} />
      <polygon className="t" points={pts(f.top)} />
      {edge && h > 2 && <polyline className="eh" points={pts(f.edgeLeft)} />}
      {edge && h > 2 && <polyline className="eh2" points={pts(f.edgeRight)} />}
    </g>
  );
}

function FBox({ f, u, v, w, d, z, h, mat, edge }: { f: StationFrame; u: number; v: number; w: number; d: number; z: number; h: number; mat: string; edge?: boolean }) {
  const [x, y, ww, dd] = f.rect(u, v, w, d);
  return <IsoBox x={x} y={y} w={ww} d={dd} z={z} h={h} mat={mat} edge={edge} />;
}

/* ---------------------------------------------------------------- screens */

function ScreenContent({ kind, state, w, h }: { kind: ScreenKind | 'call' | 'alert' | 'standby'; state: StationVisualState; w: number; h: number }) {
  const moving = state === 'working';
  if (kind === 'standby') {
    return (
      <g className="cc-scr-standby">
        <rect x={w / 2 - 7} y={h / 2 - 0.6} width={14} height={1.2} rx={0.6} />
        <circle className="cc-led" cx={w - 4} cy={h - 3.4} r={1.1} />
      </g>
    );
  }
  if (kind === 'call') {
    return (
      <g className="cc-scr-call">
        <rect className="panel" x={w * 0.14} y={h * 0.2} width={w * 0.72} height={h * 0.6} rx={2} />
        <circle className="ring" cx={w * 0.3} cy={h * 0.42} r={h * 0.12} />
        <rect className="bar" x={w * 0.46} y={h * 0.34} width={w * 0.3} height={1.6} rx={0.8} />
        <rect className="bar dim" x={w * 0.46} y={h * 0.46} width={w * 0.2} height={1.6} rx={0.8} />
        <rect className="btn" x={w * 0.52} y={h * 0.62} width={w * 0.28} height={h * 0.12} rx={1.4} />
      </g>
    );
  }
  if (kind === 'alert') {
    return (
      <g className="cc-scr-alert">
        <rect className="band" x={0} y={0} width={w} height={h * 0.2} />
        <path className="tri" d={`M${w / 2} ${h * 0.3} l${h * 0.16} ${h * 0.3} h${-h * 0.32} z`} />
        {[0, 1, 2, 3].map((i) => (
          <rect key={i} className="bar" x={w * 0.1} y={h * (0.68 + i * 0.07)} width={w * (0.74 - i * 0.14)} height={1.3} rx={0.65} />
        ))}
      </g>
    );
  }
  if (kind === 'grid') {
    return (
      <g className="cc-scr-grid">
        {[0, 1, 2, 3, 4].map((i) => (
          <rect key={i} className="tile" x={w * (0.07 + i * 0.18)} y={h * 0.18} width={w * 0.15} height={h * 0.5} rx={1.4} />
        ))}
        <path className="line" d={`M${w * 0.07} ${h * 0.86} ${Array.from({ length: 12 }, (_, i) => `L${f1(w * (0.07 + (i / 11) * 0.86))} ${f1(h * (0.84 - 0.08 * Math.abs(Math.sin(i * 0.9))))}`).join(' ')}`} />
      </g>
    );
  }
  if (kind === 'wave') {
    const one = (offset: number) => `M${offset} ${h * 0.6} ${Array.from({ length: 21 }, (_, i) => `L${f1(offset + (i / 20) * w)} ${f1(h * 0.55 - Math.sin((i / 20) * Math.PI * 4) * h * 0.2 - Math.sin((i / 20) * Math.PI * 10 + 1) * h * 0.07)}`).join(' ')}`;
    return (
      <g className={`cc-scr-wave ${moving ? 'cc-scroll-x' : ''}`}>
        <path className="line" d={`${one(0)} ${one(w).replace('M', 'L')}`} />
      </g>
    );
  }
  if (kind === 'chips') {
    return (
      <g className="cc-scr-chips">
        {[0, 1, 2, 3, 4].map((i) => (
          <rect key={i} className={`chip chip-${i}`} x={w * 0.14} y={h * (0.1 + i * 0.17)} width={w * 0.72} height={h * 0.12} rx={1.2} />
        ))}
      </g>
    );
  }
  // log: rows of tiny bars, twice, so a -50% scroll loops without a seam
  const rows: React.ReactElement[] = [];
  for (let rep = 0; rep < 2; rep++) {
    for (let i = 0; i < 9; i++) {
      const len = [0.7, 0.42, 0.85, 0.36, 0.64, 0.78, 0.3, 0.55, 0.7][i];
      rows.push(<rect key={`${rep}-${i}`} className={i % 3 === 1 ? 'bar acc' : i % 4 === 0 ? 'bar vio' : 'bar'} x={w * 0.08} y={(rep * 9 + i) * (h / 8)} width={w * 0.84 * len} height={h * 0.045} rx={0.7} />);
    }
  }
  return <g className={`cc-scr-log ${moving ? 'cc-scroll-y' : ''}`}>{rows}</g>;
}

function Monitor({ f, spec, state, uid, index, primary, role }: { f: StationFrame; spec: MonitorSpec; state: StationVisualState; uid: string; index: number; primary: boolean; role: 'call' | 'alert' | null }) {
  const vb = -DESK_DEPTH + 10;
  const z0 = DESK_TOP + 9;
  const kind: ScreenKind | 'call' | 'alert' | 'standby' = state === 'idle' ? 'standby' : primary && role ? role : spec.kind;
  const sw = spec.w - 3;
  const sh = spec.h - 3;
  const origin = f.pt(spec.u - spec.w / 2 + 1.5, vb + 4, z0 + spec.h - 1.5);
  const clip = `cc-clip-${uid}-${index}`;
  const dim = state !== 'working' && !(primary && role) && state !== 'idle';
  return (
    <g className={`cc-monitor cc-scr--${state} ${dim ? 'cc-scr-dim' : ''} ${kind === 'call' ? 'is-call' : kind === 'alert' ? 'is-alert' : ''}`}>
      <FBox f={f} u={spec.u - 8} v={vb - 3} w={16} d={9} z={DESK_TOP} h={1.4} mat="metal" />
      <FBox f={f} u={spec.u - 2.5} v={vb - 1} w={5} d={5} z={DESK_TOP + 1} h={8 + spec.h * 0.3} mat="metal" edge={false} />
      <FBox f={f} u={spec.u - spec.w / 2} v={vb} w={spec.w} d={4} z={z0} h={spec.h} mat="panel" />
      <g transform={planeMatrix(origin, f.dirU)}>
        <clipPath id={clip}>
          <rect width={sw} height={sh} rx={1.6} />
        </clipPath>
        <rect className="cc-glass" width={sw} height={sh} rx={1.6} />
        <g clipPath={`url(#${clip})`}>
          <ScreenContent kind={kind} state={state} w={sw} h={sh} />
        </g>
      </g>
    </g>
  );
}

/* ------------------------------------------------------------ wall panels */

/**
 * Screens on the wall behind a station that stands against one (the left wall
 * for W desks, the back wall for the back row). They mirror the station's own
 * state: moving while it works, parked and framed in amber or red when it
 * waits or fails, standby when it is idle. Abstract content only.
 */
function WallPanels({ station, f, uid }: { station: SceneStation; f: StationFrame; uid: string }) {
  const onLeft = station.orient === 'W' && station.cx <= 140;
  const onBack = station.orient === 'N' && station.cy <= 130;
  if (!onLeft && !onBack) return null;
  const state = station.state;
  const kinds: ScreenKind[] = station.kit === 'research' ? ['wave', 'log'] : station.kit === 'review' ? ['log', 'grid'] : station.kit === 'dev' ? ['log', 'wave'] : ['wave', 'log'];
  const pw = (station.width - 22) / 2;
  const ph = 34;
  const wallV = onLeft ? 3 - station.cx : 3 - station.cy;
  const dim = state === 'waiting' || state === 'error';
  return (
    <g className={`cc-wall-panels cc-scr--${state}`}>
      {kinds.map((kind, i) => {
        const u0 = -station.width / 2 + 8 + i * (pw + 6);
        const origin = f.pt(u0, wallV, 112);
        const clip = `cc-wclip-${uid}-${i}`;
        return (
          <g key={i} transform={planeMatrix(origin, f.dirU)} className={dim ? 'cc-scr-dim' : undefined}>
            <clipPath id={clip}>
              <rect width={pw} height={ph} rx={1.6} />
            </clipPath>
            <rect className="cc-glass cc-wall-glass" width={pw} height={ph} rx={1.6} />
            <g clipPath={`url(#${clip})`}>
              <ScreenContent kind={state === 'idle' ? 'standby' : kind} state={state} w={pw} h={ph} />
            </g>
          </g>
        );
      })}
    </g>
  );
}

/* --------------------------------------------------------------- the desk */

function Desk({ f, width, state }: { f: StationFrame; width: number; state: StationVisualState }) {
  const w = width;
  const a = f.pt(-w / 2 + 6, 0, DESK_TOP + 0.2);
  const b = f.pt(w / 2 - 6, 0, DESK_TOP + 0.2);
  return (
    <g className="cc-desk">
      <FBox f={f} u={-w / 2} v={-DESK_DEPTH + 5} w={5} d={DESK_DEPTH - 10} z={0} h={DESK_Z} mat="leg" edge={false} />
      <FBox f={f} u={-w / 2 + 5} v={-DESK_DEPTH + 5} w={w - 35} d={5} z={12} h={DESK_Z - 12} mat="deep" edge={false} />
      <FBox f={f} u={w / 2 - 30} v={-DESK_DEPTH + 5} w={25} d={DESK_DEPTH - 10} z={0} h={DESK_Z - 1} mat="cabinet" />
      <FBox f={f} u={w / 2 - 5} v={-DESK_DEPTH + 5} w={5} d={DESK_DEPTH - 10} z={0} h={DESK_Z} mat="leg" edge={false} />
      <FBox f={f} u={-w / 2} v={-DESK_DEPTH} w={w} d={DESK_DEPTH} z={DESK_Z} h={TOP_T} mat="top" />
      {/* the lip of the desk carries the state light and the role accent */}
      <polyline className="cc-lip" points={pts([P(...a), P(...b)])} />
      <polyline className="cc-lip-state" points={pts([P(...a), P(...b)])} data-state={state} />
      {/* keyboard and mouse */}
      <FBox f={f} u={-19} v={-22} w={38} d={11} z={DESK_TOP} h={1.5} mat="metal" />
      <FBox f={f} u={24} v={-19} w={5} d={8} z={DESK_TOP} h={1.6} mat="metal" />
    </g>
  );
}

/* ----------------------------------------------------------------- kits */

function RoleKit({ kit, layer, f, state, width }: { kit: StationKit; layer: 'back' | 'front'; f: StationFrame; state: StationVisualState; width: number }) {
  if (kit === 'research') {
    if (layer !== 'back') return null;
    // a rack standing behind the desk: data comes from somewhere
    const leds = [0, 1, 2, 3, 4, 5, 6, 7];
    const [rx, ry] = f.rect(-17, -DESK_DEPTH - 40, 34, 34);
    const faces = boxFaces(rx, ry, 34, 34, 0, 96);
    return (
      <g className="cc-rack">
        <IsoBox x={rx} y={ry} w={34} d={34} z={0} h={96} mat="rack" />
        {leds.map((i) => {
          const z = 10 + i * 10.5;
          const a = P(rx + 34, ry + 6, z);
          const b = P(rx + 34, ry + 28, z);
          return (
            <g key={i}>
              <line className="slot" x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />
              <circle className={`led led-${i % 3}`} cx={a[0] + 2} cy={a[1] - 1.6} r={1.1} />
            </g>
          );
        })}
        <polyline className="eh" points={pts(faces.edgeLeft)} />
      </g>
    );
  }
  if (layer === 'back') return null;
  if (kit === 'dev') {
    // stack light on the corner of the bench: the lit segment is the state
    const [x, y] = f.rect(width / 2 - 14, -DESK_DEPTH + 8, 6, 6);
    return (
      <g className="cc-stack">
        <IsoBox x={x} y={y} w={6} d={6} z={DESK_TOP} h={3} mat="metal" edge={false} />
        <IsoBox x={x + 1.5} y={y + 1.5} w={3} d={3} z={DESK_TOP + 3} h={5} mat="metal" edge={false} />
        {(['error', 'waiting', 'working'] as const).map((s, i) => (
          <IsoBox key={s} x={x} y={y} w={6} d={6} z={DESK_TOP + 8 + i * 5} h={4.4} mat={`seg-${s}${state === s ? ' on' : ''}`} edge={false} />
        ))}
      </g>
    );
  }
  if (kit === 'review') {
    // inspection lamp over the desk, a checklist clip-board
    const [lx, ly] = f.rect(width / 2 - 24, -DESK_DEPTH + 8, 8, 8);
    const base = P(lx + 4, ly + 4, DESK_TOP + 2);
    const knee = P(lx + 4, ly + 4, DESK_TOP + 30);
    const hp = f.pt(width / 2 - 44, -DESK_DEPTH + 26, DESK_TOP + 34);
    const head = P(...hp);
    return (
      <g className="cc-lamp">
        <FBox f={f} u={-width / 2 + 6} v={-DESK_DEPTH + 14} w={16} d={4} z={DESK_TOP} h={2} mat="metal" />
        <FBox f={f} u={-width / 2 + 7} v={-DESK_DEPTH + 15} w={14} d={1.4} z={DESK_TOP + 2} h={14} mat="paper" edge={false} />
        <polyline className="arm" points={pts([base, knee, head])} />
        <ellipse className="head" cx={head[0]} cy={head[1]} rx={8} ry={3.6} />
        <polygon className="cone" points={pts([[head[0] - 6, head[1] + 2], [head[0] + 6, head[1] + 2], [head[0] + 20, head[1] + 38], [head[0] - 20, head[1] + 38]])} />
      </g>
    );
  }
  if (kit === 'bay') {
    const [lx, ly] = f.rect(-width / 2 + 8, -DESK_DEPTH + 10, 5, 5);
    return (
      <g className="cc-bay-lamp">
        <IsoBox x={lx} y={ly} w={5} d={5} z={DESK_TOP} h={1.4} mat="metal" edge={false} />
        <IsoBox x={lx + 1.2} y={ly + 1.2} w={2.6} d={2.6} z={DESK_TOP + 1.4} h={11} mat="metal" edge={false} />
        <IsoBox x={lx - 1} y={ly - 1} w={7} d={7} z={DESK_TOP + 12} h={2.4} mat="shade" edge={false} />
      </g>
    );
  }
  return null;
}

/* ----------------------------------------------------------- the chair */

function Chair({ f }: { f: StationFrame }) {
  const c = f.pt(0, SEAT_V, 0);
  const spokes = Array.from({ length: 5 }, (_, i) => {
    const t = (i / 5) * Math.PI * 2 + 0.3;
    return [P(c[0], c[1], 3.4), P(c[0] + Math.cos(t) * 12, c[1] + Math.sin(t) * 12, 2)] as const;
  });
  return (
    <g className="cc-chair">
      {spokes.map(([a, b], i) => (
        <line key={i} className="spoke" x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />
      ))}
      <FBox f={f} u={-2} v={SEAT_V - 2} w={4} d={4} z={4} h={SEAT_Z - 4} mat="metal" edge={false} />
      <FBox f={f} u={-11} v={SEAT_V - 10} w={22} d={20} z={SEAT_Z} h={4} mat="seat" />
    </g>
  );
}

function ChairBack({ f }: { f: StationFrame }) {
  return (
    <g className="cc-chair-back">
      <FBox f={f} u={-11} v={SEAT_V + 9} w={22} d={4} z={SEAT_Z + 4} h={20} mat="seat" />
    </g>
  );
}

/* ---------------------------------------------------------- the agent */

/** The seated agent, in screen space around the seat. Pose and loops are CSS, driven by the station state class. */
function Agent({ station, f }: { station: SceneStation; f: StationFrame }) {
  const seat = P(...f.pt(0, SEAT_V, SEAT_Z + 4));
  const key = P(...f.pt(0, -16, DESK_TOP + 2));
  const toKey: Pt = [key[0] - seat[0], key[1] - seat[1]];
  const dir = Math.sign(toKey[0]) || 1;
  const uStep = ((): Pt => {
    const a = P(...f.pt(0, 0, 0));
    const b = P(...f.pt(1, 0, 0));
    return [b[0] - a[0], b[1] - a[1]];
  })();
  const state = station.state;
  // Hand targets per pose, relative to the seat.
  const working: [Pt, Pt] = [[toKey[0] - uStep[0] * 6, toKey[1] - uStep[1] * 6], [toKey[0] + uStep[0] * 6, toKey[1] + uStep[1] * 6]];
  const resting: [Pt, Pt] = [[-7, -9], [7, -9]];
  const raised: [Pt, Pt] = [[-8, -44], [8, -43]];
  const hands = state === 'working' ? working : state === 'error' ? raised : resting;
  const shoulders: [Pt, Pt] = [[-11, -38], [11, -38]];
  const elbowFor = (s: Pt, h: Pt, side: number): Pt => [
    state === 'error' ? s[0] + side * 7 : s[0] + (h[0] - s[0]) * 0.4 + side * 3,
    state === 'error' ? s[1] + 8 : s[1] + (h[1] - s[1]) * 0.4 + 11,
  ];
  const arm = (side: number, idx: 0 | 1) => {
    const s = shoulders[idx];
    const h = hands[idx];
    const e = elbowFor(s, h, side);
    return (
      <g className={`cc-arm cc-arm-${idx === 0 ? 'l' : 'r'}`}>
        <path className="upper" d={`M${s[0]} ${s[1]} L${f1(e[0])} ${f1(e[1])}`} style={{ ['--p' as string]: `'M${s[0]} ${s[1]} L${f1(e[0])} ${f1(e[1])}'` }} />
        <g className="fore" style={{ transform: `translate(${f1(e[0])}px, ${f1(e[1])}px)` }}>
          <g className="tap">
            <path className="lower" d={`M0 0 L${f1(h[0] - e[0])} ${f1(h[1] - e[1])}`} style={{ ['--p' as string]: `'M0 0 L${f1(h[0] - e[0])} ${f1(h[1] - e[1])}'` }} />
            <circle className="hand" cx={0} cy={0} r={3} style={{ transform: `translate(${f1(h[0] - e[0])}px, ${f1(h[1] - e[1])}px)` }} />
          </g>
        </g>
      </g>
    );
  };
  return (
    <g className="cc-agent" transform={`translate(${f1(seat[0])} ${f1(seat[1])})`} data-role={station.accent} style={{ ['--cc-dir' as string]: dir }}>
      <g className="cc-body">
        <g className="cc-torso">
          <path className="jacket" d="M-9 -4 C-10 -16 -13 -30 -13 -38 Q-13 -43 -8 -44 L8 -44 Q13 -43 13 -38 C13 -30 10 -16 9 -4 Z" />
          <path className="jacket-shade" d="M1 -44 L8 -44 Q13 -43 13 -38 C13 -30 10 -16 9 -4 L1 -4 Z" />
          <path className="collar" d="M-6 -44 Q0 -40 6 -44 L6 -42 Q0 -37 -6 -42 Z" />
          <rect className="stripe" x={-13} y={-31} width={26} height={2.2} rx={1.1} />
          {station.accent === 'implementer' && <path className="hood" d="M-8 -46 Q0 -38 8 -46 L7 -41 Q0 -36 -7 -41 Z" />}
          {station.accent === 'explorer' && <path className="strap" d="M-12 -40 L8 -8" />}
          {station.accent === 'reviewer' && <path className="badge" d="M5 -34 h5 v4 h-5 z" />}
        </g>
        <g className="cc-head">
          <rect className="neck" x={-2.6} y={-47} width={5.2} height={5} rx={1.6} />
          <g className="cc-hair-view">
            <ellipse className="skull" cx={0} cy={-54} rx={7.4} ry={8.2} />
            <path className="hair" d="M-7.4 -54 C-7.4 -62 7.4 -62 7.4 -54 C7 -50 4 -48 0 -48 C-4 -48 -7 -50 -7.4 -54 Z" />
            <ellipse className="rim" cx={-1.6} cy={-60} rx={4.6} ry={1.2} />
            <ellipse className="ear" cx={dir * 7} cy={-53} rx={1.4} ry={2.2} />
          </g>
          <g className="cc-face-view">
            <ellipse className="face" cx={0} cy={-54} rx={7.2} ry={8} />
            <rect className="visor" x={-5.2} y={-56.4} width={10.4} height={2.4} rx={1.2} />
          </g>
          {station.accent === 'coordinator' && <path className="headset" d={`M-8 -55 C-8 -66 8 -66 8 -55 M${dir * 8} -55 L${dir * 8} -50 L${dir * 4} -48`} />}
          {station.accent === 'reviewer' && <path className="glass-arm" d="M-7.5 -55 L7.5 -55" />}
        </g>
        {arm(-1, 0)}
        {arm(1, 1)}
      </g>
    </g>
  );
}

/* ----------------------------------------------------------- floor & lights */

function FloorPad({ f, station, uid }: { f: StationFrame; station: SceneStation; uid: string }) {
  const w = station.width;
  const corners = [
    P(...f.pt(-w / 2 - 14, -DESK_DEPTH - 10, 0.2)),
    P(...f.pt(w / 2 + 14, -DESK_DEPTH - 10, 0.2)),
    P(...f.pt(w / 2 + 14, 58, 0.2)),
    P(...f.pt(-w / 2 - 14, 58, 0.2)),
  ];
  const c = P(...f.pt(0, 6, 0.3));
  const rx = w * 0.62;
  const bracket = (a: Pt, b: Pt, c2: Pt) => `${a[0]},${a[1]} ${b[0]},${b[1]} ${c2[0]},${c2[1]}`;
  const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return (
    <g className="cc-pad">
      <defs>
        <radialGradient id={`cc-pool-${uid}`}>
          <stop offset="0" className="s0" />
          <stop offset="1" className="s1" />
        </radialGradient>
      </defs>
      <polygon className="pad" points={pts(corners)} />
      <ellipse className="pool" cx={c[0]} cy={c[1]} rx={rx} ry={rx * 0.5} fill={`url(#cc-pool-${uid})`} />
      <polygon className="active-ring" points={pts(corners)} />
      <polygon className="hl" points={pts(corners)} />
      <g className="lock">
        {corners.map((p, i) => (
          <polyline key={i} points={bracket(lerp(p, corners[(i + 3) % 4], 0.14), p, lerp(p, corners[(i + 1) % 4], 0.14))} />
        ))}
      </g>
    </g>
  );
}

function Beacon({ f, station }: { f: StationFrame; station: SceneStation }) {
  const [x, y] = f.rect(station.width / 2 - 4, -8, 6, 6);
  const top = P(x + 3, y + 3, DESK_TOP + 6);
  return (
    <g className="cc-beacon">
      <IsoBox x={x} y={y} w={6} d={6} z={DESK_TOP} h={5} mat="beacon" edge={false} />
      <circle className="halo" cx={top[0]} cy={top[1]} r={14} />
      <circle className="core" cx={top[0]} cy={top[1]} r={2.2} />
    </g>
  );
}

/* ------------------------------------------------------------ the station */

export interface StationArtProps {
  station: SceneStation;
}

/** Anchors of the station label, callout and beacon halo (its centre), in view pixels. */
export function stationAnchors(station: SceneStation): { label: Pt; callout: Pt; beacon: Pt; hull: Pt[] } {
  const f = stationFrame(station.orient, station.cx, station.cy);
  const w = station.width;
  const label = P(...f.pt(0, LABEL_V, 0));
  const callout = P(...f.pt(0, SEAT_V, 112));
  const [bx, by] = f.rect(w / 2 - 4, -8, 6, 6);
  const beacon = P(bx + 3, by + 3, DESK_TOP + 6);
  const hull: Pt[] = [];
  for (const u of [-w / 2 - 10, w / 2 + 10]) {
    for (const v of [-DESK_DEPTH - 8, SEAT_V + 20]) {
      for (const z of [0, 108]) hull.push(P(...f.pt(u, v, z)));
    }
  }
  return { label, callout, beacon, hull: convexHull(hull) };
}

function convexHull(points: Pt[]): Pt[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (const p of [...sorted].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

export function StationArt({ station }: StationArtProps) {
  const f = stationFrame(station.orient, station.cx, station.cy);
  const uid = svgId(station.sessionId);
  const specs = MONITORS[station.kit];
  // The monitor that carries the call or the alert: the widest one, nearest the middle.
  const primaryIndex = specs.reduce((best, s, i) => (s.w * s.h > specs[best].w * specs[best].h ? i : best), 0);
  const role: 'call' | 'alert' | null = station.state === 'waiting' ? 'call' : station.state === 'error' ? 'alert' : null;
  const order = specs
    .map((spec, i) => ({ spec, i }))
    .sort((a, b) => {
      const da = f.pt(a.spec.u, 0)[0] + f.pt(a.spec.u, 0)[1];
      const db = f.pt(b.spec.u, 0)[0] + f.pt(b.spec.u, 0)[1];
      return da - db;
    });
  return (
    <>
      <FloorPad f={f} station={station} uid={uid} />
      <WallPanels station={station} f={f} uid={uid} />
      <g className="cc-lift">
        <RoleKit kit={station.kit} layer="back" f={f} state={station.state} width={station.width} />
        <Desk f={f} width={station.width} state={station.state} />
        {order.map(({ spec, i }) => (
          <Monitor key={i} f={f} spec={spec} state={station.state} uid={uid} index={i} primary={i === primaryIndex} role={role} />
        ))}
        <RoleKit kit={station.kit} layer="front" f={f} state={station.state} width={station.width} />
        <Chair f={f} />
        <Agent station={station} f={f} />
        <ChairBack f={f} />
        <Beacon f={f} station={station} />
      </g>
    </>
  );
}

