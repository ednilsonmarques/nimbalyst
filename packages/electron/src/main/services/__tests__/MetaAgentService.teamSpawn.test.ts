import { beforeEach, describe, expect, it, vi } from 'vitest';

// Team mode child creation (Phase 1: roles, defaults, teamChild, provider
// guard). Mock surface mirrors MetaAgentService.providerInheritance.test.ts.
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
vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: { query: vi.fn().mockResolvedValue({ rows: [{ in_flight: '0', total: '0', active: '0' }] }) },
}));
vi.mock('../../database/initialize', () => ({ getDatabase: () => null }));
vi.mock('../../file/GitRefWatcher', () => ({ gitRefWatcher: {} }));
vi.mock('./ai/AIService', () => ({ AIService: class {} }));
vi.mock('../../mcp/metaAgentServer', () => ({ setMetaAgentToolFns: vi.fn() }));
vi.mock('../metaAgentNotificationSignature', () => ({ computeNotificationSignature: vi.fn() }));
vi.mock('../metaAgentMessageText', () => ({ extractMessageText: vi.fn(), extractUserPrompts: vi.fn() }));
vi.mock('../ai/claudeCliLauncherSingleton', () => ({ ClaudeCliLauncherConfig: { setMetaAgentServerPort: vi.fn() } }));

import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { MetaAgentService } from '../MetaAgentService';

const ROOT = { id: 'root', provider: 'claude-code', model: 'claude-code:opus', agentRole: 'standard', workspacePath: '/ws', metadata: { teamMode: true } };
const MEMBER = {
  id: 'member', provider: 'claude-code', model: 'claude-code:sonnet', agentRole: 'standard', workspacePath: '/ws',
  metadata: { teamChild: { role: 'implementer', rootSessionId: 'root', depth: 1 } },
};
const PLAIN = { id: 'plain', provider: 'claude-code', model: 'claude-code:opus', agentRole: 'standard', workspacePath: '/ws', metadata: {} };

function service() {
  const svc = MetaAgentService.getInstance();
  (svc as any).aiService = { queuePromptForSession: vi.fn(), triggerQueuedPromptProcessingForSession: vi.fn() };
  return svc as any;
}

function created() {
  return vi.mocked(AISessionsRepository.create).mock.calls.at(-1)![0] as any;
}

beforeEach(() => {
  vi.mocked(AISessionsRepository.create).mockReset();
  vi.mocked(AISessionsRepository.get).mockReset();
  const rows: Record<string, unknown> = { root: ROOT, member: MEMBER, plain: PLAIN };
  vi.mocked(AISessionsRepository.get).mockImplementation(async (id: string) => (rows[id] ?? null) as never);
});

describe('Team mode child creation', () => {
  it('explorer from the root: Sonnet, read-only, teamChild at depth 1', async () => {
    await service().createChildSessionInternal('root', '/ws', { role: 'explorer' });
    const row = created();
    expect(row.model).toBe('claude-code:sonnet');
    expect(row.createdBySessionId).toBe('root');
    expect(row.metadata.toolScope).toBe('read');
    expect(row.metadata.teamChild).toEqual({ role: 'explorer', rootSessionId: 'root', depth: 1 });
  });

  it('reviewer from the root: Sonnet, read-only', async () => {
    await service().createChildSessionInternal('root', '/ws', { role: 'reviewer' });
    expect(created().model).toBe('claude-code:sonnet');
    expect(created().metadata.toolScope).toBe('read');
  });

  it('implementer from the root: root model, full tools (no scope written)', async () => {
    await service().createChildSessionInternal('root', '/ws', { role: 'implementer' });
    const row = created();
    expect(row.model).toBe('claude-code:opus');
    expect(row.metadata.toolScope).toBeUndefined();
    expect(row.metadata.teamChild).toEqual({ role: 'implementer', rootSessionId: 'root', depth: 1 });
  });

  it('a member creating `other` gets the ROOT model, not its own, at depth 2', async () => {
    await service().createChildSessionInternal('member', '/ws', {});
    const row = created();
    expect(row.model).toBe('claude-code:opus');
    expect(row.metadata.toolScope).toBeUndefined();
    expect(row.metadata.teamChild).toEqual({ role: 'other', rootSessionId: 'root', depth: 2 });
  });

  it('an explicit model and toolScope win over the role defaults', async () => {
    await service().createChildSessionInternal('root', '/ws', { role: 'explorer', model: 'claude-code:opus', toolScope: 'write' });
    expect(created().model).toBe('claude-code:opus');
    expect(created().metadata.toolScope).toBe('write');
  });

  it('refuses an unknown role before creating anything', async () => {
    await expect(service().createChildSessionInternal('root', '/ws', { role: 'architect' })).rejects.toThrow(/Invalid role/);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
  });

  it('refuses a non-Claude Code team member before creating anything', async () => {
    await expect(service().createChildSessionInternal('root', '/ws', { role: 'explorer', provider: 'openai-codex', model: 'openai-codex:gpt-5.5' }))
      .rejects.toThrow(/Team mode supports claude-code sessions only/);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
  });
});

describe('outside Team mode nothing changes', () => {
  it('ignores role: parent model, no scope, no teamChild', async () => {
    await service().createChildSessionInternal('plain', '/ws', { role: 'explorer' });
    const row = created();
    expect(row.model).toBe('claude-code:opus');
    expect(row.metadata.toolScope).toBeUndefined();
    expect(row.metadata.teamChild).toBeUndefined();
  });

  it('allows any provider, as before', async () => {
    await service().createChildSessionInternal('plain', '/ws', { provider: 'openai-codex', model: 'openai-codex:gpt-5.5' });
    expect(created().provider).toBe('openai-codex');
  });

  it('spawn_session stays fire-and-forget outside a team', async () => {
    await service().spawnSession('plain', '/ws', { prompt: 'do it', isolated: true });
    expect(created().metadata.notifyParent).toBe(false);
  });
});

describe('spawn_session inside a team', () => {
  it('reports back by default and passes the role', async () => {
    await service().spawnSession('root', '/ws', { prompt: 'build it', isolated: true, role: 'implementer' });
    const row = created();
    expect(row.metadata.notifyParent).toBeUndefined();
    expect(row.metadata.teamChild).toEqual({ role: 'implementer', rootSessionId: 'root', depth: 1 });
  });

  it('still honours an explicit notifyOnComplete: false', async () => {
    await service().spawnSession('root', '/ws', { prompt: 'x', isolated: true, notifyOnComplete: false });
    expect(created().metadata.notifyParent).toBe(false);
  });
});
