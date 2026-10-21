import { beforeEach, describe, expect, it, vi } from 'vitest';

// A reused team member accumulates every turn in one session. Past 500 stored
// messages, get_session_result and the [Child Session Update] must still report
// the member's LATEST turn, not a frozen window of its first 500 messages.
//
// The repository double keeps the real store contract: list() returns rows in
// ascending id order and applies LIMIT to that order (PGLiteAgentMessagesStore:
// "ORDER BY id ASC LIMIT $2 OFFSET $3"), so list({ limit }) yields the OLDEST
// rows; listTail(n) yields the newest n rows, still in ascending order.
type Row = { id: number; direction: 'input' | 'output'; content: string; metadata: null };
let rows: Row[] = [];

vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { create: vi.fn(), updateMetadata: vi.fn(), get: vi.fn() },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({
  AgentMessagesRepository: {
    list: vi.fn(async (_sessionId: string, options?: { limit?: number; offset?: number }) => {
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? 50000;
      return rows.slice(offset, offset + limit);
    }),
    listTail: vi.fn(async (_sessionId: string, limit: number) => rows.slice(-limit)),
  },
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
vi.mock('../../mcp/metaAgentServer', () => ({ setMetaAgentToolFns: vi.fn() }));
vi.mock('../metaAgentNotificationSignature', () => ({ computeNotificationSignature: vi.fn() }));
vi.mock('../metaAgentMessageText', () => ({
  extractMessageText: (content: unknown) => (typeof content === 'string' ? content : ''),
  extractUserPrompts: (messages: Array<{ direction: string; content: unknown }>) =>
    messages.filter((m) => m.direction === 'input').map((m) => String(m.content)),
}));
vi.mock('../ai/claudeCliLauncherSingleton', () => ({
  ClaudeCliLauncherConfig: { setMetaAgentServerPort: vi.fn() },
}));

import { MetaAgentService } from '../MetaAgentService';

const PREFETCHED = {
  title: 'Member: implementer',
  provider: 'claude-code',
  model: 'claude-code:sonnet',
  status: 'idle',
  lastActivity: 1,
  createdAt: 1,
  updatedAt: 2,
  worktreeId: null,
};

/** One mission on the same session: its prompt, `toolChatter` intermediate outputs, then its final report. */
function appendMission(label: string, toolChatter: number): void {
  const next = () => rows.length + 1;
  rows.push({ id: next(), direction: 'input', content: `MISSAO-${label}`, metadata: null });
  for (let i = 0; i < toolChatter; i += 1) {
    rows.push({ id: next(), direction: 'output', content: `trabalho ${label} ${i}`, metadata: null });
  }
  rows.push({ id: next(), direction: 'output', content: `RESULTADO-${label}`, metadata: null });
}

async function build(options: { excludeInputFromSessionId?: string } = {}) {
  return (MetaAgentService.getInstance() as any).buildSessionResultData('member-1', '/ws', PREFETCHED, true, options);
}

describe('session result of a reused member past 500 stored messages', () => {
  beforeEach(() => {
    rows = [];
  });

  it('reports the latest mission, not a frozen window of the first 500 messages', async () => {
    appendMission('A', 248);
    appendMission('B', 248); // the session now holds 500 rows
    appendMission('C', 30); // ...and 532 after the third mission

    const data = await build();

    expect(data.lastResponse).toBe('RESULTADO-C');
    // fullResponse is the whole last turn: mission C's outputs, ending with its report.
    expect(data.fullResponse.startsWith('trabalho C 0')).toBe(true);
    expect(data.fullResponse.endsWith('RESULTADO-C')).toBe(true);
    expect(data.fullResponse).not.toMatch(/trabalho [AB]|RESULTADO-[AB]/);
    expect(data.recentMessages.at(-1).text).toBe('RESULTADO-C');
    expect(data.userPrompts.at(-1)).toBe('MISSAO-C');
  });

  it('keeps the original prompt of the session even when it falls outside the latest window', async () => {
    appendMission('A', 300);
    appendMission('B', 300);

    const data = await build();

    expect(data.originalPrompt).toBe('MISSAO-A');
    expect(data.userPrompts[0]).toBe('MISSAO-A');
    expect(data.userPrompts.at(-1)).toBe('MISSAO-B');
    expect(data.lastResponse).toBe('RESULTADO-B');
  });

  it('follows each mission in turn as the member is reused (A, then B, then C)', async () => {
    const seen: string[] = [];
    appendMission('A', 260);
    seen.push((await build()).lastResponse);
    appendMission('B', 260);
    seen.push((await build()).lastResponse);
    appendMission('C', 1); // a fast mission right after
    seen.push((await build()).lastResponse);

    expect(seen).toEqual(['RESULTADO-A', 'RESULTADO-B', 'RESULTADO-C']);
  });

  it('the notification variant (no full response, parent input excluded) also carries the latest report', async () => {
    appendMission('A', 499);
    appendMission('B', 5);

    const data = await (MetaAgentService.getInstance() as any).buildSessionResultData(
      'member-1', '/ws', PREFETCHED, false, { excludeInputFromSessionId: 'root-1' },
    );

    expect(data.lastResponse).toBe('RESULTADO-B');
    expect(data.recentMessages.at(-1).text).toBe('RESULTADO-B');
  });

  it('a session of exactly 500 rows is read whole from the window, with no repeated prompt', async () => {
    appendMission('A', 248);
    appendMission('B', 248);
    expect(rows).toHaveLength(500);

    const data = await build();

    expect(data.userPrompts).toEqual(['MISSAO-A', 'MISSAO-B']);
    expect(data.originalPrompt).toBe('MISSAO-A');
  });

  it('does not repeat the original prompt when it sits inside both the head and the window', async () => {
    // 25 output rows first, so the first prompt is row 26: inside both the 50-row head
    // and the newest-500 window (rows 21..520) of a 520-row session.
    for (let i = 0; i < 25; i += 1) {
      rows.push({ id: rows.length + 1, direction: 'output', content: `preambulo ${i}`, metadata: null });
    }
    appendMission('A', 15);
    appendMission('B', 200);
    appendMission('C', 274);
    expect(rows).toHaveLength(520);

    const data = await build();

    expect(data.userPrompts.filter((p: string) => p === 'MISSAO-A')).toHaveLength(1);
    expect(data.originalPrompt).toBe('MISSAO-A');
    expect(data.lastResponse).toBe('RESULTADO-C');
  });

  it('is unchanged for a short session', async () => {
    appendMission('A', 3);
    appendMission('B', 3);

    const data = await build();

    expect(data.originalPrompt).toBe('MISSAO-A');
    expect(data.userPrompts).toEqual(['MISSAO-A', 'MISSAO-B']);
    expect(data.lastResponse).toBe('RESULTADO-B');
  });
});
