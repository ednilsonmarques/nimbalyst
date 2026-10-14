import { beforeEach, describe, expect, it, vi } from 'vitest';

// The `advisor` (Consultor Independente) and its provider through the real
// creation path: the role default provider is applied, an explicit provider is
// accepted only when the host enforces the member's scope and role policy on
// it and it is available, a refusal is explicit and creates nothing (never a
// fallback), and the provider diversity against the team root is reported in
// the creation result, in get_session_result and in the [Child Session
// Update]. Mock surface mirrors MetaAgentService.advisor.test.ts. No provider
// is ever started: every provider check is a host-side fact or a mocked
// settings read.
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { create: vi.fn(), updateMetadata: vi.fn(), get: vi.fn() },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({
  AgentMessagesRepository: { create: vi.fn(), list: vi.fn(async () => []) },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/SessionFilesRepository', () => ({
  SessionFilesRepository: { getFilesBySession: vi.fn(async () => []) },
}));
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
vi.mock('../metaAgentMessageText', () => ({ extractMessageText: vi.fn(() => ''), extractUserPrompts: vi.fn(() => []) }));
vi.mock('../ai/claudeCliLauncherSingleton', () => ({ ClaudeCliLauncherConfig: { setMetaAgentServerPort: vi.fn() } }));
vi.mock('../team/teamCheckpoint', () => ({
  postTeamCheckpointCard: vi.fn(async () => {}),
  resolveTeamCheckpointCard: vi.fn(async () => {}),
  teamContinueActionLabel: () => 'Continue team',
}));

import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { isToolDeniedForScope } from '@nimbalyst/runtime/ai/server/providers/claudeCode/toolPolicy';
import { database } from '../../database/PGLiteDatabaseWorker';
import { MetaAgentService } from '../MetaAgentService';

const ROOT = { id: 'root', provider: 'claude-code', model: 'claude-code:opus', agentRole: 'standard', workspacePath: '/ws', metadata: { teamMode: true } };
// A team whose coordinator runs on another provider: its members default to the team provider.
const ROOT_OTHER = { id: 'root-other', provider: 'openai-codex', model: 'openai-codex:gpt-5.5', agentRole: 'standard', workspacePath: '/ws', metadata: { teamMode: true } };
const MEMBER = {
  id: 'member', provider: 'claude-code', model: 'claude-code:sonnet', agentRole: 'standard', workspacePath: '/ws',
  metadata: { teamChild: { role: 'implementer', rootSessionId: 'root', depth: 1 } },
};
const MISSION = 'Read the plan, the implementation and the reviewer\'s verdict and try to prove the team\'s conclusion wrong.';
const ADVISOR = {
  id: 'adv', provider: 'claude-code', model: 'claude-code:opus', agentRole: 'standard', workspacePath: '/ws', title: 'Consultor Independente',
  status: 'idle', createdAt: 1, updatedAt: 2, worktreeId: null,
  metadata: { toolScope: 'read', effortLevel: 'high', teamChild: { role: 'advisor', rootSessionId: 'root', depth: 1, mission: MISSION } },
};
const ADVISOR_DIVERSE = { ...ADVISOR, id: 'adv-diverse', metadata: { ...ADVISOR.metadata, teamChild: { ...ADVISOR.metadata.teamChild, rootSessionId: 'root-other' } } };
const ADVISOR_ORPHAN = { ...ADVISOR, id: 'adv-orphan', metadata: { ...ADVISOR.metadata, teamChild: { ...ADVISOR.metadata.teamChild, rootSessionId: 'gone' } } };

function service(aiService: Record<string, unknown> = {}) {
  const svc = MetaAgentService.getInstance();
  (svc as any).aiService = { queuePromptForSession: vi.fn(), triggerQueuedPromptProcessingForSession: vi.fn(), ...aiService };
  return svc as any;
}

function created() {
  return vi.mocked(AISessionsRepository.create).mock.calls.at(-1)![0] as any;
}

beforeEach(() => {
  vi.mocked(AISessionsRepository.create).mockReset();
  vi.mocked(AISessionsRepository.get).mockReset();
  vi.mocked(database.query).mockReset().mockResolvedValue({ rows: [{ in_flight: '0', total: '0', active: '0' }] } as never);
  const rows: Record<string, unknown> = { root: ROOT, 'root-other': ROOT_OTHER, member: MEMBER, adv: ADVISOR, 'adv-diverse': ADVISOR_DIVERSE, 'adv-orphan': ADVISOR_ORPHAN };
  vi.mocked(AISessionsRepository.get).mockImplementation(async (id: string) => (rows[id] ?? null) as never);
});

