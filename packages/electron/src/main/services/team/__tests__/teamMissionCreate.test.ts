// @vitest-environment node
/**
 * F1 S4 (M-3 teamMissionCreate): creating a mission root. The main validates the
 * front the renderer names, refuses a second active mission on the same front
 * under a per-front lock, writes the mission keys through the host entry, and
 * leaves no row when it refuses before the insert or the insert fails (a failure
 * AFTER the insert is not undone: see the doc of createTeamMissionRoot). Ports
 * are in-memory fakes whose
 * every call yields to the event loop, so concurrent creations really interleave.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CreateSessionPayload } from '@nimbalyst/runtime/ai/adapters/sessionStore';
import { isHostMissionRoot } from '@nimbalyst/runtime/ai/server/providers/teamContext';
import {
  TEAM_MISSION_DONE_CRITERION_MAX_CHARS,
  TEAM_MISSION_FRONT_ID_MAX_CHARS,
  TEAM_MISSION_GOAL_MAX_CHARS,
  TeamMissionError,
  createTeamMissionRoot,
  parseTeamMissionRequest,
  teamFrontLockCount,
  type TeamFrontRecord,
  type TeamMissionPorts,
} from '../teamMissions';

const WORKSPACE = '/ws/project';
const FRONT = 'team-front_1700000000000_abc123';
const OTHER_FRONT = 'team-front_1700000000001_def456';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
/** Yield until `condition` holds (bounded), so a test never depends on how many ticks a step takes. */
/**
 * Test isolation: the lock map in teamMissions.ts is module-global, so a test that fails while one of its
 * gates is still held would leave a lock taken and contaminate the next tests (10 s timeouts, a lock count
 * of 1). Every gate is registered here; afterEach releases whatever is still open, lets the parked work
 * finish, and checks that no lock is left.
 */
const openGates: Array<() => void> = [];
function newGate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  openGates.push(release);
  return { promise, release };
}
afterEach(async () => {
  for (const release of openGates.splice(0)) release();
  for (let i = 0; i < 200 && teamFrontLockCount() > 0; i++) await flush();
  expect(teamFrontLockCount()).toBe(0);
});
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await flush();
  expect(condition()).toBe(true);
}
/** Let everything that can run, run: a parked creation has nothing left to do but wait. */
async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await flush();
}

interface StoredSession { id: string; title: string; metadata: Record<string, unknown>; archived: boolean }

function front(overrides: Partial<TeamFrontRecord> = {}): TeamFrontRecord {
  return {
    id: FRONT, title: 'Team Mode', type: 'team-front', status: 'active', archived: false,
    description: 'Goal: lifecycle. Authority: ESTADO.md', ...overrides,
  };
}

function makeWorld(initialFronts: TeamFrontRecord[] = [front(), front({ id: OTHER_FRONT, title: 'Portal' })]) {
  const fronts = new Map<string, TeamFrontRecord>(initialFronts.map((f) => [f.id, f]));
  const sessions = new Map<string, StoredSession>();
  const calls: string[] = [];
  const hooks: {
    beforeCreate?: (payload: CreateSessionPayload) => Promise<void>;
    failGetFront?: Error | null;
    failCreate?: Error | null;
  } = {};

  const ports: TeamMissionPorts = {
    async sessionExists(sessionId) {
      calls.push(`exists:${sessionId}`);
      await flush();
      return sessions.has(sessionId);
    },
    async getSessionMetadata(sessionId) {
      calls.push(`readBack:${sessionId}`);
      await flush();
      return sessions.get(sessionId)?.metadata ?? null;
    },
    async getFront(frontId, workspaceId) {
      calls.push(`getFront:${frontId}`);
      await flush();
      if (hooks.failGetFront) throw hooks.failGetFront;
      if (workspaceId !== WORKSPACE) return null;
      return fronts.get(frontId) ?? null;
    },
    async findActiveMissionRoot(frontId) {
      calls.push(`findActive:${frontId}`);
      await flush();
      for (const session of sessions.values()) {
        const m = session.metadata;
        if (session.archived || m.teamFront !== frontId || !isHostMissionRoot(m) || m.teamMissionStatus === 'closed') continue;
        return { id: session.id, title: session.title };
      }
      return null;
    },
    async createSession(payload) {
      calls.push(`create:start:${payload.id}`);
      await hooks.beforeCreate?.(payload);
      await flush();
      if (hooks.failCreate) throw hooks.failCreate;
      // Like the real upsert: an id that already exists keeps its stored row and metadata, and the call succeeds.
      if (!sessions.has(payload.id)) {
        sessions.set(payload.id, { id: payload.id, title: payload.title ?? '', metadata: { ...(payload.metadata ?? {}) }, archived: false });
      }
      calls.push(`create:done:${payload.id}`);
    },
  };
  return { fronts, sessions, calls, hooks, ports };
}

