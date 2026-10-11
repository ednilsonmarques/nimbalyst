import { describe, expect, it, vi } from 'vitest';

// FIX A regression guard: get_session_result (via buildSessionResultData) must
// hand the meta-agent the child's FULL final response, not a 500-char stub. The
// 500-char truncation was the root cause of thin meta-agent synthesis: the model
// was summarizing from a decapitated preview. lastResponse stays the short
// notification preview; fullResponse carries the real content.
//
// Mock surface mirrors MetaAgentService.providerInheritance.test.ts (enough to
// import MetaAgentService without pulling electron-app / node-pty into the graph),
// plus AgentMessagesRepository.list and a real extractMessageText so the result
// builder sees actual message text.
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
vi.mock('../../mcp/metaAgentServer', () => ({
  setMetaAgentToolFns: vi.fn(),
}));
vi.mock('../metaAgentNotificationSignature', () => ({ computeNotificationSignature: vi.fn() }));
vi.mock('../metaAgentMessageText', () => ({
  extractMessageText: (content: unknown) => (typeof content === 'string' ? content : ''),
  extractUserPrompts: () => ['original task'],
}));
vi.mock('../ai/claudeCliLauncherSingleton', () => ({
  ClaudeCliLauncherConfig: { setMetaAgentServerPort: vi.fn() },
}));

import { AgentMessagesRepository } from '@nimbalyst/runtime/storage/repositories/AgentMessagesRepository';
import { SessionFilesRepository } from '@nimbalyst/runtime/storage/repositories/SessionFilesRepository';
import { MetaAgentService } from '../MetaAgentService';

const PREFETCHED = {
  title: 'Child: research',
  provider: 'antigravity-gemini-agent',
  model: 'antigravity-gemini-agent:gemini-3-flash-agent',
  status: 'idle',
  lastActivity: 1,
  createdAt: 1,
  updatedAt: 2,
  worktreeId: null,
};

