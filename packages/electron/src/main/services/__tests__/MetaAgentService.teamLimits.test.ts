import { beforeEach, describe, expect, it, vi } from 'vitest';

// Team mode limits in MetaAgentService (Phase 2): the gate runs before any side
// effect, under one lock per team, and never outside a team.
// Mock surface mirrors MetaAgentService.teamSpawn.test.ts.
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { create: vi.fn(), updateMetadata: vi.fn(), get: vi.fn() },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({ AgentMessagesRepository: {} }));
vi.mock('@nimbalyst/runtime/storage/repositories/SessionFilesRepository', () => ({ SessionFilesRepository: {} }));
vi.mock('@nimbalyst/runtime/ai/server', () => ({
  ClaudeCodeProvider: { setMetaAgentServerPort: vi.fn() },
  OpenAICodexProvider: { setMetaAgentServerPort: vi.fn() },
  OpenAICodexACPProvider: { setMetaAgentServerPort: vi.fn() },
  SessionManager: class { async initialize() {} },
}));
vi.mock('@nimbalyst/runtime/ai/server/types', () => ({
  ModelIdentifier: {
    parse: (id: string) => {
      const i = id.indexOf(':');
      if (i <= 0) throw new Error(`invalid model: ${id}`);
      return { provider: id.slice(0, i), model: id.slice(i + 1), combined: id };
    },
    tryParse: (id: string) => {
      const i = typeof id === 'string' ? id.indexOf(':') : -1;
      return i > 0 ? { provider: id.slice(0, i), model: id.slice(i + 1) } : null;
    },
    getDefaultModelId: (provider: string) => `${provider}:default`,
  },
}));
vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: () => ({ subscribe: vi.fn() }),
}));
vi.mock('../ai/providerResolution', () => ({
  resolveExtensionAgentRef: () => null,
  isExtensionAgentProvider: () => false,
  usesHostSuppliedToolLoop: () => false,
}));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../SyncManager', () => ({ getSyncProvider: () => ({ pushChange: vi.fn() }) }));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn() }));
vi.mock('../../utils/store', () => ({ getDefaultAIModel: () => null }));
vi.mock('../../utils/timestampUtils', () => ({ toMillis: (v: unknown) => v }));
vi.mock('../WorktreeStore', () => ({ createWorktreeStore: vi.fn() }));
vi.mock('../GitWorktreeService', () => ({ GitWorktreeService: class {} }));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({ database: { query: vi.fn() } }));
vi.mock('../../database/initialize', () => ({ getDatabase: () => null }));
vi.mock('../../file/GitRefWatcher', () => ({ gitRefWatcher: {} }));
vi.mock('./ai/AIService', () => ({ AIService: class {} }));
vi.mock('../../mcp/metaAgentServer', () => ({ setMetaAgentToolFns: vi.fn() }));
vi.mock('../metaAgentNotificationSignature', () => ({ computeNotificationSignature: vi.fn() }));
vi.mock('../metaAgentMessageText', () => ({ extractMessageText: vi.fn(), extractUserPrompts: vi.fn() }));
vi.mock('../ai/claudeCliLauncherSingleton', () => ({ ClaudeCliLauncherConfig: { setMetaAgentServerPort: vi.fn() } }));
// The checkpoint card has its own tests (team/__tests__/teamCheckpoint.test.ts).
vi.mock('../team/teamCheckpoint', () => ({
  postTeamCheckpointCard: vi.fn(async () => {}),
  resolveTeamCheckpointCard: vi.fn(async () => {}),
  buildTeamContinuationNotice: ({ total, authorized }: { total: number; authorized: number }) => `continued ${total}/${authorized}`,
  // What the UI language resolves to in a pt-BR app.
  teamContinueActionLabel: () => 'Continuar equipe',
  TEAM_CONTINUATION_NOTICE_CONTEXT: {
    promptOrigin: 'team_checkpoint',
    promptProvenance: { actor: 'system', origin: 'session-orchestration', messageKind: 'status' },
  },
}));

import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { database as databaseWorker } from '../../database/PGLiteDatabaseWorker';
import { safeHandle } from '../../utils/ipcRegistry';
import { MetaAgentService } from '../MetaAgentService';
import { postTeamCheckpointCard, resolveTeamCheckpointCard } from '../team/teamCheckpoint';