function payload(id: string, overrides: Partial<CreateSessionPayload> = {}): CreateSessionPayload {
  return {
    id, provider: 'claude-code', model: 'claude-code:opus', title: `Mission ${id}`, workspaceId: WORKSPACE, agentRole: 'standard',
    metadata: { teamMode: true, effortLevel: 'high' },
    ...overrides,
  };
}

const request = (overrides: Record<string, unknown> = {}) => ({ front: FRONT, goal: 'Ship the F1 identity layer', ...overrides });
const deps = { policyFiles: () => ['CLAUDE.md'] };

async function refusal(promise: Promise<unknown>): Promise<TeamMissionError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(TeamMissionError);
    return error as TeamMissionError;
  }
  throw new Error('expected the creation to be refused');
}

describe('parseTeamMissionRequest: the shape of the explicit payload field', () => {
  it('accepts a front and a goal, trims them, and leaves a blank done criterion out', () => {
    expect(parseTeamMissionRequest({ front: `  ${FRONT} `, goal: '  Ship it  ', doneCriterion: '   ' })).toEqual({ front: FRONT, goal: 'Ship it' });
    expect(parseTeamMissionRequest({ front: FRONT, goal: 'g', doneCriterion: ' S4 green ' })).toEqual({ front: FRONT, goal: 'g', doneCriterion: 'S4 green' });
    expect(parseTeamMissionRequest({ front: FRONT, goal: 'g', doneCriterion: null })).toEqual({ front: FRONT, goal: 'g' });
  });

  it.each([
    ['not an object', 'front'],
    ['an array', [FRONT]],
    ['null', null],
    ['a number', 7],
  ])('refuses %s', (_name, raw) => {
    expect(() => parseTeamMissionRequest(raw)).toThrow(TeamMissionError);
  });

  it.each([
    ['a missing front', { goal: 'g' }],
    ['an empty front', { front: '', goal: 'g' }],
    ['a blank front', { front: '   ', goal: 'g' }],
    ['a non-string front', { front: 7, goal: 'g' }],
    ['an object front', { front: { id: FRONT }, goal: 'g' }],
    ['a front with a space', { front: 'team front', goal: 'g' }],
    ['a front with a path separator', { front: '../team-front_1', goal: 'g' }],
    ['a front with a quote', { front: "team-front_1'--", goal: 'g' }],
    ['a front with a newline', { front: 'team-front_1\nx', goal: 'g' }],
    ['an urn', { front: 'nimbalyst://NIB.130', goal: 'g' }],
    ['an oversized front', { front: 'a'.repeat(TEAM_MISSION_FRONT_ID_MAX_CHARS + 1), goal: 'g' }],
    ['a missing goal', { front: FRONT }],
    ['an empty goal', { front: FRONT, goal: '' }],
    ['a blank goal', { front: FRONT, goal: '  \n ' }],
    ['a non-string goal', { front: FRONT, goal: 7 }],
    ['an oversized goal', { front: FRONT, goal: 'g'.repeat(TEAM_MISSION_GOAL_MAX_CHARS + 1) }],
    ['a non-string done criterion', { front: FRONT, goal: 'g', doneCriterion: 7 }],
    ['an oversized done criterion', { front: FRONT, goal: 'g', doneCriterion: 'd'.repeat(TEAM_MISSION_DONE_CRITERION_MAX_CHARS + 1) }],
    ['an unknown key (the context is the host\'s)', { front: FRONT, goal: 'g', context: 'forged' }],
    ['a status key (the status is the host\'s)', { front: FRONT, goal: 'g', status: 'closed' }],
  ])('refuses %s with an invalid-request error', (_name, raw) => {
    try {
      parseTeamMissionRequest(raw);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(TeamMissionError);
      expect((error as TeamMissionError).code).toBe('invalid-request');
    }
  });

  it('accepts the largest allowed values', () => {
    const parsed = parseTeamMissionRequest({
      front: 'a'.repeat(TEAM_MISSION_FRONT_ID_MAX_CHARS),
      goal: 'g'.repeat(TEAM_MISSION_GOAL_MAX_CHARS),
      doneCriterion: 'd'.repeat(TEAM_MISSION_DONE_CRITERION_MAX_CHARS),
    });
    expect(parsed.goal).toHaveLength(TEAM_MISSION_GOAL_MAX_CHARS);
  });
});

