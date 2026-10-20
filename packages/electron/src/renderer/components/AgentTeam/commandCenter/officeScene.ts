/**
 * Command Center scene (POC G+): a pure layout and visual-state projection of
 * one OfficeRoomView. No React, no atoms, no geometry in pixels: only where
 * each member sits in the room (world units) and which of the four visual
 * states it shows. Everything is derived from the room the Office model
 * already produced; nothing is inferred from titles, missions or messages.
 *
 * Visual states (what the station shows):
 * - error   : principal state is error (an error this window received and the
 *             user has not opened). It wins over a waiting marker; the marker
 *             is still reported in `waitingKinds` so the view can show both.
 * - waiting : a waiting-for-you marker is present (the turn may still be open:
 *             `stoppedOnYou`), no unseen error.
 * - working : the member's own turn is open and it is not stopped on the user.
 * - idle    : everything else.
 *
 * Layout rule. The room has ten fixed slots grouped into zones: eight that
 * take any role (C, L1-L3, B1, B2, F1, F2) and the two bay slots (A1, A2) that
 * only advisors take. The
 * Coordinator (the room's root) always takes the central console. Every other
 * member takes the first free slot of the zone of its role:
 *   explorer, architect -> research (L1, L2)      implementer -> dev (B1, B2)
 *   reviewer            -> review (L3, F1)         advisor     -> Independent Review Bay (A1, A2)
 *   other / no role     -> annex (F2)
 * A repeated role therefore gets the next slot of its zone. When the zone is
 * full, the member takes the next free slot of a fixed overflow order that
 * never includes the bay (the Review Bay stays reserved for advisors):
 * F2, F1, L3, B2, L2, B1, L1. A team budget of 8 members (the root plus 7)
 * always fits (eight slots take any role; the two bay slots only advisors).
 * Anything beyond the slots is not drawn on the floor but is returned in
 * `overflow` (a member with no slot and no desk), so no member can disappear.
 *
 * Reading order. `stations` is in reading order (the Coordinator first, then
 * the model's order), which is the order the view renders them in, so the tab
 * order follows the model. Where a station is drawn in depth is `paintRank`
 * (1 = farthest back), applied by the view as z-index.
 *
 * Label clearance. The label of a station hangs in front of its desk. The bay
 * slots are a column far enough apart for two labels, and the room is deep
 * enough for the front row's labels: no label lands on another desk, on another
 * label or outside the floor (checked by sceneGeometry.test.ts).
 */

import type { OfficeMemberView, OfficeRoomView, OfficeWaitingKind } from '../office/officeModel';

export const ROOM_WORLD = { w: 680, d: 540 } as const;

export type SceneZoneId = 'command' | 'research' | 'dev' | 'review' | 'bay' | 'annex';
export type SceneOrient = 'N' | 'W';
export type StationVisualState = 'working' | 'idle' | 'waiting' | 'error';
export type StationKit = 'console' | 'research' | 'dev' | 'review' | 'bay' | 'generic';
export type SlotId = 'C' | 'L1' | 'L2' | 'L3' | 'B1' | 'B2' | 'F1' | 'F2' | 'A1' | 'A2';

export interface SceneSlot {
  id: SlotId;
  zone: SceneZoneId;
  /** Centre of the desk's back edge in world units (x to the right/down, y to the left/down). */
  cx: number;
  cy: number;
  /** N: the desk faces the back wall (-y). W: it faces the left wall (-x). */
  orient: SceneOrient;
  /** Desk length across the facing direction. */
  width: number;
}