const ROOT = { id: 'root', provider: 'claude-code', model: 'claude-code:opus', agentRole: 'standard', workspacePath: '/ws', metadata: { teamMode: true } };
const MEMBER = {
  id: 'member', provider: 'claude-code', model: 'claude-code:sonnet', agentRole: 'standard', workspacePath: '/ws',
  metadata: { teamChild: { role: 'implementer', rootSessionId: 'root', depth: 1 } },
};
const GRANDCHILD = {
  id: 'grandchild', provider: 'claude-code', model: 'claude-code:opus', agentRole: 'standard', workspacePath: '/ws',
  metadata: { teamChild: { role: 'implementer', rootSessionId: 'root', depth: 2 } },
};
const PLAIN = { id: 'plain', provider: 'claude-code', model: 'claude-code:opus', agentRole: 'standard', workspacePath: '/ws', metadata: {} };

/** Team usage the fake database reports; `created` grows as rows are inserted. */
const usage = { total: 0, active: 0 };
/** `ai_sessions.metadata` of the fake database, by session id. */
let storedMetadata: Record<string, Record<string, unknown>> = {};
const isTeamQuery = (sql: string) => sql.includes('WITH RECURSIVE team_tree');
const isRootRowQuery = (sql: string) => sql.includes('SELECT metadata, agent_role FROM ai_sessions');
const isBudgetWrite = (sql: string) => sql.startsWith('UPDATE ai_sessions SET metadata');

function service() {
  const svc = MetaAgentService.getInstance();
  (svc as any).aiService = {
    queuePromptForSession: vi.fn(),
    triggerQueuedPromptProcessingForSession: vi.fn(),
    requestQueueDrive: vi.fn(),
  };
  return svc as any;
}

beforeEach(() => {
  usage.total = 0;
  usage.active = 0;
  storedMetadata = { root: { ...ROOT.metadata }, member: { ...MEMBER.metadata }, grandchild: { ...GRANDCHILD.metadata }, plain: {} };
  vi.mocked(postTeamCheckpointCard).mockClear();
  vi.mocked(resolveTeamCheckpointCard).mockClear();
  vi.mocked(AISessionsRepository.create).mockReset();
  vi.mocked(AISessionsRepository.get).mockReset();
  const rows: Record<string, unknown> = { root: ROOT, member: MEMBER, grandchild: GRANDCHILD, plain: PLAIN };
  vi.mocked(AISessionsRepository.get).mockImplementation(async (id: string) => (rows[id] ?? null) as never);
  // A created member is active at once (its initial prompt sits in the queue).
  vi.mocked(AISessionsRepository.create).mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    usage.total += 1;
    usage.active += 1;
  });
  vi.mocked(databaseWorker.query).mockReset();
  vi.mocked(databaseWorker.query).mockImplementation(async (sql: string, params?: unknown[]) => {
    if (isTeamQuery(sql)) return { rows: [{ total: String(usage.total), active: String(usage.active) }] } as never;
    if (isRootRowQuery(sql)) {
      const metadata = storedMetadata[params![0] as string];
      return { rows: metadata ? [{ metadata, agent_role: 'standard' }] : [] } as never;
    }
    if (isBudgetWrite(sql)) {
      const id = params![1] as string;
      storedMetadata[id] = { ...storedMetadata[id], ...JSON.parse(params![0] as string) };
      return { rows: [] } as never;
    }
    return { rows: [{ in_flight: '0', total: '0' }] } as never;
  });
});

