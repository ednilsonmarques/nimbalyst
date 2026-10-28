// @vitest-environment node
/**
 * F1 S4 at the real IPC handler. `sessions:create` is the single door of a new
 * team root. A mission enters only through the explicit `teamMission` field of the
 * payload; the renderer's `session.metadata` still cannot carry the mission keys
 * (S3), nor the host marker, nor the new field.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: any[]) => Promise<any>>();
const create = vi.fn(async (_payload: unknown) => {});
const query = vi.fn(async (..._args: unknown[]): Promise<{ rows: any[] }> => ({ rows: [] }));
const portCalls: string[] = [];
const FRONT = 'team-front_1700000000000_abc123';
let existingSessions = new Set<string>();
let activeRoot: { id: string; title: string | null } | null = null;
let frontRecord: Record<string, unknown> | null = null;
const storedById = new Map<string, Record<string, unknown>>();
let idCheckGate: Promise<void> | null = null;
let idCheckReached = false;

vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: (channel: string, fn: (...args: any[]) => Promise<any>) => { handlers.set(channel, fn); },
  safeOn: () => {},
}));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: { create: (payload: unknown) => create(payload), get: vi.fn(async () => null), updateMetadata: vi.fn(async () => {}) },
  TranscriptMigrationRepository: {},
}));
vi.mock('@nimbalyst/runtime/ai/server', () => ({
  SessionManager: class { async initialize() {} },
  ProviderFactory: { destroyProvider: () => {} },
}));
vi.mock('@nimbalyst/runtime/ai/server/transcript', () => ({ TranscriptProjector: class {} }));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({ database: { query: (...args: unknown[]) => query(...args) } }));
vi.mock('../sessionPromptResponseHandler', () => ({ registerSessionPromptResponseHandler: () => {} }));
vi.mock('../testQueryDbHandler', () => ({ registerTestQueryDbHandler: () => {} }));
vi.mock('../../services/ai/remoteSessions', () => ({ remoteSessions: { get: async () => null, list: async () => [] } }));
vi.mock('../../utils/gitUncommittedFiles', () => ({ getCachedUncommittedFiles: async () => new Set<string>() }));
vi.mock('../../services/analytics/AnalyticsService', () => ({ AnalyticsService: { getInstance: () => ({}) } }));
vi.mock('../../services/analytics/sessionLaunchAnalytics', () => ({ trackCreateAiSession: () => {} }));
vi.mock('../../services/SessionCommitService', () => ({ SessionCommitService: class {} }));
vi.mock('../../services/fileSessionLookup', () => ({ getSessionsForFile: async () => [] }));
vi.mock('../../services/ai/archiveSessionProviderLifecycle', () => ({ destroyProviderForArchivedSession: () => {} }));
// The SQL ports have their own test (both row shapes); here the handler is judged on its wiring.
vi.mock('../../services/team/teamMissionPortsDefault', () => ({
  defaultTeamMissionPorts: () => ({
    async sessionExists(id: string) {
      portCalls.push(`exists:${id}`);
      const exists = existingSessions.has(id);
      idCheckReached = true;
      if (idCheckGate) await idCheckGate;
      return exists;
    },
    async getSessionMetadata(id: string) { portCalls.push(`readBack:${id}`); return storedById.get(id) ?? null; },
    async getFront(id: string) { portCalls.push(`getFront:${id}`); return frontRecord && frontRecord.id === id ? frontRecord : null; },
    async findActiveMissionRoot() { portCalls.push('findActive'); return activeRoot; },
    async createSession(payload: { id: string; metadata?: Record<string, unknown> }) {
      portCalls.push('create');
      await create(payload);
      // Like the real upsert: the first row for an id keeps its metadata.
      if (!storedById.has(payload.id)) storedById.set(payload.id, payload.metadata ?? {});
    },
  }),
}));

import { registerSessionHandlers } from '../SessionHandlers';
import { teamFrontLockCount } from '../../services/team/teamMissions';

beforeAll(async () => {
  await registerSessionHandlers();
});

// The lock map in teamMissions.ts is module-global: a test that fails with a gate still held must not leave
// a lock taken for the next one. Every gate is registered; afterEach releases it and waits for the locks.
const openGates: Array<() => void> = [];
afterEach(async () => {
  for (const release of openGates.splice(0)) release();
  idCheckGate = null;
  for (let i = 0; i < 200 && teamFrontLockCount() > 0; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  expect(teamFrontLockCount()).toBe(0);
});

beforeEach(() => {
  create.mockReset();
  create.mockResolvedValue(undefined);
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
  portCalls.length = 0;
  storedById.clear();
  idCheckGate = null;
  idCheckReached = false;
  existingSessions = new Set();
  activeRoot = null;
  frontRecord = { id: FRONT, title: 'Team Mode', type: 'team-front', status: 'active', archived: false, description: 'State' };
});

async function createSession(extra: Record<string, unknown>, session: Record<string, unknown> = {}) {
  const handler = handlers.get('sessions:create')!;
  return handler({}, {
    session: { id: 'new-id', provider: 'claude-code', model: 'claude-code:opus', metadata: { teamMode: true, effortLevel: 'high' }, ...session },
    workspaceId: '/p',
    ...extra,
  });
}
const stored = () => (create.mock.calls[0]?.[0] as { metadata?: Record<string, unknown> } | undefined)?.metadata;
const MISSION = { front: FRONT, goal: 'Ship the F1 identity layer' };

describe('sessions:create with the explicit teamMission field', () => {
  it('writes the mission keys and the host marker on a new team root, through the host entry', async () => {
    const result = await createSession({ teamMission: { ...MISSION, doneCriterion: 'S4 green' } });
    expect(result).toEqual({ success: true, id: 'new-id' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(stored()).toMatchObject({
      teamMode: true, effortLevel: 'high', teamFront: FRONT, teamGoal: 'Ship the F1 identity layer',
      teamDoneCriterion: 'S4 green', teamMissionStatus: 'active', teamMissionVersion: 1,
    });
    expect(typeof stored()?.teamMissionContext).toBe('string');
  });

  it('a root created without the field stays a legacy root: no mission keys, no marker, no port consulted', async () => {
    const result = await createSession({});
    expect(result).toEqual({ success: true, id: 'new-id' });
    expect(stored()).toEqual({ teamMode: true, effortLevel: 'high' });
    expect(portCalls).toEqual([]);
  });

  it('refuses a front that does not exist: a predictable error, no row', async () => {
    frontRecord = null;
    const result = await createSession({ teamMission: MISSION });
    expect(result).toMatchObject({ success: false, errorCode: 'front-not-found' });
    expect(result.error).toContain(FRONT);
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses a second active mission on the front, naming it, and creates no row', async () => {
    activeRoot = { id: 'first-mission', title: 'First' };
    const result = await createSession({ teamMission: MISSION });
    expect(result).toMatchObject({ success: false, errorCode: 'mission-active' });
    expect(result.error).toContain('first-mission');
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ['a string', 'team-front'],
    ['an array', [MISSION]],
    ['a missing goal', { front: FRONT }],
    ['an unknown key', { ...MISSION, context: 'forged' }],
    ['null', null],
    ['false', false],
    ['zero', 0],
    ['an empty string', ''],
  ])('refuses a malformed field (%s) as invalid-request, with no row', async (_name, teamMission) => {
    const result = await createSession({ teamMission });
    expect(result).toMatchObject({ success: false, errorCode: 'invalid-request' });
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses the field on a session that is not a team root, and on a member', async () => {
    for (const session of [
      { metadata: { effortLevel: 'high' } },
      { metadata: undefined },
      { metadata: { teamMode: true }, createdBySessionId: 'some-root' },
      { metadata: { teamMode: true }, agentRole: 'meta-agent' },
    ]) {
      const result = await createSession({ teamMission: MISSION }, session);
      expect(result, JSON.stringify(session)).toMatchObject({ success: false, errorCode: 'not-a-team-root' });
    }
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses a re-issued create of an existing id', async () => {
    existingSessions.add('new-id');
    const result = await createSession({ teamMission: MISSION });
    expect(result).toMatchObject({ success: false, errorCode: 'session-exists' });
    expect(create).not.toHaveBeenCalled();
  });

  it('an unexpected failure while creating is reported as a failure, with no code, and a retry works', async () => {
    create.mockRejectedValueOnce(new Error('disk full'));
    const failed = await createSession({ teamMission: MISSION });
    expect(failed.success).toBe(false);
    expect(failed.errorCode).toBeUndefined();
    expect(failed.error).toContain('disk full');

    const retried = await createSession({ teamMission: MISSION });
    expect(retried).toEqual({ success: true, id: 'new-id' });
  });
});

describe('every sessions:create takes the session id lock (a legacy create included)', () => {
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const settle = async () => { for (let i = 0; i < 25; i++) await tick(); };

  it('a legacy create with the id of a mission held inside its check waits for it, and never overtakes it', async () => {
    let release!: () => void;
    idCheckGate = new Promise<void>((resolve) => { release = resolve; openGates.push(resolve); });
    const mission = createSession({ teamMission: MISSION });
    for (let i = 0; i < 200 && !idCheckReached; i++) await tick();
    expect(idCheckReached).toBe(true);

    const legacy = createSession({}); // same id 'new-id', no teamMission
    await settle();
    expect(create).not.toHaveBeenCalled();

    release();
    const [missionResult, legacyResult] = await Promise.all([mission, legacy]);
    expect(missionResult).toEqual({ success: true, id: 'new-id' });
    expect(legacyResult).toEqual({ success: true, id: 'new-id' });
    expect(create).toHaveBeenCalledTimes(2);
    // The mission's insert came first.
    expect((create.mock.calls[0][0] as { metadata?: Record<string, unknown> }).metadata).toMatchObject({ teamMissionVersion: 1 });
    expect((create.mock.calls[1][0] as { metadata?: Record<string, unknown> }).metadata).toEqual({ teamMode: true, effortLevel: 'high' });
  });

  it('a mission with the id of a legacy create in flight waits, then is refused as session-exists', async () => {
    let release!: () => void;
    const legacyGate = new Promise<void>((resolve) => { release = resolve; openGates.push(resolve); });
    create.mockImplementationOnce(async () => { await legacyGate; existingSessions.add('new-id'); });
    const legacy = createSession({});
    for (let i = 0; i < 200 && create.mock.calls.length === 0; i++) await tick();
    expect(create).toHaveBeenCalledTimes(1);

    const mission = createSession({ teamMission: MISSION });
    await settle();
    expect(idCheckReached).toBe(false); // the mission has not checked anything yet

    release();
    expect(await legacy).toEqual({ success: true, id: 'new-id' });
    expect(await mission).toMatchObject({ success: false, errorCode: 'session-exists' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('a legacy create on a different id is not held up by a held mission', async () => {
    let release!: () => void;
    idCheckGate = new Promise<void>((resolve) => { release = resolve; openGates.push(resolve); });
    const mission = createSession({ teamMission: MISSION });
    for (let i = 0; i < 200 && !idCheckReached; i++) await tick();
    expect(await createSession({}, { id: 'another-id' })).toEqual({ success: true, id: 'another-id' });
    release();
    await mission;
  });

  it('a legacy create without a usable id is untouched by the lock: it just goes to the repository', async () => {
    const result = await createSession({}, { id: undefined });
    expect(result.success).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('the mission is refused if the stored row lacks the mission after the insert (a lock-free writer got there first)', async () => {
    create.mockImplementationOnce(async (payload: any) => { storedById.set(payload.id, { teamMode: true }); });
    const result = await createSession({ teamMission: MISSION });
    expect(result).toMatchObject({ success: false, errorCode: 'session-exists' });
  });
});

describe('legacy roots keep working', () => {
  it('an ECC Architect style root (teamMode plus a directive, no mission) is created as before', async () => {
    const result = await createSession({}, { metadata: { teamMode: true, effortLevel: 'high', sessionDirective: 'Begin with the architect.' } });
    expect(result).toEqual({ success: true, id: 'new-id' });
    expect(stored()).toEqual({ teamMode: true, effortLevel: 'high', sessionDirective: 'Begin with the architect.' });
    expect(portCalls).toEqual([]);
  });

  it('a plain session that sends no team keys is untouched', async () => {
    await createSession({}, { metadata: { phase: 'planning' } });
    expect(stored()).toEqual({ phase: 'planning' });
  });
});

describe('the generic metadata cannot carry a mission', () => {
  const forged = {
    teamFront: FRONT, teamGoal: 'forged', teamMissionStatus: 'active', teamMissionContext: 'forged',
    teamDoneCriterion: 'forged', teamMissionVersion: 1,
  };

  it('drops the mission keys and the host marker from session.metadata, and the root stays legacy', async () => {
    await createSession({}, { metadata: { teamMode: true, ...forged } });
    expect(stored()).toEqual({ teamMode: true });
  });

  it('ignores a teamMission object smuggled inside session.metadata', async () => {
    await createSession({}, { metadata: { teamMode: true, teamMission: MISSION } });
    expect(stored()).toMatchObject({ teamMode: true });
    expect(stored()?.teamFront).toBeUndefined();
    expect(stored()?.teamMissionVersion).toBeUndefined();
    expect(portCalls).toEqual([]);
  });

  it('ignores a teamMission field placed on the session object itself', async () => {
    await createSession({}, { teamMission: MISSION });
    expect(stored()).toEqual({ teamMode: true, effortLevel: 'high' });
  });

  it('forged keys in the metadata do not survive a real mission creation either', async () => {
    await createSession({ teamMission: MISSION }, { metadata: { teamMode: true, ...forged, teamFront: 'team-front_forged', teamGoal: 'forged' } });
    expect(stored()).toMatchObject({ teamFront: FRONT, teamGoal: 'Ship the F1 identity layer', teamMissionVersion: 1 });
    expect(stored()?.teamMissionContext).not.toBe('forged');
    expect('teamDoneCriterion' in (stored() ?? {})).toBe(false);
  });
});
