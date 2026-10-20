/**
 * officeScene is a pure projection of an OfficeRoomView: where each member
 * sits and which visual state it shows. Nothing here may be invented.
 */
import { describe, expect, it } from 'vitest';
import type { OfficeMemberView, OfficeRoomView } from '../../office/officeModel';
import {
  MAX_FLOOR_STATIONS,
  OVERFLOW_ORDER,
  SLOTS,
  buildRoomScene,
  buildScenes,
  kitOfRole,
  visualStateOf,
  zoneOfRole,
} from '../officeScene';

function member(id: string, role: OfficeMemberView['role'], overrides: Partial<OfficeMemberView> = {}): OfficeMemberView {
  return {
    sessionId: id,
    title: id,
    role,
    isRoot: role === 'coordinator',
    provider: 'claude-code',
    principal: 'idle',
    waitingUser: null,
    isActiveSession: false,
    ...overrides,
  };
}

function room(members: OfficeMemberView[], rootId = members[0].sessionId): OfficeRoomView {
  return {
    rootId,
    title: 'Equipe',
    isTeamModeRoot: true,
    members,
    workingCount: members.filter((m) => m.principal === 'working' && m.waitingUser === null).length,
    waitingUserCount: members.filter((m) => m.waitingUser !== null).length,
    errorCount: members.filter((m) => m.principal === 'error').length,
  };
}

const lead = () => member('lead', 'coordinator');
const slots = (scene: ReturnType<typeof buildRoomScene>) => Object.fromEntries(scene.stations.map((s) => [s.sessionId, s.slot]));

describe('visual state mapping', () => {
  it('maps working, waiting, error and idle from the model only', () => {
    expect(visualStateOf({ principal: 'working', waitingUser: null })).toBe('working');
    expect(visualStateOf({ principal: 'idle', waitingUser: ['commit'] })).toBe('waiting');
    expect(visualStateOf({ principal: 'working', waitingUser: ['unknown'] })).toBe('waiting');
    expect(visualStateOf({ principal: 'error', waitingUser: null })).toBe('error');
    expect(visualStateOf({ principal: 'idle', waitingUser: null })).toBe('idle');
  });

  it('lets an unseen error win over a waiting marker without hiding the marker', () => {
    const scene = buildRoomScene(room([lead(), member('rev', 'reviewer', { principal: 'error', waitingUser: ['permission'] })]));
    const rev = scene.stations.find((s) => s.sessionId === 'rev')!;
    expect(rev.state).toBe('error');
    expect(rev.waitingKinds).toEqual(['permission']);
  });

  it('marks a turn that is open but stopped on the user', () => {
    const scene = buildRoomScene(room([lead(), member('exp', 'explorer', { principal: 'working', waitingUser: ['unknown'] })]));
    const exp = scene.stations.find((s) => s.sessionId === 'exp')!;
    expect(exp.state).toBe('waiting');
    expect(exp.stoppedOnYou).toBe(true);
    expect(exp.principal).toBe('working');
    // A waiting marker on an idle member is not an open turn.
    const idle = buildRoomScene(room([lead(), member('exp', 'explorer', { waitingUser: ['question'] })])).stations.find((s) => s.sessionId === 'exp')!;
    expect(idle.stoppedOnYou).toBe(false);
  });

  it('carries the active session and the waiting kinds through unchanged', () => {
    const scene = buildRoomScene(room([lead(), member('impl', 'implementer', { waitingUser: ['commit', 'plan'], isActiveSession: true })]));
    const impl = scene.stations.find((s) => s.sessionId === 'impl')!;
    expect(impl.isActiveSession).toBe(true);
    expect(impl.waitingKinds).toEqual(['commit', 'plan']);
  });
});

describe('state and mission', () => {
  it('derives the state from the model fields only: a mission or a title never changes it', () => {
    const base = (overrides: Partial<OfficeMemberView>) => buildRoomScene(room([lead(), member('m', 'explorer', overrides)])).stations.find((s) => s.sessionId === 'm')!;
    const text = 'ERRO aguardando você: working, waiting, error';
    expect(base({ mission: text, title: text }).state).toBe('idle');
    expect(base({ mission: text, title: text, principal: 'working' }).state).toBe('working');
    expect(base({ mission: text, title: text, waitingUser: ['plan'] }).state).toBe('waiting');
    expect(base({ mission: text, title: text, principal: 'error' }).state).toBe('error');
    // The same member with and without a mission lands on the same state and the same slot.
    const withMission = base({ principal: 'working', mission: 'Mapear' });
    const without = base({ principal: 'working' });
    expect([withMission.state, withMission.slot, withMission.zone]).toEqual([without.state, without.slot, without.zone]);
    // visualStateOf reads only the principal state and the waiting marker.
    expect(visualStateOf.toString()).not.toMatch(/mission|title/);
  });

  it('carries the mission trimmed, and nothing when it is blank or absent', () => {
    const scene = buildRoomScene(
      room([lead(), member('a', 'explorer', { mission: '  Mapear regras  ' }), member('b', 'reviewer', { mission: '   ' }), member('c', 'implementer', { title: 'Portar descontos' })]),
    );
    const mission = (id: string) => scene.stations.find((s) => s.sessionId === id)!.mission;
    expect(mission('a')).toBe('Mapear regras');
    expect(mission('b')).toBeUndefined();
    expect(mission('c')).toBeUndefined();
    expect(mission('lead')).toBeUndefined();
  });
});

