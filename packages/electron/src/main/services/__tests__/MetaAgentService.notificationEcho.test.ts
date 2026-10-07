import { describe, expect, it, vi } from 'vitest';

// [Child Session Update] recap: the parent already wrote the child's task, so
// the recap must not echo it back (it did, for any child with <3 messages).
// get_session_result still returns it. Also covers the tool-scope line, which
// may only assert a denial the child's provider actually enforced.
//
// Mock surface mirrors MetaAgentService.getSessionResultCompact.test.ts.
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { create: vi.fn(), updateMetadata: vi.fn(), get: vi.fn() },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({
  AgentMessagesRepository: { list: vi.fn() },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/SessionFilesRepository', () => ({
  SessionFilesRepository: { getFilesBySession: vi.fn().mockResolvedValue([]) },
}));
vi.mock('@nimbalyst/runtime/ai/server', () => ({
  ClaudeCodeProvider: { setMetaAgentServerPort: vi.fn() },
  OpenAICodexProvider: { setMetaAgentServerPort: vi.fn() },
  OpenAICodexACPProvider: { setMetaAgentServerPort: vi.fn() },
  SessionManager: class { async initialize() {} },
}));
vi.mock('@nimbalyst/runtime/ai/server/types', () => ({
  ModelIdentifier: {
    parse: (id: string) => ({ provider: id.split(':')[0], model: id.split(':')[1], combined: id }),
    tryParse: () => null,
    getDefaultModelId: (provider: string) => `${provider}:default`,
  },
}));
vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: () => ({ subscribe: vi.fn() }),
}));
vi.mock('../ai/providerResolution', () => ({
  resolveExtensionAgentRef: () => null,
  isExtensionAgentProvider: () => false,
  usesHostSuppliedToolLoop: (provider: string) => provider === 'antigravity-gemini-agent',
}));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../SyncManager', () => ({ getSyncProvider: () => ({ pushChange: vi.fn() }) }));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn() }));
vi.mock('../../utils/store', () => ({ getDefaultAIModel: () => null }));
vi.mock('../../utils/timestampUtils', () => ({ toMillis: (v: unknown) => v }));
vi.mock('../WorktreeStore', () => ({ createWorktreeStore: vi.fn() }));
vi.mock('../GitWorktreeService', () => ({ GitWorktreeService: class {} }));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));
vi.mock('../../database/initialize', () => ({ getDatabase: () => null }));
vi.mock('../../file/GitRefWatcher', () => ({ gitRefWatcher: {} }));
vi.mock('./ai/AIService', () => ({ AIService: class {} }));
vi.mock('../../mcp/metaAgentServer', () => ({ setMetaAgentToolFns: vi.fn() }));
vi.mock('../metaAgentNotificationSignature', () => ({ computeNotificationSignature: vi.fn() }));
vi.mock('../metaAgentMessageText', () => ({
  extractMessageText: (content: unknown) => (typeof content === 'string' ? content : ''),
  extractUserPrompts: (messages: Array<{ direction: string; content: string }>) =>
    messages.filter((m) => m.direction === 'input').map((m) => m.content),
}));
vi.mock('../ai/claudeCliLauncherSingleton', () => ({
  ClaudeCliLauncherConfig: { setMetaAgentServerPort: vi.fn() },
}));

import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { AgentMessagesRepository } from '@nimbalyst/runtime/storage/repositories/AgentMessagesRepository';
import { MetaAgentService, promptOriginSessionId } from '../MetaAgentService';

const TASK = 'TASK FROM PARENT: audit the build scripts and report';

function childRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'child-1',
    title: 'Explorer',
    provider: 'claude-code',
    model: 'claude-code:sonnet',
    workspacePath: '/ws',
    worktreeId: null,
    createdBySessionId: 'parent-1',
    metadata: null,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

const fromParent = { promptProvenance: { actor: 'agent', origin: 'session-orchestration', originSessionId: 'parent-1' } };

async function notificationFor(messages: unknown[], row = childRow()) {
  vi.mocked(AISessionsRepository.get).mockResolvedValue(row as never);
  vi.mocked(AgentMessagesRepository.list).mockResolvedValue(messages as never);
  const service = MetaAgentService.getInstance() as any;
  const result = await service.buildSessionResultData('child-1', '/ws', undefined, false, {
    excludeInputFromSessionId: 'parent-1',
  });
  return { result, text: service.buildNotificationMessage('session:completed', result) as string };
}

describe('promptOriginSessionId', () => {
  it('reads originSessionId from prompt provenance', () => {
    expect(promptOriginSessionId(fromParent)).toBe('parent-1');
    expect(promptOriginSessionId({ promptProvenance: { actor: 'user' } })).toBeNull();
    expect(promptOriginSessionId(null)).toBeNull();
  });
});

describe('[Child Session Update] recap', () => {
  it('does not echo the task the parent sent', async () => {
    const { text, result } = await notificationFor([
      { direction: 'input', content: TASK, metadata: fromParent },
      { direction: 'output', content: 'Report saved. Summary: three findings.', metadata: null },
    ]);
    expect(text).not.toContain(TASK);
    expect(text).toContain('Report saved. Summary: three findings.');
    expect(result.recentMessages).toEqual([{ direction: 'output', text: 'Report saved. Summary: three findings.' }]);
  });

  it('keeps inputs that did not come from the parent (the user typing into the child)', async () => {
    const { text } = await notificationFor([
      { direction: 'input', content: TASK, metadata: fromParent },
      { direction: 'output', content: 'Working on it.', metadata: null },
      { direction: 'input', content: 'User here: also check the installer', metadata: null },
      { direction: 'output', content: 'Done.', metadata: null },
    ]);
    expect(text).not.toContain(TASK);
    expect(text).toContain('User here: also check the installer');
  });

  it('get_session_result still returns the task', async () => {
    vi.mocked(AISessionsRepository.get).mockResolvedValue(childRow() as never);
    vi.mocked(AgentMessagesRepository.list).mockResolvedValue([
      { direction: 'input', content: TASK, metadata: fromParent },
      { direction: 'output', content: 'Done.', metadata: null },
    ] as never);
    const json = await (MetaAgentService.getInstance() as any).getSessionResultJson('child-1', '/ws');
    const data = JSON.parse(json);
    expect(data.originalPrompt).toBe(TASK);
    expect(data.recentMessages.map((m: { text: string }) => m.text)).toContain(TASK);
  });
});

describe('[Child Session Update] tool scope line', () => {
  const done = [{ direction: 'output', content: 'Done.', metadata: null }];

  it('asserts the denial for an enforcing provider', async () => {
    const { text, result } = await notificationFor(done, childRow({ metadata: { toolScope: 'write' } }));
    expect(result.toolScopeEnforced).toBe(true);
    expect(text).toContain('this child had NO shell (run_command/Bash) or delegation tools');
  });

  it('does not assert a denial the provider never applied', async () => {
    const { text, result } = await notificationFor(
      done,
      childRow({ provider: 'claude-code-cli', metadata: { toolScope: 'write' } }),
    );
    expect(result.toolScopeEnforced).toBe(false);
    expect(text).toContain('does not enforce it');
    expect(text).not.toContain('had NO');
  });

  it('omits the line for an unrestricted child', async () => {
    const { text, result } = await notificationFor(done);
    expect(result.toolScopeEnforced).toBeUndefined();
    expect(text).not.toContain('Tool scope');
  });
});
