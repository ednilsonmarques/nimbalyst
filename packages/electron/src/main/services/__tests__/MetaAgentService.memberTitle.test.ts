// @vitest-environment node
/**
 * NIB.102: `send_prompt({ title })` lets the team root retitle a member it
 * reuses. The authority and the title limits are checked BEFORE anything is
 * written: a refusal leaves nothing queued, no synthetic message and the title
 * unchanged. The mission is immutable and never touched.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { create: vi.fn(), updateMetadata: vi.fn(), get: vi.fn() },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({
  AgentMessagesRepository: {},
}));
vi.mock('@nimbalyst/runtime/storage/repositories/SessionFilesRepository', () => ({
  SessionFilesRepository: {},
}));
vi.mock('@nimbalyst/runtime/ai/server', () => ({
  ClaudeCodeProvider: { setMetaAgentServerPort: vi.fn() },
  OpenAICodexProvider: { setMetaAgentServerPort: vi.fn() },
  OpenAICodexACPProvider: { setMetaAgentServerPort: vi.fn() },
  SessionManager: class { async initialize() {} },
}));
vi.mock('@nimbalyst/runtime/ai/server/types', () => ({ ModelIdentifier: {} }));
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
const applySessionTitle = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../mcp/sessionNamingServer', () => ({
  applySessionTitleThroughNaming: applySessionTitle,
}));
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
  extractMessageText: vi.fn(),
  extractUserPrompts: vi.fn(),
}));
vi.mock('../ai/claudeCliLauncherSingleton', () => ({
  ClaudeCliLauncherConfig: { setMetaAgentServerPort: vi.fn() },
}));

import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { MetaAgentService } from '../MetaAgentService';

const WORKSPACE = '/workspace/path';
const ROOT = 'root-session';
const MEMBER = 'member-session';

type Row = { id: string; workspacePath: string; provider: string; metadata: Record<string, unknown> };
const row = (id: string, metadata: Record<string, unknown>): Row => ({ id, workspacePath: WORKSPACE, provider: 'claude-code', metadata });
const teamChild = (rootSessionId: string, extra: Record<string, unknown> = {}) => ({
  teamChild: { role: 'implementer', rootSessionId, depth: 1, mission: 'Fix only the validation.', ...extra },
});

function setup(rows: Row[], bypass = false) {
  const service = MetaAgentService.getInstance() as any;
  vi.mocked(AISessionsRepository.get).mockImplementation((async (id: string) => rows.find((r) => r.id === id) ?? null) as any);
  vi.spyOn(service, 'shouldBypassChildAgentExecutionForTests').mockReturnValue(bypass);
  vi.spyOn(service, 'getSessionStatusRow').mockResolvedValue({ id: MEMBER, status: 'idle' });
  const persistSynthetic = vi.spyOn(service, 'persistSyntheticInputMessage').mockResolvedValue(undefined);
  const queuePromptForSession = vi.fn().mockResolvedValue({ id: 'queued-1', prompt: 'next task' });
  service.aiService = {
    queuePromptForSession,
    interruptCurrentTurn: vi.fn(),
    driveQueuedPrompts: vi.fn(),
    triggerQueuedPromptProcessingForSession: vi.fn().mockResolvedValue(true),
  };
  const send = (origin: string, target: string, title?: unknown) =>
    service.sendPromptToSession(origin, target, WORKSPACE, 'next task', false, 'instruction', title === undefined ? undefined : { title });
  return { service, queuePromptForSession, persistSynthetic, send };
}

const TEAM = [row(ROOT, { teamMode: true }), row(MEMBER, teamChild(ROOT))];

function expectUntouched(h: ReturnType<typeof setup>) {
  expect(h.queuePromptForSession).not.toHaveBeenCalled();
  expect(h.persistSynthetic).not.toHaveBeenCalled();
  expect(applySessionTitle).not.toHaveBeenCalled();
  expect(AISessionsRepository.updateMetadata).not.toHaveBeenCalled();
}

describe('send_prompt title: authority', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    applySessionTitle.mockClear();
    vi.mocked(AISessionsRepository.get).mockReset();
    vi.mocked(AISessionsRepository.updateMetadata).mockReset();
  });

  it('the team root retitles its own member once the prompt is queued and before the member is driven; the mission is untouched', async () => {
    const h = setup(TEAM);
    const result = JSON.parse(await h.send(ROOT, MEMBER, '  Fix   the login\nbug '));
    expect(applySessionTitle).toHaveBeenCalledTimes(1);
    // applySessionTitleThroughNaming reaches SessionNamingService.applySessionTitle, the funnel that marks the session named and broadcasts session:title-updated.
    expect(applySessionTitle).toHaveBeenCalledWith(MEMBER, 'Fix the login bug');
    expect(h.queuePromptForSession).toHaveBeenCalledTimes(1);
    // NIB.108: queued first, so a queue failure never leaves a renamed member without its task...
    expect(h.queuePromptForSession.mock.invocationCallOrder[0]).toBeLessThan(applySessionTitle.mock.invocationCallOrder[0]);
    // ...and titled before the drive, so the member starts its turn under the new title.
    const drive = h.service.aiService.triggerQueuedPromptProcessingForSession;
    expect(applySessionTitle.mock.invocationCallOrder[0]).toBeLessThan(drive.mock.invocationCallOrder[0]);
    expect(result.queuedPromptId).toBe('queued-1');
    expect(result.titleError).toBeUndefined();
    expect(AISessionsRepository.updateMetadata).not.toHaveBeenCalled();
  });

  it('with interrupt, the title lands after the queue and before the interrupt and the drive', async () => {
    const h = setup(TEAM);
    vi.spyOn(h.service, 'getSessionStatusRow').mockResolvedValue({ id: MEMBER, status: 'running' });
    vi.spyOn(h.service, 'reasonToSkipInterrupt').mockReturnValue(null);
    h.service.aiService.interruptCurrentTurn.mockResolvedValue({ success: true, method: 'abort' });
    h.service.aiService.driveQueuedPrompts.mockResolvedValue({ kind: 'dispatched' });

    await h.service.sendPromptToSession(ROOT, MEMBER, WORKSPACE, 'next task', true, 'instruction', { title: 'Urgent fix' });

    const order = [
      h.queuePromptForSession.mock.invocationCallOrder[0],
      applySessionTitle.mock.invocationCallOrder[0],
      h.service.aiService.interruptCurrentTurn.mock.invocationCallOrder[0],
      h.service.aiService.driveQueuedPrompts.mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('without a title the result carries no titleError key', async () => {
    const h = setup(TEAM);
    const result = JSON.parse(await h.send(ROOT, MEMBER));
    expect('titleError' in result).toBe(false);
  });

  it('the bypass branch reports a failed title write instead of throwing', async () => {
    const h = setup(TEAM, true);
    applySessionTitle.mockRejectedValueOnce(new Error('naming down'));
    const result = JSON.parse(await h.send(ROOT, MEMBER, 'Review round 3'));
    expect(h.persistSynthetic).toHaveBeenCalledTimes(1);
    expect(result.titleError).toMatch(/naming down/);
  });

  it('a queue failure leaves the member\'s title unchanged (NIB.108)', async () => {
    const h = setup(TEAM);
    h.queuePromptForSession.mockRejectedValueOnce(new Error('queue down'));
    await expect(h.send(ROOT, MEMBER, 'New task title')).rejects.toThrow(/queue down/);
    expect(applySessionTitle).not.toHaveBeenCalled();
  });

  it('a title write that fails after queueing does not fail the send: the task is queued and driven, and the failure is reported', async () => {
    const h = setup(TEAM);
    applySessionTitle.mockRejectedValueOnce(new Error('naming down'));
    const result = JSON.parse(await h.send(ROOT, MEMBER, 'New task title'));
    expect(result.queuedPromptId).toBe('queued-1');
    expect(h.service.aiService.triggerQueuedPromptProcessingForSession).toHaveBeenCalledTimes(1);
    expect(result.titleError).toMatch(/naming down/);
  });

  it('an omitted title keeps today\'s behavior: no title write', async () => {
    const h = setup(TEAM);
    await h.send(ROOT, MEMBER);
    expect(applySessionTitle).not.toHaveBeenCalled();
    expect(h.queuePromptForSession).toHaveBeenCalledTimes(1);
  });

  it('refuses a member that is not the root, leaving nothing queued and the title unchanged', async () => {
    const sibling = row('sibling', teamChild(ROOT));
    const h = setup([...TEAM, sibling]);
    await expect(h.send('sibling', MEMBER, 'Hijack')).rejects.toThrow(/team root/);
    expectUntouched(h);
  });

  it('refuses a caller outside any team', async () => {
    const h = setup([...TEAM, row('plain', {})]);
    await expect(h.send('plain', MEMBER, 'Hijack')).rejects.toThrow(/team root/);
    expectUntouched(h);
  });

  it('refuses a target that belongs to another team', async () => {
    const h = setup([...TEAM, row('foreign', teamChild('other-root'))]);
    await expect(h.send(ROOT, 'foreign', 'Hijack')).rejects.toThrow(/own members/);
    expectUntouched(h);
  });

  it('refuses a target that is not a team member at all', async () => {
    const h = setup([...TEAM, row('plain', {})]);
    await expect(h.send(ROOT, 'plain', 'Hijack')).rejects.toThrow(/own members/);
    expectUntouched(h);
  });

  it('refuses the root retitling itself', async () => {
    const h = setup(TEAM);
    await expect(h.send(ROOT, ROOT, 'Renamed root')).rejects.toThrow(/own members/);
    expectUntouched(h);
  });

  it('refuses an invalid title (blank, too long, non-string, [Child Session Update]) before any write', async () => {
    for (const title of ['   ', 'x'.repeat(101), 42, '[Child Session Update] Session: "x"']) {
      applySessionTitle.mockClear();
      vi.mocked(AISessionsRepository.updateMetadata).mockClear();
      const h = setup(TEAM);
      await expect(h.send(ROOT, MEMBER, title), String(title)).rejects.toThrow();
      expectUntouched(h);
    }
  });

  it('the execution-bypass branch for tests applies the same rules and the same title', async () => {
    const refused = setup([...TEAM, row('sibling', teamChild(ROOT))], true);
    await expect(refused.send('sibling', MEMBER, 'Hijack')).rejects.toThrow(/team root/);
    expectUntouched(refused);

    applySessionTitle.mockClear();
    const ok = setup(TEAM, true);
    const result = JSON.parse(await ok.send(ROOT, MEMBER, 'Review round 2'));
    expect(result.bypassedExecutionForTest).toBe(true);
    expect(applySessionTitle).toHaveBeenCalledWith(MEMBER, 'Review round 2');
    expect(ok.persistSynthetic).toHaveBeenCalledTimes(1);
    expect(ok.queuePromptForSession).not.toHaveBeenCalled();
  });
});