describe('MetaAgentService buildSessionResultData full child response (FIX A)', () => {
  it('returns the full final response in fullResponse while lastResponse stays a 500-char preview', async () => {
    // A long, substantive child report (the kind the meta-agent must synthesize).
    const longReport = 'R'.repeat(2000);
    vi.mocked(AgentMessagesRepository.list).mockResolvedValue([
      { direction: 'input', content: 'do the research', metadata: null },
      { direction: 'output', content: longReport, metadata: null },
    ] as never);

    const service = MetaAgentService.getInstance();
    const data = await (service as any).buildSessionResultData('child-1', '/ws', PREFETCHED);

    // lastResponse: the short notification preview - truncated at 500 + ellipsis.
    expect(data.lastResponse).not.toBeNull();
    expect(data.lastResponse.length).toBe(503);
    expect(data.lastResponse.endsWith('...')).toBe(true);

    // fullResponse: the meta-agent's real material - the complete 2000 chars,
    // NOT truncated, NOT ending in an ellipsis.
    expect(data.fullResponse).toBe(longReport);
    expect(data.fullResponse.length).toBe(2000);
    expect(data.fullResponse.endsWith('...')).toBe(false);
  });

  // The [Child Session Update] is built from recentMessages. Cut at 2,000 the
  // child's report nearly always arrived incomplete and the parent fetched the
  // whole result to read its ending.
  it('keeps the final report whole in recentMessages up to 8,000 characters; earlier messages stay at 2,000', async () => {
    vi.mocked(AgentMessagesRepository.list).mockResolvedValue([
      { direction: 'input', content: 'do the research', metadata: null },
      { direction: 'output', content: 'N'.repeat(3000), metadata: null },
      { direction: 'output', content: 'R'.repeat(6000), metadata: null },
    ] as never);

    const data = await (MetaAgentService.getInstance() as any).buildSessionResultData('child-6', '/ws', PREFETCHED);
    const outputs = data.recentMessages.filter((m: { direction: string }) => m.direction === 'output');

    expect(outputs.at(-1).text).toBe('R'.repeat(6000));
    expect(outputs[0].text.startsWith('N'.repeat(2000) + '... [truncated: 1000 more characters')).toBe(true);
  });

  it('marks a final report cut at the cap so the parent knows to fetch the rest', async () => {
    vi.mocked(AgentMessagesRepository.list).mockResolvedValue([
      { direction: 'output', content: 'R'.repeat(9500), metadata: null },
    ] as never);

    const data = await (MetaAgentService.getInstance() as any).buildSessionResultData('child-7', '/ws', PREFETCHED);

    expect(data.recentMessages).toHaveLength(1);
    expect(data.recentMessages[0].text).toBe(
      'R'.repeat(8000) + '... [truncated: 1500 more characters; get_session_result has the full text]',
    );
  });

  it('does not truncate a response already under the preview cap (full == preview)', async () => {
    const shortReport = 'concise finding at file.ts:42';
    vi.mocked(AgentMessagesRepository.list).mockResolvedValue([
      { direction: 'output', content: shortReport, metadata: null },
    ] as never);

    const service = MetaAgentService.getInstance();
    const data = await (service as any).buildSessionResultData('child-2', '/ws', PREFETCHED);

    expect(data.lastResponse).toBe(shortReport);
    expect(data.fullResponse).toBe(shortReport);
  });

  it('captures the full final turn (all output messages since the last input), not just the last message', async () => {
    vi.mocked(AgentMessagesRepository.list).mockResolvedValue([
      { direction: 'input', content: 'do the research', metadata: null },
      { direction: 'output', content: 'PART_ONE_narration reading fileA.ts:10', metadata: null },
      { direction: 'output', content: 'PART_TWO_final the answer is X', metadata: null },
    ] as never);

    const service = MetaAgentService.getInstance();
    const data = await (service as any).buildSessionResultData('child-3', '/ws', PREFETCHED);

    // fullResponse concatenates the whole turn - both output messages present.
    expect(data.fullResponse).toContain('PART_ONE_narration');
    expect(data.fullResponse).toContain('PART_TWO_final');
    // lastResponse preview is only the single last message (decapitated) -
    // which is exactly why fullResponse is needed for synthesis.
    expect(data.lastResponse).toContain('PART_TWO_final');
    expect(data.lastResponse).not.toContain('PART_ONE_narration');
  });
});

// #1244: SessionFilesRepository stores one row per edit EVENT on purpose (its
// dedupe is keyed on toolUseId, not on path), so a child that edits one file
// twenty times yields twenty rows. Every consumer of editedFiles wants the set
// of files touched, so the unique-path pass belongs here at the seam.
describe('MetaAgentService buildSessionResultData editedFiles dedupe (#1244)', () => {
  it('reports each edited path once, in first-edit order, however many edit events it has', async () => {
    vi.mocked(AgentMessagesRepository.list).mockResolvedValue([] as never);
    vi.mocked(SessionFilesRepository.getFilesBySession).mockResolvedValue([
      { filePath: '/ws/src/a.ts' },
      { filePath: '/ws/src/b.ts' },
      { filePath: '/ws/src/a.ts' },
      { filePath: '/ws/src/a.ts' },
      { filePath: '/ws/src/b.ts' },
    ] as never);

    const service = MetaAgentService.getInstance();
    const data = await (service as any).buildSessionResultData('child-4', '/ws', PREFETCHED);

    expect(data.editedFiles).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('collapses distinct absolute paths that resolve to the same workspace-relative path', async () => {
    vi.mocked(AgentMessagesRepository.list).mockResolvedValue([] as never);
    vi.mocked(SessionFilesRepository.getFilesBySession).mockResolvedValue([
      { filePath: '/ws/src/a.ts' },
      { filePath: '/ws/./src/a.ts' },
      { filePath: '/ws/src/../src/a.ts' },
    ] as never);

    const service = MetaAgentService.getInstance();
    const data = await (service as any).buildSessionResultData('child-5', '/ws', PREFETCHED);

    expect(data.editedFiles).toEqual(['src/a.ts']);
  });
});
