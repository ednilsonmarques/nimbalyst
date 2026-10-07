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

import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { database as databaseWorker } from '../../database/PGLiteDatabaseWorker';
import { MetaAgentService } from '../MetaAgentService';

const ROOT = { id: 'root', provider: 'claude-code', model: 'claude-code:opus', agentRole: 'standard', workspacePath: '/ws', metadata: { teamMode: true } };
const GRANDCHILD = {
  id: 'grandchild', provider: 'claude-code', model: 'claude-code:opus', agentRole: 'standard', workspacePath: '/ws',
  metadata: { teamChild: { role: 'implementer', rootSessionId: 'root', depth: 2 } },
};
const PLAIN = { id: 'plain', provider: 'claude-code', model: 'claude-code:opus', agentRole: 'standard', workspacePath: '/ws', metadata: {} };

/** Team usage the fake database reports; `created` grows as rows are inserted. */
const usage = { total: 0, active: 0 };
const isTeamQuery = (sql: string) => sql.includes('WITH RECURSIVE team_tree');

function service() {
  const svc = MetaAgentService.getInstance();
  (svc as any).aiService = { queuePromptForSession: vi.fn(), triggerQueuedPromptProcessingForSession: vi.fn() };
  return svc as any;
}

beforeEach(() => {
  usage.total = 0;
  usage.active = 0;
  vi.mocked(AISessionsRepository.create).mockReset();
  vi.mocked(AISessionsRepository.get).mockReset();
  const rows: Record<string, unknown> = { root: ROOT, grandchild: GRANDCHILD, plain: PLAIN };
  vi.mocked(AISessionsRepository.get).mockImplementation(async (id: string) => (rows[id] ?? null) as never);
  // A created member is active at once (its initial prompt sits in the queue).
  vi.mocked(AISessionsRepository.create).mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    usage.total += 1;
    usage.active += 1;
  });
  vi.mocked(databaseWorker.query).mockReset();
  vi.mocked(databaseWorker.query).mockImplementation(async (sql: string) => (
    isTeamQuery(sql)
      ? { rows: [{ total: String(usage.total), active: String(usage.active) }] }
      : { rows: [{ in_flight: '0', total: '0' }] }
  ) as never);
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

describe('outside Team mode', () => {
  it('never runs the team gate', async () => {
    usage.total = 99;
    usage.active = 99;
    await service().createChildSessionInternal('plain', '/ws', {});
    expect(AISessionsRepository.create).toHaveBeenCalledTimes(1);
    expect(vi.mocked(databaseWorker.query).mock.calls.some(([sql]) => isTeamQuery(sql as string))).toBe(false);
  });
});