describe('front validation in the main', () => {
  it('creates the mission for an existing, active team-front of the workspace', async () => {
    const world = makeWorld();
    await createTeamMissionRoot({ payload: payload('m1'), request: request() }, world.ports, deps);
    expect(world.sessions.has('m1')).toBe(true);
  });

  it('refuses a front that does not exist, naming what to do, and writes nothing', async () => {
    const world = makeWorld();
    const error = await refusal(createTeamMissionRoot({ payload: payload('m1'), request: request({ front: 'team-front_missing' }) }, world.ports, deps));
    expect(error.code).toBe('front-not-found');
    expect(error.message).toMatch(/team-front_missing/);
    expect(world.sessions.size).toBe(0);
    expect(world.calls.some((c) => c.startsWith('create:'))).toBe(false);
  });

  it('refuses an issue key or local number: only the item id names a front', async () => {
    const world = makeWorld();
    for (const reference of ['NIB.130', 'WOK.1']) {
      const error = await refusal(createTeamMissionRoot({ payload: payload('m1'), request: request({ front: reference }) }, world.ports, deps));
      expect(error.code, reference).toBe('front-not-found');
    }
    expect(world.sessions.size).toBe(0);
  });

  it('refuses an item that is not a team-front', async () => {
    const world = makeWorld([front({ type: 'team-note' })]);
    const error = await refusal(createTeamMissionRoot({ payload: payload('m1'), request: request() }, world.ports, deps));
    expect(error.code).toBe('front-unavailable');
    expect(world.sessions.size).toBe(0);
  });

  it.each([
    ['archived', { archived: true }],
    ['closed', { status: 'closed' }],
    ['paused', { status: 'paused' }],
    ['without a status', { status: null }],
    ['with an unknown status', { status: 'weird' }],
  ])('refuses a front that is %s', async (_name, overrides) => {
    const world = makeWorld([front(overrides as Partial<TeamFrontRecord>)]);
    const error = await refusal(createTeamMissionRoot({ payload: payload('m1'), request: request() }, world.ports, deps));
    expect(error.code).toBe('front-unavailable');
    expect(error.message).toMatch(/Team Mode/);
    expect(world.sessions.size).toBe(0);
  });

  it('does not see a front of another workspace', async () => {
    const world = makeWorld();
    const error = await refusal(createTeamMissionRoot({ payload: payload('m1', { workspaceId: '/ws/other' }), request: request() }, world.ports, deps));
    expect(error.code).toBe('front-not-found');
  });
});

describe('what the host writes', () => {
  it('sets the front (as stored), goal, active status, the marker and the context, and keeps the rest of the row', async () => {
    const world = makeWorld();
    let written: CreateSessionPayload | undefined;
    world.hooks.beforeCreate = async (p) => { written = p; };
    await createTeamMissionRoot({ payload: payload('m1'), request: request({ doneCriterion: 'S4 green' }) }, world.ports, deps);

    expect(written).toMatchObject({ id: 'm1', provider: 'claude-code', model: 'claude-code:opus', workspaceId: WORKSPACE, agentRole: 'standard' });
    expect(written?.metadata).toMatchObject({
      teamMode: true, effortLevel: 'high',
      teamFront: FRONT, teamGoal: 'Ship the F1 identity layer', teamDoneCriterion: 'S4 green',
      teamMissionStatus: 'active', teamMissionVersion: 1,
    });
    expect(typeof written?.metadata?.teamMissionContext).toBe('string');
    expect(written?.metadata?.teamMissionContext as string).toContain('Team Mode');
    expect(isHostMissionRoot(written?.metadata)).toBe(true);
  });

  it('discards mission keys already in the payload metadata, whatever they say', async () => {
    const world = makeWorld();
    let written: CreateSessionPayload | undefined;
    world.hooks.beforeCreate = async (p) => { written = p; };
    const forged = { teamMode: true, teamFront: 'team-front_forged', teamGoal: 'forged', teamMissionStatus: 'closed', teamMissionContext: 'forged', teamDoneCriterion: 'forged', teamMissionVersion: 7 };
    await createTeamMissionRoot({ payload: payload('m1', { metadata: forged }), request: request() }, world.ports, deps);
    expect(written?.metadata).toMatchObject({ teamFront: FRONT, teamGoal: 'Ship the F1 identity layer', teamMissionStatus: 'active', teamMissionVersion: 1 });
    expect('teamDoneCriterion' in (written?.metadata ?? {})).toBe(false);
    expect(written?.metadata?.teamMissionContext).not.toBe('forged');
  });

  it('does not mutate the payload it was given', async () => {
    const world = makeWorld();
    const input = payload('m1');
    const snapshot = JSON.parse(JSON.stringify(input));
    await createTeamMissionRoot({ payload: input, request: request() }, world.ports, deps);
    expect(input).toEqual(snapshot);
  });
});