describe('the advisor is created on its role default provider', () => {
  it('omitting provider and model gives the role default: claude-code, Opus, high, read, mission kept, diversity "same" against a claude-code root', async () => {
    const result = await service().createChildSessionInternal('root', '/ws', { role: 'advisor', mission: MISSION, prompt: 'brief' });
    const row = created();
    expect(row.provider).toBe('claude-code');
    expect(row.model).toBe('claude-code:opus');
    expect(row.metadata.toolScope).toBe('read');
    expect(row.metadata.effortLevel).toBe('high');
    expect(row.metadata.teamChild).toEqual({ role: 'advisor', rootSessionId: 'root', depth: 1, mission: MISSION });
    expect(result.provider).toBe('claude-code');
    expect(result.providerDiversity).toBe('same');
  });

  it('the role default on the caller\'s own provider never consults availability (no settings read)', async () => {
    const enabled = vi.fn(() => false);
    await service({ isProviderEnabledForTeamMember: enabled }).createChildSessionInternal('root', '/ws', { role: 'advisor' });
    expect(enabled).not.toHaveBeenCalled();
    expect(created().provider).toBe('claude-code');
  });

  it('naming the role\'s own provider without a model keeps the role\'s model default (Opus), not the caller\'s model', async () => {
    vi.mocked(AISessionsRepository.get).mockImplementation(async (id: string) => (id === 'root-sonnet'
      ? { ...ROOT, id: 'root-sonnet', model: 'claude-code:sonnet' }
      : null) as never);
    const result = await service().createChildSessionInternal('root-sonnet', '/ws', { role: 'advisor', provider: 'claude-code' });
    expect(created().model).toBe('claude-code:opus');
    expect(created().metadata.effortLevel).toBe('high');
    expect(result.providerDiversity).toBe('same');
  });

  it('an explicit model of the same provider is a promotion, not a provider change: still "same", still read', async () => {
    const result = await service().createChildSessionInternal('root', '/ws', { role: 'advisor', provider: 'claude-code', model: 'claude-code:fable', effortLevel: 'max', toolScope: 'full' });
    expect(created().model).toBe('claude-code:fable');
    expect(created().metadata.toolScope).toBe('read');
    expect(result.providerDiversity).toBe('same');
  });

  it('outside a team the result carries no diversity and the advisor role is ignored as before', async () => {
    vi.mocked(AISessionsRepository.get).mockImplementation(async (id: string) => (id === 'plain'
      ? { id: 'plain', provider: 'claude-code', model: 'claude-code:opus', agentRole: 'standard', workspacePath: '/ws', metadata: {} }
      : null) as never);
    const result = await service().createChildSessionInternal('plain', '/ws', { role: 'advisor' });
    expect(result.providerDiversity).toBeUndefined();
    expect(created().metadata.teamChild).toBeUndefined();
  });
});

