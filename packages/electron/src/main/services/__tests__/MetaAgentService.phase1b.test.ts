import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Phase 1B: when an architect settles with a valid Tool Manifest, the host
// stores it as a `tool-manifest` tracker item and the coordinator gets, after
// the [Child Session Update], a short system notice naming the item: one queue
// drive, no duplicated body, nothing on a replay, nothing for a TOO LONG or an
// INVALID report, nothing when trackers are off, and never a blocked update
// when the tracker fails.
//
// Mock surface mirrors MetaAgentService.phase1a1.test.ts.
const trackers = vi.hoisted(() => ({ enabled: true }));
const tracker = vi.hoisted(() => ({
  items: [] as Array<Record<string, unknown>>,
  created: [] as Array<Record<string, unknown>>,
  statuses: [] as Array<[string, string]>,
  workspaces: [] as string[],
  failWith: null as Error | null,
  failStatusFor: null as string | null,
  hang: false,
  delayMs: 0,
  reset() {
    this.items = []; this.created = []; this.statuses = []; this.workspaces = [];
    this.failWith = null; this.failStatusFor = null; this.hang = false; this.delayMs = 0;
  },
}));

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
vi.mock('../../utils/store', () => ({ getDefaultAIModel: () => null, isTrackersAgentToolsEnabled: () => trackers.enabled }));
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
let signatureCounter = 0;
vi.mock('../metaAgentNotificationSignature', () => ({
  computeNotificationSignature: vi.fn(() => `sig-${++signatureCounter}`),
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
// The tracker, in memory: what the real port does through the document service.
vi.mock('../team/toolManifestTrackerPort', () => ({
  withToolManifestTrackerPort: async (workspacePath: string, fn: (port: unknown) => Promise<unknown>) => fn({
    listTeamManifests: async (rootSessionId: string) => {
      tracker.workspaces.push(workspacePath);
      if (tracker.hang) return new Promise(() => {});
      if (tracker.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, tracker.delayMs));
      if (tracker.failWith) throw tracker.failWith;
      return tracker.items.filter((item) => item.teamRootSessionId === rootSessionId).map((item) => ({
        itemId: item.itemId, ref: item.ref, manifestId: item.manifestId, status: item.status,
        architectSessionId: item.architectSessionId, declaredManifestId: item.declaredManifestId ?? null, contentHash: item.contentHash, archived: false,
      }));
    },
    create: async (payload: { title: string; description: string; status: string; customFields: Record<string, unknown> }) => {
      const n = tracker.items.length + 1;
      const item = { itemId: `item-${n}`, ref: `NIB.${30 + n}`, status: payload.status, title: payload.title, description: payload.description, ...payload.customFields };
      tracker.items.push(item);
      tracker.created.push(payload);
      return { itemId: item.itemId, ref: item.ref };
    },
    setStatus: async (itemId: string, status: string) => {
      if (tracker.failStatusFor === itemId) throw new Error('row gone');
      tracker.statuses.push([itemId, status]);
      const item = tracker.items.find((candidate) => candidate.itemId === itemId);
      if (item) item.status = status;
    },
  }),
}));

import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { AgentMessagesRepository } from '@nimbalyst/runtime/storage/repositories/AgentMessagesRepository';
import { setLanguage } from '@nimbalyst/runtime/i18n';
import { TOOL_MANIFEST_MAX_CHARS } from '@nimbalyst/runtime/ai/server/providers/toolManifest';
import { database } from '../../database/PGLiteDatabaseWorker';
import { deletePendingToolManifestNotices } from '../ai/pendingChildUpdates';
import { MetaAgentService } from '../MetaAgentService';

const fromParent = { promptProvenance: { actor: 'agent', origin: 'session-orchestration', originSessionId: 'parent-1' } };
const parentRow = { id: 'parent-1', workspacePath: '/ws', agentRole: 'standard', metadata: { teamMode: true }, createdBySessionId: null };

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'child-1',
    title: 'Architect',
    provider: 'claude-code',
    model: 'claude-code:opus',
    agentRole: 'standard',
    workspacePath: '/ws',
    worktreeId: null,
    createdBySessionId: 'parent-1',
    metadata: { toolScope: 'read', teamChild: { role: 'architect', rootSessionId: 'parent-1', depth: 1 } },
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

const VALID_YAML = [
  'toolManifest: 1',
  'id: M-1',
  'task: "Make formatGreeting reject blank names"',
  'objective: "npm test green with the new tests"',
  'oracle:',
  '  sourceOfTruth: "test/greeting.test.js"',
  '  evidenceRequired: ["npm test output"]',
  'teamPlan:',
  '  recommended: TEAM',
  '  members:',
  '    - { role: implementer, scope: full, why: owns the files }',
  '    - { role: reviewer, scope: review, why: independent check }',
  'eccCapabilities:',
  '  - { id: "ecc:skill:tdd-workflow", for: implementer, class: A, purpose: tests first }',
  'toolsAllowed:',
  '  implementer: [Read, Edit, Bash]',
  '  reviewer: [Read, run_project_tests]',
  'toolsForbidden: [WebFetch]',
  'mcpRecommended: []',
  'mcpForbidden: []',
  'testsRequired:',
  '  - { name: T1, how: "npm test", gate: blocking }',
  'validationStrategy: "tests first"',
  'risks:',
  '  - { id: R1, severity: low, text: "trim on output", mitigation: "guard only" }',
  'openQuestions: []',
  'doneCriteria: ["npm test green"]',
  'limitations: ["no commit"]',
  'evidence: ["src/greeting.js"]',
  'confidence: high',
  'generatedBy: { role: architect, model: claude-code:opus, ecc: 2.2.3 }',
].join('\n');

function manifestMessage(yaml = VALID_YAML, padding = 0): string {
  return '```yaml\n' + yaml + '\n```\n\n## Notes\n' + 'x'.repeat(padding) + '\n\nPreparation: complete';
}

describe('architect settle with a Tool Manifest (Phase 1B)', () => {
  let service: any;
  let queued: ReturnType<typeof vi.fn>;
  let triggered: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await setLanguage('en');
    tracker.reset();
    trackers.enabled = true;
    vi.mocked(database.query).mockClear();
    vi.mocked(deletePendingToolManifestNotices).mockClear();
    service = MetaAgentService.getInstance() as any;
    service.manifestPersistenceChains.clear();
    service.manifestPersistenceTimeoutMs = 15_000;
    queued = vi.fn().mockResolvedValue({ id: 'q1' });
    triggered = vi.fn().mockResolvedValue(undefined);
    service.aiService = { queuePromptForSession: queued, triggerQueuedPromptProcessingForSession: triggered };
    vi.spyOn(service, 'listPendingInteractivePrompts').mockResolvedValue([]);
  });

  function settle(finalMessage: string, childRow = row()) {
    vi.mocked(AISessionsRepository.get).mockImplementation(async (id: string) => (id === 'parent-1' ? parentRow : childRow) as never);
    vi.mocked(AgentMessagesRepository.list).mockResolvedValue([
      { direction: 'input', content: 'TASK', metadata: fromParent },
      { direction: 'output', content: finalMessage, metadata: null },
    ] as never);
    return service.handleChildSessionEvent('child-1', 'session:completed');
  }

  it('stores the manifest with host provenance and queues the update, then the notice, on one drive', async () => {
    const message = manifestMessage();
    await settle(message);

    expect(tracker.created).toHaveLength(1);
    expect(tracker.created[0]).toMatchObject({
      title: 'M-1: Make formatGreeting reject blank names',
      status: 'draft',
      description: message,
      customFields: { manifestId: 'M-1', teamRootSessionId: 'parent-1', architectSessionId: 'child-1', generatedByRole: 'architect', model: 'claude-code:opus', confidence: 'high' },
    });

    expect(queued).toHaveBeenCalledTimes(2);
    const [updateCall, noticeCall] = queued.mock.calls;
    expect(updateCall[0]).toBe('parent-1');
    expect(updateCall[1]).toMatch(/^\[Child Session Update\]/);
    expect(updateCall[1]).toContain(message);
    // NIB.25: the reference travels in the update itself, so the coordinator has it in the same turn as the manifest.
    expect(updateCall[1]).toContain('Tool Manifest stored: M-1 as tracker item NIB.31 (status draft). Accept it with tracker_update { id: "NIB.31", status: "accepted" }');
    expect(updateCall[1].indexOf('Tool Manifest stored:')).toBeLessThan(updateCall[1].indexOf('Recent messages:'));
    expect(updateCall[3]).toMatchObject({ promptProvenance: { actor: 'agent', origin: 'child-session-update', messageKind: 'report', originSessionId: 'child-1' } });
    expect(noticeCall[0]).toBe('parent-1');
    expect(noticeCall[1]).toMatch(/^\[Tool Manifest\] M-1 from the architect \(session child-1\) is stored as tracker item NIB\.31 \(confidence: high\)/);
    expect(noticeCall[1]).not.toContain('toolManifest: 1');
    expect(noticeCall[1].length).toBeLessThan(900);
    expect(noticeCall[3]).toEqual({
      promptOrigin: 'tool_manifest',
      promptProvenance: { actor: 'system', origin: 'session-orchestration', messageKind: 'status' },
    });
    // One wake for both rows; stale notices of this architect are dropped before the new one is queued.
    expect(triggered).toHaveBeenCalledTimes(1);
    expect(deletePendingToolManifestNotices).toHaveBeenCalledWith('parent-1', 'child-1');
    // The team root got its short pointer, through the host's own statement.
    const refWrite = vi.mocked(database.query).mock.calls.find(([sql]) => String(sql).includes('UPDATE ai_sessions SET metadata'));
    expect(refWrite).toBeDefined();
    expect(JSON.parse(refWrite![1]![0] as string)).toEqual({ toolManifestRef: { itemId: 'item-1', ref: 'NIB.31', manifestId: 'M-1', architectSessionId: 'child-1', at: expect.any(String) } });
    expect(refWrite![1]![1]).toBe('parent-1');
  });

  it('a replayed settle stores nothing twice and sends no second notice', async () => {
    const message = manifestMessage();
    await settle(message);
    queued.mockClear();
    triggered.mockClear();
    await settle(message);
    expect(tracker.created).toHaveLength(1);
    expect(queued).toHaveBeenCalledTimes(1);
    expect(queued.mock.calls[0][1]).toMatch(/^\[Child Session Update\]/);
    // NIB.25: nothing was stored again, so the replayed update names no stored item either.
    expect(queued.mock.calls[0][1]).not.toContain('Tool Manifest stored:');
    expect(triggered).toHaveBeenCalledTimes(1);
    expect(deletePendingToolManifestNotices).toHaveBeenCalledTimes(1);
  });

  it('a follow-up M-2 supersedes M-1 and the notice says so', async () => {
    await settle(manifestMessage());
    queued.mockClear();
    await settle(manifestMessage(VALID_YAML.replace('id: M-1', 'id: M-2\nsupersedes: M-1')));
    expect(tracker.created).toHaveLength(2);
    expect(tracker.created[1].customFields).toMatchObject({ manifestId: 'M-2', supersedes: ['item-1'] });
    expect(tracker.statuses).toEqual([['item-1', 'superseded']]);
    expect(tracker.items[0].status).toBe('superseded');
    expect(queued).toHaveBeenCalledTimes(2);
    expect(queued.mock.calls[1][1]).toContain('[Tool Manifest] M-2 from the architect');
    expect(queued.mock.calls[1][1]).toContain('It supersedes M-1 (NIB.31), now marked superseded: M-2 is the current manifest.');
    // NIB.25: the update of M-2 already names the new item and what it superseded.
    expect(queued.mock.calls[0][1]).toMatch(/Tool Manifest stored: M-2 as tracker item \S+ \(status draft; supersedes M-1 \(NIB\.31\)\)/);
  });

  it('a TOO LONG or INVALID report is never stored; the update still carries the notice line of 1A.1', async () => {
    await settle(manifestMessage(VALID_YAML, TOOL_MANIFEST_MAX_CHARS));
    expect(tracker.created).toHaveLength(0);
    expect(queued).toHaveBeenCalledTimes(1);
    expect(queued.mock.calls[0][1]).toContain('MANIFEST TOO LONG');
    expect(queued.mock.calls[0][1]).not.toContain('Tool Manifest stored:');
    queued.mockClear();
    await settle(manifestMessage(VALID_YAML.replace('confidence: high', 'confidence: certain')));
    expect(tracker.created).toHaveLength(0);
    expect(queued).toHaveBeenCalledTimes(1);
    expect(queued.mock.calls[0][1]).toContain('MANIFEST INVALID');
    expect(queued.mock.calls[0][1]).not.toContain('Tool Manifest stored:');
  });

  it('only an architect\'s settle is a manifest: an implementer reporting the same text stores nothing', async () => {
    await settle(manifestMessage(), row({ metadata: { toolScope: 'full', teamChild: { role: 'implementer', rootSessionId: 'parent-1', depth: 1 } } }));
    expect(tracker.created).toHaveLength(0);
    expect(queued).toHaveBeenCalledTimes(1);
  });

  it('with the workspace\'s tracker tools off nothing is stored and the update goes out as before', async () => {
    trackers.enabled = false;
    await settle(manifestMessage());
    expect(tracker.created).toHaveLength(0);
    expect(queued).toHaveBeenCalledTimes(1);
    expect(queued.mock.calls[0][1]).toContain('Preparation: complete');
  });

  it('the item lives in the coordinator\'s workspace, whatever the architect\'s path says', async () => {
    await settle(manifestMessage(), row({ workspacePath: '/elsewhere' }));
    expect(tracker.created).toHaveLength(1);
    expect(tracker.workspaces).toEqual(['/ws']);
  });

  it('a coordinator running in a worktree gets the item stored in that worktree, where its tracker tools resolve references (pilot G)', async () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'team-root-worktree-'));
    try {
      const worktreeParent = { ...parentRow, worktreeId: 'wt-1', worktreePath: worktree };
      vi.mocked(AISessionsRepository.get).mockImplementation(async (id: string) => (id === 'parent-1' ? worktreeParent : row()) as never);
      vi.mocked(AgentMessagesRepository.list).mockResolvedValue([
        { direction: 'input', content: 'TASK', metadata: fromParent },
        { direction: 'output', content: manifestMessage(), metadata: null },
      ] as never);
      await service.handleChildSessionEvent('child-1', 'session:completed');
      expect(tracker.created).toHaveLength(1);
      expect(tracker.workspaces).toEqual([worktree]);
      expect(queued.mock.calls[0][1]).toContain('Tool Manifest stored: M-1 as tracker item NIB.31 (status draft)');
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('two architects of one team settling together are numbered in turn: M-1 then M-2, never two M-1', async () => {
    tracker.delayMs = 15;
    vi.mocked(AISessionsRepository.get).mockImplementation(async (id: string) => (id === 'parent-1' ? parentRow : row({ id })) as never);
    vi.mocked(AgentMessagesRepository.list).mockResolvedValue([
      { direction: 'input', content: 'TASK', metadata: fromParent },
      { direction: 'output', content: manifestMessage(), metadata: null },
    ] as never);
    await Promise.all([
      service.handleChildSessionEvent('child-1', 'session:completed'),
      service.handleChildSessionEvent('child-2', 'session:completed'),
    ]);
    expect(tracker.created.map((item) => (item.customFields as Record<string, unknown>).manifestId)).toEqual(['M-1', 'M-2']);
    expect(tracker.created[1].customFields).toMatchObject({ declaredManifestId: 'M-1', supersedes: ['item-1'] });
    expect(tracker.statuses).toEqual([['item-1', 'superseded']]);
    expect(tracker.items.map((item) => item.status)).toEqual(['superseded', 'draft']);
  });

  it('a supersede the tracker refuses is named in the notice', async () => {
    await settle(manifestMessage());
    queued.mockClear();
    tracker.failStatusFor = 'item-1';
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await settle(manifestMessage(VALID_YAML.replace('id: M-1', 'id: M-2\nsupersedes: M-1')));
    } finally {
      warnings.mockRestore();
    }
    expect(tracker.created).toHaveLength(2);
    expect(tracker.items[0].status).toBe('draft');
    expect(queued.mock.calls[1][1]).toContain('Nimbalyst could not mark M-1 (NIB.31) as superseded; M-2 is still the current manifest, as the newest id.');
  });

  it('a hung tracker never holds the update back: past the timeout it goes out without a notice', async () => {
    tracker.hang = true;
    service.manifestPersistenceTimeoutMs = 30;
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await settle(manifestMessage());
      expect(queued).toHaveBeenCalledTimes(1);
      expect(queued.mock.calls[0][1]).toMatch(/^\[Child Session Update\]/);
      expect(triggered).toHaveBeenCalledTimes(1);
      expect(warnings).toHaveBeenCalledWith(expect.stringContaining('not stored within 30 ms'));
      // The abandoned chain does not block the team's next settle.
      expect(service.manifestPersistenceChains.size).toBe(0);
    } finally {
      warnings.mockRestore();
    }
  });

  it('a tracker failure is logged and never blocks the update', async () => {
    tracker.failWith = new Error('tracker unavailable');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await settle(manifestMessage());
      expect(tracker.created).toHaveLength(0);
      expect(queued).toHaveBeenCalledTimes(1);
      expect(queued.mock.calls[0][1]).toMatch(/^\[Child Session Update\]/);
      expect(triggered).toHaveBeenCalledTimes(1);
      expect(errors).toHaveBeenCalledWith(expect.stringContaining('Tool Manifest of session child-1 not stored: tracker unavailable'));
    } finally {
      errors.mockRestore();
    }
  });
});