describe('only a brand-new team root can be a mission', () => {
  it.each([
    ['a session that is not a team root', { metadata: { effortLevel: 'high' } }],
    ['a session without metadata', { metadata: undefined }],
    ['teamMode false', { metadata: { teamMode: false } }],
    ['a member (createdBySessionId set)', { createdBySessionId: 'root' }],
    ['a non-standard role', { agentRole: 'meta-agent' as const }],
  ])('refuses %s, before touching any port', async (_name, overrides) => {
    const world = makeWorld();
    const error = await refusal(createTeamMissionRoot({ payload: payload('m1', overrides as Partial<CreateSessionPayload>), request: request() }, world.ports, deps));
    expect(error.code).toBe('not-a-team-root');
    expect(world.calls).toEqual([]);
    expect(world.sessions.size).toBe(0);
  });

  it.each([
    ['a missing session id', { id: undefined as unknown as string }],
    ['an empty session id', { id: '' }],
    ['a non-string session id', { id: 7 as unknown as string }],
    ['a missing workspace', { workspaceId: '' }],
  ])('refuses %s as an invalid request, before touching any port', async (_name, overrides) => {
    const world = makeWorld();
    const error = await refusal(createTeamMissionRoot({ payload: payload('m1', overrides as Partial<CreateSessionPayload>), request: request() }, world.ports, deps));
    expect(error.code).toBe('invalid-request');
    expect(world.calls).toEqual([]);
  });

  it('refuses a session id that already exists: a re-issued create is not a new mission', async () => {
    const world = makeWorld();
    await createTeamMissionRoot({ payload: payload('m1'), request: request() }, world.ports, deps);
    const before = JSON.parse(JSON.stringify([...world.sessions.values()]));
    const error = await refusal(createTeamMissionRoot({ payload: payload('m1'), request: request({ front: OTHER_FRONT }) }, world.ports, deps));
    expect(error.code).toBe('session-exists');
    expect([...world.sessions.values()]).toEqual(before);
  });

  it('an invalid request is refused before any port is touched', async () => {
    const world = makeWorld();
    await refusal(createTeamMissionRoot({ payload: payload('m1'), request: { front: FRONT } }, world.ports, deps));
    expect(world.calls).toEqual([]);
  });
});

