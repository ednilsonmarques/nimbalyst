// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// NIB.49 (Consultor of the stabilization round): create_session of a Team
// mode member runs in its caller's worktree, decided by the host from the
// caller's persisted row (callerWorktreeRequest, shared with spawn_session);
// the agent's worktree arguments never move it; a team worktree gone from
// disk refuses the member, never a fallback to the main checkout; outside
// Team mode nothing changes. Mock surface mirrors
// MetaAgentService.workspaceAlias.test.ts (worktree store) and
// MetaAgentService.advisorProvider.test.ts (provider checks).
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { create: vi.fn(), updateMetadata: vi.fn(), get: vi.fn() },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({ AgentMessagesRepository: { create: vi.fn() } }));
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
/** Worktree rows the store knows, keyed by id. */
const worktreeRows = new Map<string, any>();
const createdWorktrees: string[] = [];
vi.mock('../WorktreeStore', () => ({
  createWorktreeStore: () => ({
    get: async (id: string) => worktreeRows.get(id) ?? null,
    create: vi.fn(),
    getAllNames: async () => [],
  }),
}));
vi.mock('../GitWorktreeService', () => ({
  GitWorktreeService: class {
    getExistingWorktreeDirectories() { return []; }
    async getAllBranchNames() { return []; }
    generateUniqueWorktreeName() { return 'fresh'; }
    async createWorktree(projectPath: string, options: { name: string }) {
      createdWorktrees.push(options.name);
      return { id: 'wt-fresh', projectPath, path: path.join(projectPath, '_worktrees', options.name), name: options.name };
    }
  },
}));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: { query: vi.fn().mockResolvedValue({ rows: [{ in_flight: '0', total: '0', active: '0' }] }) },
}));
vi.mock('../../database/initialize', () => ({ getDatabase: () => ({ kind: 'fake-db' }) }));
vi.mock('../../file/GitRefWatcher', () => ({ gitRefWatcher: { start: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('./ai/AIService', () => ({ AIService: class {} }));
vi.mock('../../mcp/metaAgentServer', () => ({ setMetaAgentToolFns: vi.fn() }));
vi.mock('../metaAgentNotificationSignature', () => ({ computeNotificationSignature: vi.fn() }));
vi.mock('../metaAgentMessageText', () => ({ extractMessageText: vi.fn(() => ''), extractUserPrompts: vi.fn(() => []) }));
vi.mock('../ai/claudeCliLauncherSingleton', () => ({ ClaudeCliLauncherConfig: { setMetaAgentServerPort: vi.fn() } }));
vi.mock('../team/teamCheckpoint', () => ({
  postTeamCheckpointCard: vi.fn(async () => {}),
  resolveTeamCheckpointCard: vi.fn(async () => {}),
  teamContinueActionLabel: () => 'Continue team',
}));

import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { MetaAgentService } from '../MetaAgentService';
import { callerWorktreeRequest } from '../team/teamPolicy';

const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nib49-')));
/** The main checkout (the project as opened). */
const PROJECT = path.join(TMP, 'project');
/** The team's worktree, on disk. */
const TEAM_WORKTREE = path.join(TMP, 'project_worktrees', 'team');
/** Another worktree of the same project, on disk. */
const OTHER_WORKTREE = path.join(TMP, 'project_worktrees', 'other');
/** A registered worktree whose folder was removed. */
const GONE_WORKTREE = path.join(TMP, 'project_worktrees', 'gone');
for (const dir of [PROJECT, TEAM_WORKTREE, OTHER_WORKTREE]) fs.mkdirSync(dir, { recursive: true });

const base = { provider: 'claude-code', agentRole: 'standard', workspacePath: PROJECT, sessionType: 'session', parentSessionId: null };
const ROWS: Record<string, any> = {
  'root-main': { ...base, id: 'root-main', model: 'claude-code:opus', worktreeId: null, metadata: { teamMode: true } },
  'root-wt': { ...base, id: 'root-wt', model: 'claude-code:opus', worktreeId: 'wt-team', metadata: { teamMode: true } },
  'root-gone': { ...base, id: 'root-gone', model: 'claude-code:opus', worktreeId: 'wt-gone', metadata: { teamMode: true } },
  'member-wt': {
    ...base, id: 'member-wt', model: 'claude-code:sonnet', worktreeId: 'wt-team',
    metadata: { toolScope: 'full', teamChild: { role: 'implementer', rootSessionId: 'root-wt', depth: 1 } },
  },
  'plain-wt': { ...base, id: 'plain-wt', model: 'claude-code:opus', worktreeId: 'wt-team', metadata: {} },
};

const SIGNED_IN = async (provider: string) => (provider === 'claude-code' || provider === 'openai-codex' ? true : null);

function service() {
  const svc = MetaAgentService.getInstance();
  (svc as any).aiService = { queuePromptForSession: vi.fn(), triggerQueuedPromptProcessingForSession: vi.fn(), isProviderEnabledForTeamMember: () => true };
  svc.setProviderAuthenticationCheck(SIGNED_IN);
  svc.setProviderVersionCheck(null);
  return svc as any;
}

/** create_session as the MCP tool calls it: the agent's arguments go in verbatim. */
async function createSession(callerId: string, args: Record<string, unknown>) {
  return JSON.parse(await service().createChildSession(callerId, PROJECT, { prompt: 'brief', ...args }));
}

function created() {
  return vi.mocked(AISessionsRepository.create).mock.calls.at(-1)![0] as any;
}

beforeEach(() => {
  createdWorktrees.length = 0;
  worktreeRows.clear();
  worktreeRows.set('wt-team', { id: 'wt-team', projectPath: PROJECT, path: TEAM_WORKTREE, isArchived: false });
  worktreeRows.set('wt-other', { id: 'wt-other', projectPath: PROJECT, path: OTHER_WORKTREE, isArchived: false });
  worktreeRows.set('wt-gone', { id: 'wt-gone', projectPath: PROJECT, path: GONE_WORKTREE, isArchived: false });
  vi.mocked(AISessionsRepository.create).mockReset();
  vi.mocked(AISessionsRepository.updateMetadata).mockReset();
  vi.mocked(AISessionsRepository.get).mockReset();
  vi.mocked(AISessionsRepository.get).mockImplementation(async (id: string) => (ROWS[id] ?? null) as never);
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('callerWorktreeRequest: the one rule for the checkout of a new child', () => {
  it('inherits the caller\'s worktree, keeps the main checkout for a caller without one, and only a new own worktree opts out', () => {
    expect(callerWorktreeRequest('wt-team', false)).toEqual({ useWorktree: false, worktreeId: 'wt-team' });
    expect(callerWorktreeRequest(null, false)).toEqual({ useWorktree: false, worktreeId: undefined });
    expect(callerWorktreeRequest(undefined, false)).toEqual({ useWorktree: false, worktreeId: undefined });
    expect(callerWorktreeRequest('wt-team', true)).toEqual({ useWorktree: true, worktreeId: undefined });
  });
});

describe('create_session of a Team mode member (NIB.49)', () => {
  it('1: a root in the main checkout creates its member there, as before', async () => {
    const result = await createSession('root-main', { role: 'implementer' });
    expect(result.worktreeId).toBeNull();
    expect(result.worktreeMode).toBe('none');
    expect(created().worktreeId ?? null).toBeNull();
  });

  it.each([
    ['2/3: implementer', 'implementer'],
    ['4: reviewer', 'reviewer'],
    ['architect', 'architect'],
    ['explorer', 'explorer'],
  ])('%s from a root in a worktree runs in that same worktree', async (_label, role) => {
    const result = await createSession('root-wt', { role });
    expect(result.worktreeId).toBe('wt-team');
    expect(result.worktreePath).toBe(TEAM_WORKTREE);
    expect(result.worktreeMode).toBe('existing');
    expect(created().worktreeId).toBe('wt-team');
    expect(created().metadata.teamChild.role).toBe(role);
  });

  it('5: the advisor on its Codex default runs in the team\'s worktree too', async () => {
    const result = await createSession('root-wt', { role: 'advisor', mission: 'Second opinion on the plan.' });
    expect(created().provider).toBe('openai-codex');
    expect(created().model).toBe('openai-codex:gpt-6.1-sol');
    expect(result.worktreeId).toBe('wt-team');
    expect(result.providerDiversity).toBe('diverse');
  });

  it('6: a member in the worktree creates a depth-2 member in the same worktree', async () => {
    const result = await createSession('member-wt', { role: 'explorer' });
    expect(result.worktreeId).toBe('wt-team');
    expect(created().metadata.teamChild).toMatchObject({ role: 'explorer', rootSessionId: 'root-wt', depth: 2 });
  });

  it('7: a team worktree gone from disk refuses the member, with no row and no fallback to the main checkout', async () => {
    await expect(createSession('root-gone', { role: 'reviewer' })).rejects.toThrow(/no longer exists on disk, so the member was not created; it is never moved to the main checkout/);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
    expect(createdWorktrees).toEqual([]);
  });

  it('8: a worktree id or a new-worktree request in the agent\'s arguments never moves the member', async () => {
    const fromWorktree = await createSession('root-wt', { role: 'implementer', worktreeId: 'wt-other' });
    expect(fromWorktree.worktreeId).toBe('wt-team');
    const asksNew = await createSession('root-wt', { role: 'implementer', useWorktree: true });
    expect(asksNew.worktreeId).toBe('wt-team');
    expect(createdWorktrees).toEqual([]);
    // From the main checkout, a named worktree is ignored as well.
    const fromMain = await createSession('root-main', { role: 'reviewer', worktreeId: 'wt-other' });
    expect(fromMain.worktreeId).toBeNull();
  });

  it('9: the reviewer created by create_session runs its tests in the team\'s worktree', async () => {
    const result = await createSession('root-wt', { role: 'reviewer' });
    // The row the repository returns for the new member: its worktree joined in.
    vi.mocked(AISessionsRepository.get).mockImplementation(async (id: string) =>
      (id === result.sessionId ? { id, workspacePath: PROJECT, worktreeId: result.worktreeId, worktreePath: result.worktreePath } : ROWS[id] ?? null) as never);
    expect(await service().resolveSessionWorkspaceRoot(result.sessionId)).toBe(TEAM_WORKTREE);
  });

  it('10: creating the implementer touches nothing in the main checkout', async () => {
    const before = fs.readdirSync(PROJECT);
    await createSession('root-wt', { role: 'implementer' });
    expect(fs.readdirSync(PROJECT)).toEqual(before);
    expect(createdWorktrees).toEqual([]);
    expect(created().worktreeId).toBe('wt-team');
  });
});

describe('outside Team mode and spawn_session parity', () => {
  it('F: an ordinary session keeps today\'s create_session: no inheritance, an explicit worktree id honoured', async () => {
    const plain = await createSession('plain-wt', {});
    expect(plain.worktreeId).toBeNull();
    const named = await createSession('plain-wt', { worktreeId: 'wt-other' });
    expect(named.worktreeId).toBe('wt-other');
  });

  it('F: outside a team a registered worktree is not checked on disk (behaviour unchanged)', async () => {
    const result = await createSession('plain-wt', { worktreeId: 'wt-gone' });
    expect(result.worktreeId).toBe('wt-gone');
  });

  it('spawn_session from the same root lands in the same worktree, and its own new worktree stays possible', async () => {
    const inherited = JSON.parse(await service().spawnSession('root-wt', PROJECT, { prompt: 'brief', role: 'implementer', isolated: true }));
    expect(inherited.worktreeId).toBe('wt-team');
    const own = JSON.parse(await service().spawnSession('root-wt', PROJECT, { prompt: 'brief', role: 'implementer', isolated: true, useWorktree: true }));
    expect(own.worktreeId).toBe('wt-fresh');
    expect(createdWorktrees).toEqual(['fresh']);
  });

  it('spawn_session into a team worktree gone from disk is refused the same way', async () => {
    await expect(service().spawnSession('root-gone', PROJECT, { prompt: 'brief', role: 'reviewer', isolated: true }))
      .rejects.toThrow(/no longer exists on disk/);
  });
});
