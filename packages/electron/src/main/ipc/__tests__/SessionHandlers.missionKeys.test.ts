// @vitest-environment node
/**
 * F1 S3 at the real IPC handlers. The renderer's `sessions:create` is the ONLY
 * barrier for the mission keys of a NEW session id (the store does not strip
 * creation-only keys on a first create), so it is tested here through the real
 * handler, not through the sanitizer alone. `sessions:list-children` is the
 * other renderer-facing projection of a session row's metadata.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: any[]) => Promise<any>>();
const create = vi.fn(async (_payload: unknown) => {});
const query = vi.fn(async (..._args: unknown[]): Promise<{ rows: any[] }> => ({ rows: [] }));

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

import { registerSessionHandlers } from '../SessionHandlers';

const MISSION_KEYS = {
  teamFront: 'x',
  teamGoal: 'g',
  teamMissionStatus: 'closed',
  teamMissionContext: 'c',
  teamDoneCriterion: 'd',
  teamMissionVersion: 1,
};

beforeAll(async () => {
  await registerSessionHandlers();
});

beforeEach(() => {
  create.mockClear();
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
});

async function createWith(metadata: Record<string, unknown>) {
  const handler = handlers.get('sessions:create')!;
  const result = await handler({}, { session: { id: 'new-id', provider: 'claude-code', model: 'claude-code:opus', metadata }, workspaceId: '/p' });
  expect(result).toMatchObject({ success: true });
  return (create.mock.calls[0][0] as { metadata?: Record<string, unknown> }).metadata;
}

describe('sessions:create (the renderer create barrier for a new id)', () => {
  it('drops every mission key from a team root create and keeps the rest', async () => {
    const stored = await createWith({ teamMode: true, effortLevel: 'high', phase: 'planning', ...MISSION_KEYS });
    expect(stored).toEqual({ teamMode: true, effortLevel: 'high', phase: 'planning' });
  });

  it('drops them when teamMode is false, and the false teamMode with them', async () => {
    const stored = await createWith({ teamMode: false, effortLevel: 'high', phase: 'planning', ...MISSION_KEYS });
    expect(stored).toEqual({ effortLevel: 'high', phase: 'planning' });
  });

  it('drops a lone teamFront from a session that is not a team root', async () => {
    const stored = await createWith({ teamFront: 'team-front_forged' });
    expect(stored).toEqual({});
  });

  it('drops a lone teamFront from a team root, which stays a legacy root', async () => {
    const stored = await createWith({ teamMode: true, teamFront: 'team-front_forged' });
    expect(stored).toEqual({ teamMode: true });
  });
});

describe('sessions:list-children (renderer-facing projection of a stored row)', () => {
  const row = (id: string, metadata: Record<string, unknown>) => ({
    id, provider: 'claude-code', model: 'claude-code:opus', session_type: 'session', mode: 'agent', agent_role: 'standard',
    created_by_session_id: null, title: id, workspace_id: '/p', worktree_id: null, parent_session_id: 'parent',
    created_at: new Date(1), updated_at: new Date(2), is_archived: false, is_pinned: false, message_count: 0, child_count: 0,
    metadata,
  });
  const keys = ['teamFront', 'teamGoal', 'teamMissionStatus', 'teamMissionContext', 'teamDoneCriterion', 'teamMissionVersion'];

  async function children(rows: any[]) {
    query.mockResolvedValue({ rows });
    const result = await handlers.get('sessions:list-children')!({}, 'parent', '/p');
    expect(result.success).toBe(true);
    return Object.fromEntries((result.children as any[]).map((c) => [c.id, c]));
  }

  it('does not expose mission keys stored on a session that is not a team root', async () => {
    const byId = await children([
      row('plain', { ...MISSION_KEYS, phase: 'planning' }),
      row('member', { ...MISSION_KEYS, teamChild: { role: 'explorer', rootSessionId: 'r', depth: 1 } }),
      row('false', { ...MISSION_KEYS, teamMode: false }),
    ]);
    for (const id of ['plain', 'member', 'false']) {
      for (const key of keys) expect(byId[id][key], `${id} ${key}`).toBeUndefined();
    }
    expect(byId.plain.phase).toBe('planning');
  });

  it('exposes the read-only mission keys of a team root, and nothing for a legacy root', async () => {
    const byId = await children([
      row('root', { teamMode: true, ...MISSION_KEYS, teamMissionStatus: 'active' }),
      row('legacy', { teamMode: true }),
      row('preS3', { teamMode: true, teamFront: 'x', teamGoal: 'g', teamMissionStatus: 'active' }),
    ]);
    expect(byId.root).toMatchObject({ teamMode: true, teamFront: 'x', teamGoal: 'g', teamMissionStatus: 'active' });
    // Main-only keys stay out of the renderer-facing list even for a real root.
    expect(byId.root.teamMissionContext).toBeUndefined();
    expect(byId.root.teamDoneCriterion).toBeUndefined();
    for (const key of keys) expect(byId.legacy[key], key).toBeUndefined();
    expect(byId.legacy.teamMode).toBe(true);
    // Mission keys stored without the host marker are not a mission (written before S3).
    for (const key of keys) expect(byId.preS3[key], key).toBeUndefined();
    expect(byId.preS3.teamMode).toBe(true);
  });
});