export const SLOTS: Record<SlotId, SceneSlot> = {
  C: { id: 'C', zone: 'command', cx: 272, cy: 272, orient: 'N', width: 190 },
  L1: { id: 'L1', zone: 'research', cx: 110, cy: 80, orient: 'W', width: 120 },
  L2: { id: 'L2', zone: 'research', cx: 110, cy: 320, orient: 'W', width: 120 },
  L3: { id: 'L3', zone: 'review', cx: 110, cy: 440, orient: 'W', width: 120 },
  B1: { id: 'B1', zone: 'dev', cx: 430, cy: 105, orient: 'N', width: 120 },
  B2: { id: 'B2', zone: 'dev', cx: 565, cy: 105, orient: 'N', width: 120 },
  F1: { id: 'F1', zone: 'review', cx: 215, cy: 375, orient: 'N', width: 120 },
  F2: { id: 'F2', zone: 'annex', cx: 380, cy: 372, orient: 'N', width: 120 },
  A1: { id: 'A1', zone: 'bay', cx: 580, cy: 348, orient: 'N', width: 110 },
  A2: { id: 'A2', zone: 'bay', cx: 452, cy: 366, orient: 'N', width: 110 },
};

/** Every slot of the room, the bay included. */
export const MAX_FLOOR_STATIONS = Object.keys(SLOTS).length;

const ZONE_SLOTS: Record<Exclude<SceneZoneId, 'command'>, SlotId[]> = {
  research: ['L1', 'L2'],
  dev: ['B1', 'B2'],
  review: ['L3', 'F1'],
  bay: ['A1', 'A2'],
  annex: ['F2'],
};
/** Where a member goes when its own zone is full. The Review Bay is never in it. */
export const OVERFLOW_ORDER: readonly SlotId[] = ['F2', 'F1', 'L3', 'B2', 'L2', 'B1', 'L1'];

type MemberRole = NonNullable<OfficeMemberView['role']>;

export function zoneOfRole(role: OfficeMemberView['role']): SceneZoneId {
  switch (role) {
    case 'coordinator': return 'command';
    case 'explorer':
    case 'architect': return 'research';
    case 'implementer': return 'dev';
    case 'reviewer': return 'review';
    case 'advisor': return 'bay';
    default: return 'annex';
  }
}

export function kitOfRole(role: OfficeMemberView['role']): StationKit {
  switch (role) {
    case 'coordinator': return 'console';
    case 'explorer':
    case 'architect': return 'research';
    case 'implementer': return 'dev';
    case 'reviewer': return 'review';
    case 'advisor': return 'bay';
    default: return 'generic';
  }
}

export function visualStateOf(member: Pick<OfficeMemberView, 'principal' | 'waitingUser'>): StationVisualState {
  if (member.principal === 'error') return 'error';
  if (member.waitingUser !== null) return 'waiting';
  if (member.principal === 'working') return 'working';
  return 'idle';
}

export interface SceneStation {
  sessionId: string;
  title: string;
  role: OfficeMemberView['role'];
  /** Role key for CSS accent and equipment ('other' when the member has no role). */
  accent: MemberRole;
  kit: StationKit;
  slot: SlotId;
  /** Zone of the slot the station sits in (differs from the role's zone after an overflow). */
  zone: SceneZoneId;
  orient: SceneOrient;
  cx: number;
  cy: number;
  width: number;
  /** Painter's order: higher is nearer to the viewer. */
  depth: number;
  /** Position in the back-to-front order of the room (1 = farthest back), used as z-index. */
  paintRank: number;
  state: StationVisualState;
  /** principal state straight from the model, for the state label. */
  principal: OfficeMemberView['principal'];
  waitingKinds: OfficeWaitingKind[];
  /** The turn is open but stopped on the user (principal working + waiting marker). */
  stoppedOnYou: boolean;
  isActiveSession: boolean;
  provider: string;
  model?: string;
  effortLevel?: string;
  mission?: string;
  createdBySessionId?: string;
}

/** A member with no slot left: reachable from the strip, with no desk, slot or zone. */
export interface SceneOverflowMember {
  sessionId: string;
  title: string;
  role: OfficeMemberView['role'];
  accent: MemberRole;
  state: StationVisualState;
  principal: OfficeMemberView['principal'];
  waitingKinds: OfficeWaitingKind[];
  isActiveSession: boolean;
}

export interface SceneTile {
  sessionId: string;
  state: StationVisualState;
  accent: MemberRole;
}