describe('Team mode limits', () => {
  it('serializes a team: of two parallel spawns with one slot left, exactly one is created', async () => {
    usage.total = 2;
    usage.active = 2;
    const svc = service();
    const results = await Promise.allSettled([
      svc.createChildSessionInternal('root', '/ws', { role: 'explorer' }),
      svc.createChildSessionInternal('root', '/ws', { role: 'explorer' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/3\/3 sessions are already active/);
    expect(AISessionsRepository.create).toHaveBeenCalledTimes(1);
  });

  it('refuses over budget before any side effect (no worktree, no row)', async () => {
    usage.total = 8;
    // useWorktree would hit "Database not initialized" if the gate ran after it.
    await expect(service().createChildSessionInternal('root', '/ws', { role: 'implementer', useWorktree: true }))
      .rejects.toThrow(/Team budget reached/);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
  });

  it('refuses a grandchild creating anyone, without querying the tree', async () => {
    await expect(service().createChildSessionInternal('grandchild', '/ws', {})).rejects.toThrow(/Team depth limit reached/);
    expect(vi.mocked(databaseWorker.query).mock.calls.some(([sql]) => isTeamQuery(sql as string))).toBe(false);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
  });

  it('spawn_session refuses before promoting the caller into a workstream', async () => {
    usage.total = 8;
    const svc = service();
    const promote = vi.spyOn(svc, 'resolveOrCreateWorkstream');
    await expect(svc.spawnSession('root', '/ws', { prompt: 'x' })).rejects.toThrow(/Team budget reached/);
    expect(promote).not.toHaveBeenCalled();
    promote.mockRestore();
  });

  it('a refused spawn does not block the team lock for the next one', async () => {
    usage.total = 8;
    const svc = service();
    await expect(svc.createChildSessionInternal('root', '/ws', {})).rejects.toThrow(/budget/);
    usage.total = 1;
    usage.active = 0;
    await expect(svc.createChildSessionInternal('root', '/ws', {})).resolves.toBeTruthy();
  });
});

describe('Team checkpoint', () => {
  /** A team that has created `total` members, none of them running. */
  const settled = (total: number) => { usage.total = total; usage.active = 0; };

  it('the 9th creation stays refused and shows the checkpoint to the user in the root transcript', async () => {
    settled(8);
    await expect(service().createChildSessionInternal('root', '/ws', { role: 'implementer' }))
      .rejects.toThrow(/Only the user can authorize more/);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
    expect(postTeamCheckpointCard).toHaveBeenCalledTimes(1);
    expect(postTeamCheckpointCard).toHaveBeenCalledWith({ rootSessionId: 'root', workspacePath: '/ws', created: 8, authorized: 8 });
  });

  it('the refusal names the action in the UI language, for create_session and spawn_session alike', async () => {
    settled(8);
    const svc = service();
    for (const attempt of [
      () => svc.createChildSessionInternal('root', '/ws', { role: 'implementer' }),
      () => svc.spawnSession('root', '/ws', { prompt: 'x' }),
    ]) {
      const error = await attempt().catch((e: Error) => e);
      expect(String(error.message)).toContain('with the "Continuar equipe" action now shown');
      expect(String(error.message)).not.toContain('Continue team');
    }
  });

  it('attempts repeated after the checkpoint create no new authorization and no checkpoint of another level', async () => {
    settled(8);
    const svc = service();
    // The coordinator and a member trying again in later turns, as in the live run.
    await expect(svc.createChildSessionInternal('root', '/ws', {})).rejects.toThrow(/8\/8/);
    await expect(svc.createChildSessionInternal('member', '/ws', {})).rejects.toThrow(/8\/8/);
    await expect(svc.spawnSession('root', '/ws', { prompt: 'x' })).rejects.toThrow(/8\/8/);
    expect(storedMetadata.root.teamBudget).toBeUndefined();
    expect(vi.mocked(databaseWorker.query).mock.calls.some(([sql]) => isBudgetWrite(sql as string))).toBe(false);
    // One logical checkpoint: every post is for the same level (the card module dedupes rows by level).
    const levels = vi.mocked(postTeamCheckpointCard).mock.calls.map(([args]) => args.authorized);
    expect(new Set(levels)).toEqual(new Set([8]));
  });

  it('a click on a card left behind by a passed level closes that card and authorizes nothing', async () => {
    settled(8);
    const svc = service();
    await svc.continueTeam('root', 8);
    vi.mocked(resolveTeamCheckpointCard).mockClear();
    svc.aiService.queuePromptForSession.mockClear();
    usage.total = 9;

    await expect(svc.continueTeam('root', 8)).resolves.toEqual({ extended: false, reason: 'not-at-checkpoint', total: 9, authorized: 12 });
    expect(storedMetadata.root.teamBudget).toEqual({ authorized: 12, extensions: 1 });
    expect(resolveTeamCheckpointCard).toHaveBeenCalledTimes(1);
    expect(resolveTeamCheckpointCard).toHaveBeenCalledWith({ rootSessionId: 'root', workspacePath: '/ws', previousAuthorized: 8, authorized: 12 });
    expect(svc.aiService.queuePromptForSession).not.toHaveBeenCalled();

    // The level is never trusted to authorize or to close the current checkpoint.
    vi.mocked(resolveTeamCheckpointCard).mockClear();
    for (const level of [12, 16, 99, 4, -1, 8.5, Number.NaN]) {
      await expect(svc.continueTeam('root', level), String(level)).resolves.toMatchObject({ extended: false, authorized: 12 });
    }
    expect(resolveTeamCheckpointCard).not.toHaveBeenCalled();
    expect(storedMetadata.root.teamBudget).toEqual({ authorized: 12, extensions: 1 });
  });

  it('a member refused at the checkpoint also shows it in the root, not in its own transcript', async () => {
    settled(8);
    await expect(service().createChildSessionInternal('member', '/ws', { role: 'explorer' })).rejects.toThrow(/Team budget reached/);
    expect(postTeamCheckpointCard).toHaveBeenCalledWith(expect.objectContaining({ rootSessionId: 'root' }));
  });

  it('spawn_session refused at the checkpoint shows it too, for the root and for a member, before any promotion', async () => {
    settled(8);
    const svc = service();
    const promote = vi.spyOn(svc, 'resolveOrCreateWorkstream');
    for (const caller of ['root', 'member']) {
      vi.mocked(postTeamCheckpointCard).mockClear();
      await expect(svc.spawnSession(caller, '/ws', { prompt: 'x', useWorktree: true })).rejects.toThrow(/Team budget reached/);
      expect(postTeamCheckpointCard, caller).toHaveBeenCalledTimes(1);
      expect(postTeamCheckpointCard, caller).toHaveBeenCalledWith({ rootSessionId: 'root', workspacePath: '/ws', created: 8, authorized: 8 });
    }
    expect(promote).not.toHaveBeenCalled();
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
    promote.mockRestore();
  });

  it('the active and depth refusals show no checkpoint', async () => {
    usage.total = 3;
    usage.active = 3;
    await expect(service().createChildSessionInternal('root', '/ws', {})).rejects.toThrow(/3\/3/);
    await expect(service().createChildSessionInternal('grandchild', '/ws', {})).rejects.toThrow(/Team depth limit reached/);
    expect(postTeamCheckpointCard).not.toHaveBeenCalled();
  });

  it('a refused creation extends nothing: the model cannot authorize itself by asking again', async () => {
    settled(8);
    const svc = service();
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(svc.createChildSessionInternal('root', '/ws', {})).rejects.toThrow(/8\/8/);
    }
    expect(storedMetadata.root.teamBudget).toBeUndefined();
    expect(vi.mocked(databaseWorker.query).mock.calls.some(([sql]) => isBudgetWrite(sql as string))).toBe(false);
  });

  it('the user continues the team: 12 authorized, the card is resolved and the coordinator is told', async () => {
    settled(8);
    const svc = service();
    await expect(svc.continueTeam('root')).resolves.toEqual({ extended: true, total: 8, previousAuthorized: 8, authorized: 12 });
    expect(storedMetadata.root).toEqual({ teamMode: true, teamBudget: { authorized: 12, extensions: 1 } });
    expect(resolveTeamCheckpointCard).toHaveBeenCalledWith({ rootSessionId: 'root', workspacePath: '/ws', previousAuthorized: 8, authorized: 12 });
    // Queued as system orchestration with its own origin: the transcript shows
    // it as a status line, not as a message the user typed.
    expect(svc.aiService.queuePromptForSession).toHaveBeenCalledWith(
      'root', 'continued 8/12', undefined,
      {
        promptOrigin: 'team_checkpoint',
        promptProvenance: { actor: 'system', origin: 'session-orchestration', messageKind: 'status' },
      },
    );
    // Fire-and-forget: the click does not wait for the turn it starts.
    expect(svc.aiService.requestQueueDrive).toHaveBeenCalledWith('root', '/ws', 'meta-agent');
    expect(svc.aiService.triggerQueuedPromptProcessingForSession).not.toHaveBeenCalled();
  });

  it('after the user continues, creation passes again, up to the next checkpoint and a second authorization', async () => {
    settled(8);
    const svc = service();
    await svc.continueTeam('root');
    for (let created = 9; created <= 12; created++) {
      await expect(svc.createChildSessionInternal('root', '/ws', { role: 'reviewer' })).resolves.toBeTruthy();
      usage.active = 0;
    }
    expect(usage.total).toBe(12);

    await expect(svc.createChildSessionInternal('root', '/ws', { role: 'reviewer' })).rejects.toThrow(/12\/12/);
    expect(postTeamCheckpointCard).toHaveBeenLastCalledWith({ rootSessionId: 'root', workspacePath: '/ws', created: 12, authorized: 12 });

    await expect(svc.continueTeam('root')).resolves.toMatchObject({ extended: true, previousAuthorized: 12, authorized: 16 });
    expect(storedMetadata.root.teamBudget).toEqual({ authorized: 16, extensions: 2 });
    await expect(svc.createChildSessionInternal('root', '/ws', { role: 'reviewer' })).resolves.toBeTruthy();
  });

  it('continuing a team that is not at its checkpoint changes nothing and wakes nobody', async () => {
    settled(5);
    const svc = service();
    await expect(svc.continueTeam('root')).resolves.toEqual({ extended: false, reason: 'not-at-checkpoint', total: 5, authorized: 8 });
    expect(storedMetadata.root.teamBudget).toBeUndefined();
    expect(resolveTeamCheckpointCard).not.toHaveBeenCalled();
    expect(svc.aiService.queuePromptForSession).not.toHaveBeenCalled();
  });

  it('only a team root can be continued, never a member or a plain session', async () => {
    settled(8);
    const svc = service();
    for (const id of ['member', 'plain', 'missing']) {
      await expect(svc.continueTeam(id), id).resolves.toEqual({ extended: false, reason: 'not-a-team-root' });
    }
    expect(storedMetadata.member.teamBudget).toBeUndefined();
    await expect(svc.createChildSessionInternal('root', '/ws', {})).rejects.toThrow(/8\/8/);
  });

  it('the coordinator is woken outside the team lock, so its next creation is not blocked', async () => {
    settled(8);
    const svc = service();
    let createdDuringWake: Promise<unknown> | undefined;
    svc.aiService.requestQueueDrive = vi.fn(() => {
      createdDuringWake = svc.createChildSessionInternal('root', '/ws', { role: 'implementer' });
    });
    await svc.continueTeam('root');
    await expect(createdDuringWake).resolves.toBeTruthy();
    expect(usage.total).toBe(9);
  });

  it('a failure to notify the coordinator does not undo the authorization', async () => {
    settled(8);
    const svc = service();
    svc.aiService.queuePromptForSession = vi.fn(async () => { throw new Error('queue down'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(svc.continueTeam('root')).resolves.toMatchObject({ extended: true, authorized: 12 });
    warn.mockRestore();
    expect(storedMetadata.root.teamBudget).toEqual({ authorized: 12, extensions: 1 });
  });

  it('is reachable from the renderer through team:continue, which validates its payload', async () => {
    settled(8);
    const svc = service();
    vi.mocked(safeHandle).mockClear();
    svc.ipcHandlersRegistered = false;
    svc.registerIpcHandlers();
    const handler = vi.mocked(safeHandle).mock.calls.find(([channel]) => channel === 'team:continue')![1] as
      (event: unknown, payload: unknown) => Promise<Record<string, unknown>>;

    await expect(handler({}, undefined)).resolves.toEqual({ success: false, error: 'sessionId is required' });
    await expect(handler({}, { sessionId: 42 })).resolves.toEqual({ success: false, error: 'sessionId is required' });
    await expect(handler({}, { sessionId: 'plain' })).resolves.toEqual({ success: true, extended: false, reason: 'not-a-team-root' });
    await expect(handler({}, { sessionId: 'root', checkpointLevel: 8 })).resolves.toEqual({
      success: true, extended: true, total: 8, previousAuthorized: 8, authorized: 12,
    });
    // A second click (double click, or the bar and the card) extends nothing more.
    await expect(handler({}, { sessionId: 'root', checkpointLevel: 8 })).resolves.toEqual({
      success: true, extended: false, reason: 'not-at-checkpoint', total: 8, authorized: 12,
    });
    await expect(handler({}, { sessionId: 'root', checkpointLevel: 'x' })).resolves.toMatchObject({ extended: false, authorized: 12 });
    expect(storedMetadata.root.teamBudget).toEqual({ authorized: 12, extensions: 1 });
  });
});

describe('outside Team mode', () => {
  it('never runs the team gate', async () => {
    usage.total = 99;
    usage.active = 99;
    await service().createChildSessionInternal('plain', '/ws', {});
    expect(AISessionsRepository.create).toHaveBeenCalledTimes(1);
    expect(vi.mocked(databaseWorker.query).mock.calls.some(([sql]) => isTeamQuery(sql as string))).toBe(false);
  });
});
