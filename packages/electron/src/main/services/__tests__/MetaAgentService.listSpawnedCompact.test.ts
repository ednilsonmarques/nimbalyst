import { describe, expect, it, vi } from 'vitest';

// list_spawned_sessions is read by the coordinator model on every check of its
// team. Repeating each member's whole task, every edited path and a long last
// response made a 15-member list ~74,000 characters. The tool returns a compact
// summary; get_session_result keeps the full text. The Team view's IPC
// (getSpawnedSessions) is not affected.
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { create: vi.fn(), updateMetadata: vi.fn(), get: vi.fn() },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({
  AgentMessagesRepository: { list: vi.fn(), listTail: vi.fn() },
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
  extractUserPrompts: () => [],
}));
vi.mock('../ai/claudeCliLauncherSingleton', () => ({
  ClaudeCliLauncherConfig: { setMetaAgentServerPort: vi.fn() },
}));

import { MetaAgentService } from '../MetaAgentService';

const TRUNCATION_NOTE = /\.\.\. \[truncated: \d+ more characters; get_session_result has the full text\]$/;

function member(id: string, overrides: Record<string, unknown> = {}) {
  return {
    sessionId: id,
    title: `Member ${id}`,
    provider: 'claude-code',
    model: 'claude-code:sonnet',
    status: 'idle',
    lastActivity: 2,
    originalPrompt: 'T'.repeat(4000),
    lastResponse: 'R'.repeat(500),
    editedFiles: Array.from({ length: 40 }, (_, i) => `packages/area/file-${i}.ts`),
    pendingPrompt: null,
    createdAt: 1,
    updatedAt: 2,
    worktreeId: null,
    ...overrides,
  };
}

async function listJson(sessions: Array<Record<string, unknown>>) {
  const service = MetaAgentService.getInstance() as any;
  vi.spyOn(service, 'getSpawnedSessions').mockResolvedValue(sessions);
  return JSON.parse(await service.listSpawnedSessionsJson('root', '/ws'));
}

describe('list_spawned_sessions returns a compact summary', () => {
  it('shortens the task and the last response, marking the cut, and keeps identity and status whole', async () => {
    const [entry] = await listJson([member('a', { pendingPrompt: { promptId: 'p1' } })]);

    expect(entry.sessionId).toBe('a');
    expect(entry.title).toBe('Member a');
    expect(entry.status).toBe('idle');
    expect(entry.pendingPrompt).toEqual({ promptId: 'p1' });
    expect(entry.originalPrompt.startsWith('T'.repeat(200))).toBe(true);
    expect(entry.originalPrompt).toMatch(TRUNCATION_NOTE);
    expect(entry.originalPrompt.length).toBeLessThan(300);
    expect(entry.lastResponse.startsWith('R'.repeat(300))).toBe(true);
    expect(entry.lastResponse).toMatch(TRUNCATION_NOTE);
  });

  it('replaces the edited paths with a count and the first five', async () => {
    const [entry] = await listJson([member('a')]);

    expect(entry.editedFileCount).toBe(40);
    expect(entry.editedFiles).toEqual(['packages/area/file-0.ts', 'packages/area/file-1.ts', 'packages/area/file-2.ts', 'packages/area/file-3.ts', 'packages/area/file-4.ts']);
  });

  it('leaves short values untouched', async () => {
    const [entry] = await listJson([member('a', { originalPrompt: 'short task', lastResponse: 'done', editedFiles: ['a.ts'] })]);

    expect(entry.originalPrompt).toBe('short task');
    expect(entry.lastResponse).toBe('done');
    expect(entry.editedFiles).toEqual(['a.ts']);
    expect(entry.editedFileCount).toBe(1);
  });

  it('keeps a 15-member list far below the size that prompted the change', async () => {
    // Worst case: every member has a long task, a long response and 40 edited files.
    // The real 15-member list that prompted this went from 73,971 to 17,743 characters.
    const members = Array.from({ length: 15 }, (_, i) => member(`m${i}`));
    const before = JSON.stringify(members).length;
    const json = JSON.stringify(await listJson(members));

    expect(json.length).toBeLessThan(20000);
    expect(json.length).toBeLessThan(before / 3);
  });
});