export interface RoomScene {
  rootId: string;
  title: string;
  isTeamModeRoot: boolean;
  world: typeof ROOM_WORLD;
  /** Stations on the floor in reading order: the Coordinator first, then the model's order. */
  stations: SceneStation[];
  /** Members beyond the floor slots, in model order; still reachable, drawn as a strip. */
  overflow: SceneOverflowMember[];
  /** One tile per member for the main team display, in model order. */
  tiles: SceneTile[];
  hasBay: boolean;
  workingCount: number;
  waitingUserCount: number;
  errorCount: number;
}

function stationFor(member: OfficeMemberView, slot: SceneSlot): SceneStation {
  const accent: MemberRole = member.role ?? 'other';
  return {
    sessionId: member.sessionId,
    title: member.title,
    role: member.role,
    accent,
    kit: kitOfRole(member.role),
    slot: slot.id,
    zone: slot.zone,
    orient: slot.orient,
    cx: slot.cx,
    cy: slot.cy,
    width: slot.width,
    // The person's side of the desk is nearer to the viewer than its back edge.
    depth: slot.cx + slot.cy + 30,
    paintRank: 0,
    state: visualStateOf(member),
    principal: member.principal,
    waitingKinds: member.waitingUser ?? [],
    stoppedOnYou: member.principal === 'working' && member.waitingUser !== null,
    isActiveSession: member.isActiveSession,
    provider: member.provider,
    model: member.model,
    effortLevel: member.effortLevel,
    // Only the mission the model carries, trimmed; blank means none. Never inferred from the title or messages.
    mission: member.mission?.trim() || undefined,
    createdBySessionId: member.createdBySessionId,
  };
}

function overflowFor(member: OfficeMemberView): SceneOverflowMember {
  return {
    sessionId: member.sessionId,
    title: member.title,
    role: member.role,
    accent: member.role ?? 'other',
    state: visualStateOf(member),
    principal: member.principal,
    waitingKinds: member.waitingUser ?? [],
    isActiveSession: member.isActiveSession,
  };
}

export function buildRoomScene(room: OfficeRoomView): RoomScene {
  const taken = new Set<SlotId>();
  const placed: SceneStation[] = [];
  const overflow: SceneOverflowMember[] = [];
  const take = (id: SlotId): SceneSlot => {
    taken.add(id);
    return SLOTS[id];
  };

  for (const member of room.members) {
    if (member.isRoot) {
      placed.push(stationFor(member, take('C')));
      continue;
    }
    const zone = zoneOfRole(member.role);
    const own = zone === 'command' ? [] : ZONE_SLOTS[zone];
    const free = own.find((id) => !taken.has(id)) ?? OVERFLOW_ORDER.find((id) => !taken.has(id));
    if (free) {
      placed.push(stationFor(member, take(free)));
    } else {
      // No slot left: reachable from the strip, never dropped.
      overflow.push(overflowFor(member));
    }
  }

  // Reading order: the root first, the others as the model lists them (sort is stable).
  const stations = [...placed].sort((a, b) => Number(b.slot === 'C') - Number(a.slot === 'C'));
  // Depth is a separate concern: rank back to front for z-index, ties by reading order.
  [...stations]
    .sort((a, b) => a.depth - b.depth)
    .forEach((station, index) => {
      station.paintRank = index + 1;
    });
  const tiles = room.members.map((member): SceneTile => ({ sessionId: member.sessionId, state: visualStateOf(member), accent: member.role ?? 'other' }));
  return {
    rootId: room.rootId,
    title: room.title,
    isTeamModeRoot: room.isTeamModeRoot,
    world: ROOM_WORLD,
    stations,
    overflow,
    tiles,
    hasBay: stations.some((station) => station.zone === 'bay'),
    workingCount: room.workingCount,
    waitingUserCount: room.waitingUserCount,
    errorCount: room.errorCount,
  };
}

export function buildScenes(rooms: readonly OfficeRoomView[]): RoomScene[] {
  return rooms.map(buildRoomScene);
}