describe('one active mission per front', () => {
  it('refuses a second creation on the same front, naming the front and the active mission', async () => {
    const world = makeWorld();
    await createTeamMissionRoot({ payload: payload('m1'), request: request() }, world.ports, deps);
    const error = await refusal(createTeamMissionRoot({ payload: payload('m2'), request: request() }, world.ports, deps));
    expect(error.code).toBe('mission-active');
    expect(error.message).toContain('Team Mode');
    expect(error.message).toContain(FRONT);
    expect(error.message).toContain('m1');
    expect(world.sessions.has('m2')).toBe(false);
    expect([...world.sessions.values()].filter((s) => s.metadata.teamFront === FRONT)).toHaveLength(1);
  });

  it('different fronts are independent', async () => {
    const world = makeWorld();
    await createTeamMissionRoot({ payload: payload('m1'), request: request() }, world.ports, deps);
    await createTeamMissionRoot({ payload: payload('m2'), request: request({ front: OTHER_FRONT }) }, world.ports, deps);
    expect(world.sessions.size).toBe(2);
  });

  it('an archived mission root frees the front', async () => {
    const world = makeWorld();
    await createTeamMissionRoot({ payload: payload('m1'), request: request() }, world.ports, deps);
    world.sessions.get('m1')!.archived = true;
    await createTeamMissionRoot({ payload: payload('m2'), request: request() }, world.ports, deps);
    expect(world.sessions.has('m2')).toBe(true);
  });

  it('a closed mission (written by the host in F2) frees the front', async () => {
    const world = makeWorld();
    await createTeamMissionRoot({ payload: payload('m1'), request: request() }, world.ports, deps);
    world.sessions.get('m1')!.metadata.teamMissionStatus = 'closed';
    await createTeamMissionRoot({ payload: payload('m2'), request: request() }, world.ports, deps);
    expect(world.sessions.has('m2')).toBe(true);
  });

  it('a legacy root, or one with a front stored before S3 (no host marker), does not occupy the front', async () => {
    const world = makeWorld();
    world.sessions.set('legacy', { id: 'legacy', title: 'old', metadata: { teamMode: true }, archived: false });
    world.sessions.set('preS3', { id: 'preS3', title: 'forged', metadata: { teamMode: true, teamFront: FRONT, teamGoal: 'g', teamMissionStatus: 'active' }, archived: false });
    await createTeamMissionRoot({ payload: payload('m1'), request: request() }, world.ports, deps);
    expect(world.sessions.has('m1')).toBe(true);
    // And the pre-S3 row is exactly as it was: nothing was rewritten.
    expect(world.sessions.get('preS3')!.metadata).toEqual({ teamMode: true, teamFront: FRONT, teamGoal: 'g', teamMissionStatus: 'active' });
    expect(world.sessions.get('legacy')!.metadata).toEqual({ teamMode: true });
  });

  it('a paused or closed front blocks the creation even when no mission is active', async () => {
    const world = makeWorld([front({ status: 'paused' })]);
    await refusal(createTeamMissionRoot({ payload: payload('m1'), request: request() }, world.ports, deps));
    expect(world.sessions.size).toBe(0);
  });
});

