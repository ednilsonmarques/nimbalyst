import { beforeEach, describe, expect, it, vi } from 'vitest';

// Continuity on failure: a Team mode member whose turn ends in error wakes its
// coordinator once per failure (the coordinator then decides: a new
// hypothesis, a decision for the user, or an impediment), never silently
// leaving it asleep; a repeated event of the same failure wakes nobody; the
// host retries nothing and the wake carries the same provenance as any child
// update; outside Team mode an error settle still only queues the update.
// Mock surface mirrors MetaAgentService.phase1b.test.ts.
const sig = vi.hoisted(() => ({ next: 0, fixed: null as string | null }));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { create: vi.fn(), updateMetadata: vi.fn(), get: vi.fn() },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({
  AgentMessagesRepository: { list: vi.fn(), create: vi.fn() },
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
  usesHostSuppliedToolLoop: () => false,
}));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../SyncManager', () => ({ getSyncProvider: () => ({ pushChange: vi.fn() }) }));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn() }));
vi.mock('../../utils/store', () => ({ getDefaultAIModel: () => null, isTrackersAgentToolsEnabled: () => false }));
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
vi.mock('../metaAgentNotificationSignature', () => ({
  // A distinct failure has a distinct signature; `fixed` replays the same one.
  computeNotificationSignature: vi.fn(() => sig.fixed ?? `sig-${++sig.next}`),
}));
vi.mock('../ai/pendingChildUpdates', () => ({
  deletePendingChildUpdates: vi.fn().mockResolvedValue(undefined),
  deletePendingToolManifestNotices: vi.fn().mockResolvedValue(undefined),
}));
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
import { MetaAgentService } from '../MetaAgentService';

const ROOT = { id: 'root', workspacePath: '/ws', agentRole: 'standard', metadata: { teamMode: true }, createdBySessionId: null };
const member = (id: string, role = 'implementer') => ({
  id, title: id, provider: 'claude-code', model: 'claude-code:sonnet', agentRole: 'standard', workspacePath: '/ws', worktreeId: null,
  createdBySessionId: 'root', metadata: { toolScope: 'full', teamChild: { role, rootSessionId: 'root', depth: 1 } }, createdAt: 1, updatedAt: 2,
});
const PLAIN_PARENT = { id: 'plain-parent', workspacePath: '/ws', agentRole: 'standard', metadata: {}, createdBySessionId: null };
const PLAIN_CHILD = { ...member('plain-child'), createdBySessionId: 'plain-parent', metadata: {} };

const ROWS: Record<string, unknown> = {
  root: ROOT, 'member-a': member('member-a'), 'member-b': member('member-b', 'reviewer'), 'plain-parent': PLAIN_PARENT, 'plain-child': PLAIN_CHILD,
};

let service: any;
let queued: ReturnType<typeof vi.fn>;
let triggered: ReturnType<typeof vi.fn>;
let parentStatus: string;

beforeEach(() => {
  sig.next = 0;
  sig.fixed = null;
  parentStatus = 'idle';
  service = MetaAgentService.getInstance() as any;
  service.notificationSignatures.clear();
  service.teamErrorWakes.clear();
  queued = vi.fn().mockResolvedValue({ id: 'q' });
  triggered = vi.fn().mockResolvedValue(undefined);
  service.aiService = { queuePromptForSession: queued, triggerQueuedPromptProcessingForSession: triggered };
  vi.spyOn(service, 'listPendingInteractivePrompts').mockResolvedValue([]);
  vi.spyOn(service, 'getSessionStatusRow').mockImplementation(async () => ({ status: parentStatus }));
  vi.mocked(AISessionsRepository.get).mockImplementation(async (id: string) => (ROWS[id] ?? null) as never);
  vi.mocked(AgentMessagesRepository.list).mockResolvedValue([
    { direction: 'input', content: 'TASK', metadata: null },
    { direction: 'output', content: 'Error: the provider failed', metadata: null },
  ] as never);
});

const settle = (id: string, event: 'session:completed' | 'session:error') => service.handleChildSessionEvent(id, event);
const errorUpdates = () => queued.mock.calls.filter(([, , , ctx]) => ctx?.promptProvenance?.messageKind === 'error');

describe('a Team mode member that fails wakes its coordinator', () => {
  it('1: a successful settle still queues the report and wakes the coordinator, as before', async () => {
    await settle('member-a', 'session:completed');
    expect(queued).toHaveBeenCalledTimes(1);
    expect(queued.mock.calls[0][3].promptProvenance.messageKind).toBe('report');
    expect(triggered).toHaveBeenCalledTimes(1);
    expect(triggered).toHaveBeenCalledWith('root', '/ws', 'meta-agent');
  });

  it('2: an error settle while the coordinator waits queues one error update and wakes the coordinator exactly once', async () => {
    await settle('member-a', 'session:error');
    expect(errorUpdates()).toHaveLength(1);
    expect(queued.mock.calls[0][0]).toBe('root');
    expect(triggered).toHaveBeenCalledTimes(1);
  });

  it('3: the same failure reported again (no new turn in between) wakes nobody a second time', async () => {
    sig.fixed = 'same-failure';
    await settle('member-a', 'session:error');
    await settle('member-a', 'session:error');
    await settle('member-a', 'session:error');
    expect(errorUpdates()).toHaveLength(1);
    expect(triggered).toHaveBeenCalledTimes(1);
  });

  it('4: two different members failing produce two independent updates and wakes, never collapsed', async () => {
    await settle('member-a', 'session:error');
    await settle('member-b', 'session:error');
    expect(errorUpdates().map(([, , , ctx]) => ctx.promptProvenance.originSessionId)).toEqual(['member-a', 'member-b']);
    expect(triggered).toHaveBeenCalledTimes(2);
  });

  it('5: the host retries nothing: no prompt goes to the failed member, only the update to its coordinator', async () => {
    await settle('member-a', 'session:error');
    expect(queued.mock.calls.every(([target]) => target === 'root')).toBe(true);
    expect(AgentMessagesRepository.create).not.toHaveBeenCalled();
  });

  it('6: the wake carries the same provenance as any child update: an agent report of an error, nothing more', async () => {
    await settle('member-a', 'session:error');
    expect(queued.mock.calls[0][3]).toEqual({
      promptProvenance: { actor: 'agent', origin: 'child-session-update', messageKind: 'error', originSessionId: 'member-a' },
    });
    expect(String(queued.mock.calls[0][1])).toContain('[Child Session Update]');
  });

  it('7: outside Team mode an error settle still only queues the update and wakes nobody', async () => {
    await settle('plain-child', 'session:error');
    expect(queued).toHaveBeenCalledTimes(1);
    expect(triggered).not.toHaveBeenCalled();
  });

  it('a coordinator that is busy is not re-driven: the update waits in its queue for the turn in progress', async () => {
    parentStatus = 'running';
    await settle('member-a', 'session:error');
    expect(errorUpdates()).toHaveLength(1);
    expect(triggered).not.toHaveBeenCalled();
  });

  it('anti-loop backstop: at most three distinct failures in a row wake the coordinator; a successful settle re-arms it', async () => {
    for (let i = 0; i < 4; i += 1) {
      service.notificationSignatures.delete('member-a'); // a new turn started between failures
      await settle('member-a', 'session:error');
    }
    expect(errorUpdates()).toHaveLength(4); // every failure stays visible in the queue
    expect(triggered).toHaveBeenCalledTimes(3);
    await settle('member-a', 'session:completed');
    expect(triggered).toHaveBeenCalledTimes(4);
    await settle('member-a', 'session:error');
    expect(triggered).toHaveBeenCalledTimes(5);
  });
});