describe('an independent provider that the host cannot keep read-only is refused, explicitly and without fallback', () => {
  it.each([
    ['provider and model', { provider: 'openai-codex', model: 'openai-codex:gpt-5.5' }],
    ['a model of that provider only', { model: 'openai-codex:gpt-5.5' }],
    ['a provider only', { provider: 'openai-codex' }],
  ])('requested through %s: "Independent Advisor provider unavailable", nothing created, nothing queued', async (_how, args) => {
    const svc = service({ isProviderEnabledForTeamMember: vi.fn(() => true) });
    await expect(svc.createChildSessionInternal('root', '/ws', { role: 'advisor', mission: MISSION, prompt: 'brief', ...args }))
      .rejects.toThrow(/^Independent Advisor provider unavailable: openai-codex \(requested explicitly\) does not enforce a member's tool scope \(read, review or write\) in Team mode.*, so the advisor cannot run on it\. No session was created and no fallback to another provider was applied: omit provider and model to create it on the role default \(claude-code\)/);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
    expect(svc.aiService.queuePromptForSession).not.toHaveBeenCalled();
    expect(svc.aiService.triggerQueuedPromptProcessingForSession).not.toHaveBeenCalled();
  });

  it.each(['openai-codex-acp', 'opencode', 'copilot-cli'])('%s is refused the same way: no provider of this codebase but claude-code enforces the scope', async (provider) => {
    await expect(service().createChildSessionInternal('root', '/ws', { role: 'advisor', provider, model: `${provider}:any` }))
      .rejects.toThrow(new RegExp(`^Independent Advisor provider unavailable: ${provider} \\(requested explicitly\\) does not enforce`));
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
  });

  it('the refusal is the same for the other roles, with their role name', async () => {
    await expect(service().createChildSessionInternal('root', '/ws', { role: 'reviewer', provider: 'openai-codex', model: 'openai-codex:gpt-5.5' }))
      .rejects.toThrow(/^Team member \(reviewer\) provider unavailable: openai-codex \(requested explicitly\) does not enforce/);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
  });

  it('a ready provider other than the caller\'s must be enabled: disabled is refused, unverifiable is refused, enabled is created and reported as diverse', async () => {
    // A coordinator on another provider creating the advisor on its role default (claude-code).
    await expect(service({ isProviderEnabledForTeamMember: vi.fn(() => false) }).createChildSessionInternal('root-other', '/ws', { role: 'advisor' }))
      .rejects.toThrow(/^Independent Advisor provider unavailable: claude-code \(the role default\) is not enabled in this app's AI provider settings for this workspace\. No session was created and no fallback/);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();

    await expect(service().createChildSessionInternal('root-other', '/ws', { role: 'advisor' }))
      .rejects.toThrow(/^Independent Advisor provider unavailable: claude-code \(the role default\) could not be verified as available/);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();

    const enabled = vi.fn(() => true);
    const result = await service({ isProviderEnabledForTeamMember: enabled }).createChildSessionInternal('root-other', '/ws', { role: 'advisor', mission: MISSION });
    expect(enabled).toHaveBeenCalledWith('claude-code', '/ws');
    expect(created().provider).toBe('claude-code');
    expect(created().model).toBe('claude-code:opus');
    expect(created().metadata.toolScope).toBe('read');
    expect(result.providerDiversity).toBe('diverse');
  });

  it('spawn_session refuses before its own side effects: no workstream container, no re-parented caller, no row, no prompt', async () => {
    // The root has neither a worktree nor a parent, the case in which spawn_session
    // would otherwise create a workstream container and promote the caller into it.
    const svc = service();
    await expect(svc.spawnSession('root', '/ws', { prompt: 'brief', role: 'advisor', model: 'openai-codex:gpt-5.5' }))
      .rejects.toThrow(/^Independent Advisor provider unavailable: openai-codex \(requested explicitly\) does not enforce/);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
    expect(AISessionsRepository.updateMetadata).not.toHaveBeenCalled();
    expect(svc.aiService.queuePromptForSession).not.toHaveBeenCalled();
    // The same refusal, by the same rule, for a disabled role default.
    await expect(service({ isProviderEnabledForTeamMember: vi.fn(() => false) }).spawnSession('root-other', '/ws', { prompt: 'brief', role: 'advisor' }))
      .rejects.toThrow(/^Independent Advisor provider unavailable: claude-code \(the role default\) is not enabled/);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
    expect(AISessionsRepository.updateMetadata).not.toHaveBeenCalled();
  });

  it('spawn_session with inheritModel on a caller whose provider the host cannot run names inheritModel as the cause', async () => {
    await expect(service().spawnSession('root-other', '/ws', { prompt: 'brief', role: 'advisor', inheritModel: true }))
      .rejects.toThrow(/^Independent Advisor provider unavailable: openai-codex \(inherited from the caller's model \(inheritModel\)\) does not enforce .* omit inheritModel \(and model\) to create it on the role default \(claude-code\)/);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
  });

  it('an Actions launch from a team root with a model of a provider the host cannot run is refused before any workstream exists', async () => {
    const svc = service();
    await expect(svc.launchActionSession('root', '/ws', { prompt: 'brief', model: 'openai-codex:gpt-5.5', autoSubmit: true }))
      .rejects.toThrow(/^Team member \(other\) provider unavailable: openai-codex \(requested explicitly\) does not enforce/);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
    expect(AISessionsRepository.updateMetadata).not.toHaveBeenCalled();
    // Inheriting the model of a root on such a provider is refused as inherited.
    await expect(svc.launchActionSession('root-other', '/ws', { prompt: 'brief', autoSubmit: true }))
      .rejects.toThrow(/^Team member \(other\) provider unavailable: openai-codex \(inherited from the caller's model \(inheritModel\)\)/);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
  });

  it('a settings read that throws is unverifiable, hence refused (fail-closed)', async () => {
    await expect(service({ isProviderEnabledForTeamMember: () => { throw new Error('store locked'); } }).createChildSessionInternal('root-other', '/ws', { role: 'advisor' }))
      .rejects.toThrow(/could not be verified as available/);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
  });

  it('a member creating an advisor at depth 2 gets no diversity in the creation result (the root is not read there); the update reports it', async () => {
    const result = await service().createChildSessionInternal('member', '/ws', { role: 'advisor' });
    expect(created().metadata.teamChild).toEqual({ role: 'advisor', rootSessionId: 'root', depth: 2 });
    expect(result.providerDiversity).toBeNull();
    expect(vi.mocked(AISessionsRepository.get).mock.calls.map(([id]) => id)).not.toContain('root');
  });
});

describe('structural pilot: coordinator -> advisor -> opinion -> observability, without any provider running', () => {
  it('get_session_result and the [Child Session Update] of a same-provider advisor name its provider, model and "same", and never call it independent by provider', async () => {
    const svc = service();
    const result = await svc.buildSessionResultData('adv', '/ws');
    expect(result.provider).toBe('claude-code');
    expect(result.model).toBe('claude-code:opus');
    expect(result.toolScope).toBe('read');
    expect(result.toolScopeEnforced).toBe(true);
    expect(result.teamRole).toBe('advisor');
    expect(result.providerDiversity).toBe('same');

    const update: string = svc.buildNotificationMessage('session:completed', {
      ...result,
      recentMessages: [{ direction: 'output', text: 'Independent opinion: approved with reservations. ...' }],
    });
    expect(update.startsWith('[Child Session Update]')).toBe(true);
    expect(update).toContain('Tool scope: read (this child had NO file-writing, shell (run_command/Bash), delegation');
    expect(update).toContain('Provider: claude-code (claude-code:opus), the same provider as the coordinator\'s. This second opinion is independent by session, context and instructions, not by provider: do not report it as independent by provider or as a different model family.');
  });

  it('an advisor whose root runs on another provider is reported as "diverse"; one whose root cannot be read is reported as unknown, never as diverse', async () => {
    const svc = service();
    const diverse = await svc.buildSessionResultData('adv-diverse', '/ws');
    expect(diverse.providerDiversity).toBe('diverse');
    expect(svc.buildNotificationMessage('session:completed', diverse)).toContain('Provider: claude-code (claude-code:opus), a different provider from the coordinator\'s. This second opinion is independent by provider as well as by session');

    const orphan = await svc.buildSessionResultData('adv-orphan', '/ws');
    expect(orphan.providerDiversity).toBeNull();
    expect(svc.buildNotificationMessage('session:completed', orphan)).toContain('whether it differs from the coordinator\'s could not be determined, so do not report this opinion as independent by provider');
  });

  it('a session outside a team carries no provider line in its update', async () => {
    vi.mocked(AISessionsRepository.get).mockImplementation(async (id: string) => (id === 'plain-child'
      ? { ...ADVISOR, id: 'plain-child', metadata: {} }
      : null) as never);
    const svc = service();
    const result = await svc.buildSessionResultData('plain-child', '/ws');
    expect(result.teamRole).toBeUndefined();
    expect(result.providerDiversity).toBeUndefined();
    expect(svc.buildNotificationMessage('session:completed', result)).not.toContain('Provider:');
  });

  it('the advisor\'s operational authority is the same on the provider it runs on: every mutable, delegating or asking tool is denied by the host policy for scope read + role advisor', () => {
    const mutable = [
      'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task', 'Workflow', 'SendMessage', 'Skill', 'WebFetch', 'WebSearch',
      'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'TaskCreate', 'TaskUpdate',
      'mcp__nimbalyst__AskUserQuestion', 'mcp__nimbalyst__PromptForUserInput',
      'mcp__nimbalyst-host__create_session', 'mcp__nimbalyst-host__spawn_session', 'mcp__nimbalyst-host__send_prompt', 'mcp__nimbalyst-host__respond_to_prompt',
      'mcp__nimbalyst-host__run_project_tests', 'mcp__nimbalyst-host__features_toggle', 'mcp__nimbalyst-host__workspace_set_trust',
      'mcp__nimbalyst-trackers__tracker_create', 'mcp__nimbalyst-trackers__tracker_update', 'mcp__nimbalyst-trackers__tracker_define_type',
      'mcp__nimbalyst__developer_git_commit_proposal',
      'mcp__some-user-server__anything',
    ];
    for (const tool of mutable) {
      expect(isToolDeniedForScope('read', tool, ['some-user-server'], 'advisor'), tool).toBe(true);
    }
    for (const tool of ['Read', 'Glob', 'Grep', 'mcp__nimbalyst-trackers__tracker_get', 'mcp__nimbalyst-trackers__tracker_list', 'mcp__nimbalyst-host__get_session_result']) {
      expect(isToolDeniedForScope('read', tool, ['some-user-server'], 'advisor'), tool).toBe(false);
    }
  });
});