describe('concurrent creations on the same front (deterministic interleaving)', () => {
  it('exactly one wins, the other gets the predictable refusal, and no second row appears', async () => {
    const world = makeWorld();
    const { promise: gate, release: releaseFirst } = newGate();
    world.hooks.beforeCreate = async (p) => { if (p.id === 'mission-a') await gate; };

    const first = createTeamMissionRoot({ payload: payload('mission-a'), request: request() }, world.ports, deps).then(() => 'ok', (e) => e);
    // The first creation is parked inside its insert, past both checks.
    await until(() => world.calls.includes('create:start:mission-a'));
    const second = createTeamMissionRoot({ payload: payload('mission-b'), request: request() }, world.ports, deps).then(() => 'ok', (e) => e);
    await settle();

    // The second one has not even read the front: it waits for the front's lock.
    expect(world.calls.filter((c) => c === `getFront:${FRONT}`)).toHaveLength(1);
    expect(world.calls).not.toContain('create:start:mission-b');

    releaseFirst();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe('ok');
    expect(b).toBeInstanceOf(TeamMissionError);
    expect((b as TeamMissionError).code).toBe('mission-active');
    expect((b as TeamMissionError).message).toContain('mission-a');
    expect([...world.sessions.keys()]).toEqual(['mission-a']);
    expect(teamFrontLockCount()).toBe(0);
  });

  it('many creations started together: exactly one row for the front', async () => {
    const world = makeWorld();
    const ids = ['c1', 'c2', 'c3', 'c4', 'c5'];
    const results = await Promise.allSettled(ids.map((id) => createTeamMissionRoot({ payload: payload(id), request: request() }, world.ports, deps)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const result of results.filter((r) => r.status === 'rejected')) {
      expect(((result as PromiseRejectedResult).reason as TeamMissionError).code).toBe('mission-active');
    }
    expect(world.sessions.size).toBe(1);
  });

  it('a creation on another front is not held up by a parked one', async () => {
    const world = makeWorld();
    const { promise: gate, release: releaseFirst } = newGate();
    world.hooks.beforeCreate = async (p) => { if (p.id === 'a') await gate; };

    const parked = createTeamMissionRoot({ payload: payload('a'), request: request() }, world.ports, deps);
    await until(() => world.calls.includes('create:start:a'));
    await createTeamMissionRoot({ payload: payload('b'), request: request({ front: OTHER_FRONT }) }, world.ports, deps);
    expect(world.sessions.has('b')).toBe(true);
    expect(world.sessions.has('a')).toBe(false);
    releaseFirst();
    await parked;
    expect(world.sessions.size).toBe(2);
  });
});

describe('the same session id on different fronts (the renderer chooses the id)', () => {
  it('exactly one wins and keeps its front; the other is refused, not told it succeeded', async () => {
    const world = makeWorld();
    const results = await Promise.allSettled([
      createTeamMissionRoot({ payload: payload('same-id'), request: request({ front: FRONT }) }, world.ports, deps),
      createTeamMissionRoot({ payload: payload('same-id'), request: request({ front: OTHER_FRONT }) }, world.ports, deps),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    const reason = (results[1] as PromiseRejectedResult).reason as TeamMissionError;
    expect(reason).toBeInstanceOf(TeamMissionError);
    expect(reason.code).toBe('session-exists');
    expect(world.sessions.size).toBe(1);
    expect(world.sessions.get('same-id')?.metadata).toMatchObject({ teamFront: FRONT, teamMissionVersion: 1 });
    expect(teamFrontLockCount()).toBe(0);
  });

  it('many creations with one id on many fronts: one row, one success', async () => {
    const fronts = ['f1', 'f2', 'f3', 'f4'].map((id) => front({ id, title: id }));
    const world = makeWorld(fronts);
    const results = await Promise.allSettled(fronts.map((f) =>
      createTeamMissionRoot({ payload: payload('same-id'), request: request({ front: f.id }) }, world.ports, deps)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) expect(((r as PromiseRejectedResult).reason as TeamMissionError).code).toBe('session-exists');
    expect(world.sessions.size).toBe(1);
    expect(teamFrontLockCount()).toBe(0);
  });

  it('opposite orders cannot deadlock: A(id1, front1) with B(id2, front1) and C(id1, front2) all settle', async () => {
    const world = makeWorld();
    const settled = await Promise.race([
      Promise.allSettled([
        createTeamMissionRoot({ payload: payload('id1'), request: request({ front: FRONT }) }, world.ports, deps),
        createTeamMissionRoot({ payload: payload('id2'), request: request({ front: FRONT }) }, world.ports, deps),
        createTeamMissionRoot({ payload: payload('id1'), request: request({ front: OTHER_FRONT }) }, world.ports, deps),
      ]),
      new Promise<'stuck'>((resolve) => setTimeout(() => resolve('stuck'), 2000)),
    ]);
    expect(settled).not.toBe('stuck');
    expect(world.sessions.size).toBe(1);
    expect(teamFrontLockCount()).toBe(0);
  });
});

describe('characterization: two roots already active on one front (the un-archive effect)', () => {
  // Un-archiving an old mission root after a newer one took the front leaves two active roots.
  // S4 does not guard the un-archive path (reopen is F2/F3, design section 6); it guarantees the
  // creation path refuses, naming the OLDEST one, and never makes the situation worse.
  it('a new creation is refused and names the oldest active root', async () => {
    const world = makeWorld();
    const host = { teamMode: true, teamFront: FRONT, teamMissionStatus: 'active', teamMissionVersion: 1 };
    world.sessions.set('oldest-root', { id: 'oldest-root', title: 'Old', metadata: { ...host }, archived: false });
    world.sessions.set('newer-root', { id: 'newer-root', title: 'New', metadata: { ...host }, archived: false });
    const error = await refusal(createTeamMissionRoot({ payload: payload('m3'), request: request() }, world.ports, deps));
    expect(error.code).toBe('mission-active');
    expect(error.message).toContain('oldest-root');
    expect(error.message).not.toContain('newer-root');
    expect(world.sessions.has('m3')).toBe(false);
  });
});

describe('the row is verified after the insert (the guarantee does not rest on lock coverage alone)', () => {
  it('a legacy row written with the same id between the check and the insert refuses the mission: the upsert kept the legacy row', async () => {
    const world = makeWorld();
    world.hooks.beforeCreate = async (p) => {
      // A writer outside the lock gets in after the id check and before the mission's insert.
      world.sessions.set(p.id, { id: p.id, title: 'legacy', metadata: { teamMode: true }, archived: false });
    };
    const error = await refusal(createTeamMissionRoot({ payload: payload('m1'), request: request() }, world.ports, deps));
    expect(error.code).toBe('session-exists');
    expect(world.sessions.get('m1')?.metadata).toEqual({ teamMode: true });
    expect(teamFrontLockCount()).toBe(0);
  });

  it('a row that carries a mission of ANOTHER front is refused too', async () => {
    const world = makeWorld();
    world.hooks.beforeCreate = async (p) => {
      world.sessions.set(p.id, { id: p.id, title: 'other', metadata: { teamMode: true, teamFront: OTHER_FRONT, teamMissionVersion: 1, teamMissionStatus: 'active' }, archived: false });
    };
    const error = await refusal(createTeamMissionRoot({ payload: payload('m1'), request: request() }, world.ports, deps));
    expect(error.code).toBe('session-exists');
  });

  it('a row that vanished after the insert is refused, not reported as created', async () => {
    const world = makeWorld();
    const insert = world.ports.createSession;
    world.ports.createSession = async (p) => { await insert(p); world.sessions.delete(p.id); };
    const error = await refusal(createTeamMissionRoot({ payload: payload('m1'), request: request() }, world.ports, deps));
    expect(error.code).toBe('session-exists');
  });

  it('reads the row back exactly once, after the insert, on success', async () => {
    const world = makeWorld();
    await createTeamMissionRoot({ payload: payload('m1'), request: request() }, world.ports, deps);
    expect(world.calls.filter((c) => c === 'readBack:m1')).toHaveLength(1);
    expect(world.calls.indexOf('readBack:m1')).toBeGreaterThan(world.calls.indexOf('create:done:m1'));
  });
});

describe('a refusal before the insert, or a failing insert, leaves no row and no lock', () => {
  it('a failing insert leaves no row and releases the lock; a retry succeeds', async () => {
    const world = makeWorld();
    world.hooks.failCreate = new Error('disk full');
    await expect(createTeamMissionRoot({ payload: payload('m1'), request: request() }, world.ports, deps)).rejects.toThrow('disk full');
    expect(world.sessions.size).toBe(0);
    expect(teamFrontLockCount()).toBe(0);

    world.hooks.failCreate = null;
    await createTeamMissionRoot({ payload: payload('m1'), request: request() }, world.ports, deps);
    expect(world.sessions.has('m1')).toBe(true);
  });

  it('a failing read of the front releases the lock and writes nothing', async () => {
    const world = makeWorld();
    world.hooks.failGetFront = new Error('database locked');
    await expect(createTeamMissionRoot({ payload: payload('m1'), request: request() }, world.ports, deps)).rejects.toThrow('database locked');
    expect(world.sessions.size).toBe(0);
    expect(teamFrontLockCount()).toBe(0);
    world.hooks.failGetFront = null;
    await createTeamMissionRoot({ payload: payload('m1'), request: request() }, world.ports, deps);
    expect(world.sessions.size).toBe(1);
  });

  it('a creation queued behind a failed one proceeds and wins', async () => {
    const world = makeWorld();
    const { promise: gate, release: releaseFirst } = newGate();
    world.hooks.beforeCreate = async (p) => {
      if (p.id === 'a') { await gate; throw new Error('insert failed'); }
    };
    const first = createTeamMissionRoot({ payload: payload('a'), request: request() }, world.ports, deps).then(() => 'ok', (e) => e);
    await until(() => world.calls.includes('create:start:a'));
    const second = createTeamMissionRoot({ payload: payload('b'), request: request() }, world.ports, deps).then(() => 'ok', (e) => e);
    await settle();
    expect(world.calls).not.toContain('create:start:b');
    releaseFirst();
    const [a, b] = await Promise.all([first, second]);
    expect((a as Error).message).toBe('insert failed');
    expect(b).toBe('ok');
    expect([...world.sessions.keys()]).toEqual(['b']);
    expect(teamFrontLockCount()).toBe(0);
  });

  it('a refusal also releases the lock', async () => {
    const world = makeWorld();
    await refusal(createTeamMissionRoot({ payload: payload('m1'), request: request({ front: 'team-front_missing' }) }, world.ports, deps));
    expect(teamFrontLockCount()).toBe(0);
  });

  it('never swallows an unexpected error as a refusal', async () => {
    const world = makeWorld();
    const boom = new TypeError('boom');
    world.ports.sessionExists = vi.fn(async () => { throw boom; });
    await expect(createTeamMissionRoot({ payload: payload('m1'), request: request() }, world.ports, deps)).rejects.toBe(boom);
  });
});