describe('layout of one room', () => {
  it('seats a lone coordinator at the central console and draws no bay', () => {
    const scene = buildRoomScene(room([lead()]));
    expect(scene.stations).toHaveLength(1);
    expect(scene.stations[0]).toMatchObject({ slot: 'C', zone: 'command', kit: 'console', orient: 'N' });
    expect(scene.hasBay).toBe(false);
    expect(scene.overflow).toEqual([]);
  });

  it('puts each role of the five-member team in its own zone and the advisor in the bay', () => {
    const scene = buildRoomScene(
      room([lead(), member('exp', 'explorer'), member('impl', 'implementer'), member('rev', 'reviewer'), member('adv', 'advisor')]),
    );
    expect(slots(scene)).toEqual({ lead: 'C', exp: 'L1', impl: 'B1', rev: 'L3', adv: 'A1' });
    expect(Object.fromEntries(scene.stations.map((s) => [s.sessionId, s.zone]))).toEqual({
      lead: 'command', exp: 'research', impl: 'dev', rev: 'review', adv: 'bay',
    });
    expect(scene.hasBay).toBe(true);
    expect(scene.stations.find((s) => s.sessionId === 'adv')!.kit).toBe('bay');
  });

  it('lists the stations in reading order (Coordinator first, then the model order) and ranks depth separately', () => {
    const scene = buildRoomScene(
      room([member('exp', 'explorer'), lead(), member('impl', 'implementer'), member('rev', 'reviewer'), member('adv', 'advisor')], 'lead'),
    );
    expect(scene.stations.map((s) => s.sessionId)).toEqual(['lead', 'exp', 'impl', 'rev', 'adv']);
    // paintRank is a back-to-front permutation of 1..n, consistent with depth.
    const ranks = scene.stations.map((s) => s.paintRank);
    expect([...ranks].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    const byRank = [...scene.stations].sort((a, b) => a.paintRank - b.paintRank).map((s) => s.depth);
    expect(byRank).toEqual([...byRank].sort((a, b) => a - b));
  });

  it('gives a repeated role the next slot of its zone', () => {
    const scene = buildRoomScene(room([lead(), member('e1', 'explorer'), member('e2', 'explorer'), member('i1', 'implementer'), member('i2', 'implementer')]));
    expect(slots(scene)).toEqual({ lead: 'C', e1: 'L1', e2: 'L2', i1: 'B1', i2: 'B2' });
  });

  it('seats a team of eight members, every one at its own slot and only advisors in the bay', () => {
    const scene = buildRoomScene(
      room([
        lead(),
        member('e1', 'explorer'),
        member('e2', 'explorer'),
        member('arch', 'architect'),
        member('i1', 'implementer'),
        member('i2', 'implementer'),
        member('rev', 'reviewer'),
        member('adv', 'advisor'),
      ]),
    );
    expect(scene.stations).toHaveLength(8);
    expect(scene.overflow).toEqual([]);
    const taken = scene.stations.map((s) => s.slot);
    expect(new Set(taken).size).toBe(8);
    // The architect shares the research zone, which is full: it takes the first overflow slot.
    expect(slots(scene).arch).toBe(OVERFLOW_ORDER[0]);
    for (const s of scene.stations) if (s.zone === 'bay') expect(s.role).toBe('advisor');
  });

  it('never fills the bay with other roles, even when the team is all one role', () => {
    const members = [lead(), ...Array.from({ length: 7 }, (_, i) => member(`i${i}`, 'implementer'))];
    const scene = buildRoomScene(room(members));
    expect(scene.stations).toHaveLength(8);
    expect(scene.overflow).toEqual([]);
    expect(scene.stations.filter((s) => s.zone === 'bay')).toEqual([]);
    expect(scene.stations.map((s) => s.slot).sort()).toEqual(['B1', 'B2', 'C', 'F1', 'F2', 'L1', 'L2', 'L3']);
  });

  it('seats a third advisor outside the two bay slots', () => {
    const scene = buildRoomScene(room([lead(), member('a1', 'advisor'), member('a2', 'advisor'), member('a3', 'advisor')]));
    expect(slots(scene)).toEqual({ lead: 'C', a1: 'A1', a2: 'A2', a3: OVERFLOW_ORDER[0] });
  });

  it('treats a member without a role as generic and keeps it reachable', () => {
    const scene = buildRoomScene(room([lead(), member('x', null)]));
    const x = scene.stations.find((s) => s.sessionId === 'x')!;
    expect(x).toMatchObject({ role: null, accent: 'other', kit: 'generic', zone: 'annex' });
  });

  it('returns members beyond the floor in overflow with no slot, zone or desk of their own', () => {
    const members = [lead(), ...Array.from({ length: 9 }, (_, i) => member(`m${i}`, 'other'))];
    const scene = buildRoomScene(room(members));
    expect(scene.stations).toHaveLength(8);
    expect(scene.stations.length).toBeLessThan(MAX_FLOOR_STATIONS);
    expect(scene.overflow.map((s) => s.sessionId)).toEqual(['m7', 'm8']);
    expect(scene.stations.length + scene.overflow.length).toBe(members.length);
    for (const item of scene.overflow) {
      expect(Object.keys(item).sort()).toEqual(['accent', 'isActiveSession', 'principal', 'role', 'sessionId', 'state', 'title', 'waitingKinds']);
    }
  });

  it('puts the root at the central console even when it has no Team mode role', () => {
    const scene = buildRoomScene(room([member('root', null, { isRoot: true }), member('child', 'explorer')]));
    expect(slots(scene).root).toBe('C');
    expect(scene.stations.find((s) => s.sessionId === 'root')!.role).toBeNull();
  });
});

describe('what the scene carries', () => {
  it('copies mission, model and creator from the member and invents none of them', () => {
    const scene = buildRoomScene(
      room([
        lead(),
        member('a', 'explorer', { mission: 'Mapear', model: 'claude-code:sonnet', effortLevel: 'high', createdBySessionId: 'lead' }),
        member('b', 'reviewer'),
      ]),
    );
    const a = scene.stations.find((s) => s.sessionId === 'a')!;
    const b = scene.stations.find((s) => s.sessionId === 'b')!;
    expect(a).toMatchObject({ mission: 'Mapear', model: 'claude-code:sonnet', effortLevel: 'high', createdBySessionId: 'lead' });
    expect(b.mission).toBeUndefined();
    expect(b.model).toBeUndefined();
    expect(b.waitingKinds).toEqual([]);
  });

  it('builds one display tile per member in model order, with its state and accent', () => {
    const scene = buildRoomScene(room([lead(), member('e', 'explorer', { principal: 'working' }), member('r', 'reviewer', { principal: 'error' })]));
    expect(scene.tiles).toEqual([
      { sessionId: 'lead', state: 'idle', accent: 'coordinator' },
      { sessionId: 'e', state: 'working', accent: 'explorer' },
      { sessionId: 'r', state: 'error', accent: 'reviewer' },
    ]);
  });

  it('passes the room counters and title straight through', () => {
    const r = room([lead(), member('e', 'explorer', { principal: 'working' }), member('i', 'implementer', { waitingUser: ['commit'] })]);
    const scene = buildRoomScene(r);
    expect(scene).toMatchObject({ rootId: 'lead', title: 'Equipe', workingCount: 1, waitingUserCount: 1, errorCount: 0 });
  });

  it('is pure: same input, same scene, and the input is not mutated', () => {
    const r = room([lead(), member('e', 'explorer', { principal: 'working' }), member('adv', 'advisor')]);
    const frozen = JSON.stringify(r);
    const a = buildRoomScene(r);
    const b = buildRoomScene(r);
    expect(a).toEqual(b);
    expect(JSON.stringify(r)).toBe(frozen);
  });

  it('lays out several teams independently', () => {
    const one = room([lead(), member('e', 'explorer')], 'lead');
    const two = room([member('lead2', 'coordinator'), member('e', 'explorer')], 'lead2');
    const scenes = buildScenes([one, two]);
    expect(scenes.map((s) => s.rootId)).toEqual(['lead', 'lead2']);
    // The same role takes the same first slot in each room.
    expect(scenes.map((s) => s.stations.find((st) => st.sessionId === 'e')!.slot)).toEqual(['L1', 'L1']);
  });
});

describe('zones and equipment by role', () => {
  it('maps every role to a zone and a kit', () => {
    expect(zoneOfRole('coordinator')).toBe('command');
    expect(zoneOfRole('explorer')).toBe('research');
    expect(zoneOfRole('architect')).toBe('research');
    expect(zoneOfRole('implementer')).toBe('dev');
    expect(zoneOfRole('reviewer')).toBe('review');
    expect(zoneOfRole('advisor')).toBe('bay');
    expect(zoneOfRole('other')).toBe('annex');
    expect(zoneOfRole(null)).toBe('annex');
    expect(kitOfRole('implementer')).toBe('dev');
    expect(kitOfRole('advisor')).toBe('bay');
  });

  it('keeps the bay slots inside the bay and out of the overflow order', () => {
    expect(SLOTS.A1.zone).toBe('bay');
    expect(SLOTS.A2.zone).toBe('bay');
    expect(OVERFLOW_ORDER).not.toContain('A1');
    expect(OVERFLOW_ORDER).not.toContain('A2');
    expect(OVERFLOW_ORDER).not.toContain('C');
  });
});
