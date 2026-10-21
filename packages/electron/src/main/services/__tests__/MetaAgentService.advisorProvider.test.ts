import { beforeEach, describe, expect, it, vi } from 'vitest';

// The `advisor` (Consultor Independente) and its provider through the real
// creation path: the role default provider is applied, an explicit provider is
// accepted only when the host enforces the member's scope and role policy on
// it, it is enabled, the user is signed in to it and its model is known; a
// refusal is explicit and creates nothing (never a fallback), on every
// creation path; and the provider diversity against the team root is reported
// in the creation result, in get_session_result and in the [Child Session
// Update]. Mock surface mirrors MetaAgentService.advisor.test.ts. No provider
// is ever started: every provider check is a host-side fact or a mocked
// settings / sign-in read.
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { create: vi.fn(), updateMetadata: vi.fn(), get: vi.fn() },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({
  // listTail returns what the test gave list(): these tests use short sessions, where both reads agree.
  AgentMessagesRepository: (() => { const list = vi.fn(async (_sessionId?: string) => [] as unknown[]); return { create: vi.fn(), list, listTail: vi.fn((sessionId: string) => list(sessionId)) }; })(),
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
    getDefaultModelId: (provider: string) => (provider === 'openai-codex' ? 'openai-codex:gpt-6.1-sol' : `${provider}:default`),
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
// A team whose coordinator runs on Codex: its members default to the team provider.
const ROOT_CODEX = { id: 'root-codex', provider: 'openai-codex', model: 'openai-codex:gpt-6.1-sol', agentRole: 'standard', workspacePath: '/ws', metadata: { teamMode: true } };
// A team whose coordinator runs on a provider the host cannot run a member on.
const ROOT_OPENCODE = { id: 'root-opencode', provider: 'opencode', model: 'opencode:any', agentRole: 'standard', workspacePath: '/ws', metadata: { teamMode: true } };
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
const ADVISOR_CODEX = { ...ADVISOR, id: 'adv-codex', provider: 'openai-codex', model: 'openai-codex:gpt-6.1-sol' };
const ADVISOR_DIVERSE = { ...ADVISOR, id: 'adv-diverse', metadata: { ...ADVISOR.metadata, teamChild: { ...ADVISOR.metadata.teamChild, rootSessionId: 'root-codex' } } };
const ADVISOR_ORPHAN = { ...ADVISOR, id: 'adv-orphan', metadata: { ...ADVISOR.metadata, teamChild: { ...ADVISOR.metadata.teamChild, rootSessionId: 'gone' } } };

const SIGNED_IN = async (provider: string) => (provider === 'claude-code' ? true : provider === 'openai-codex' ? true : null);

function service(aiService: Record<string, unknown> = {}, authenticated: ((provider: string) => Promise<boolean | null>) | null = null) {
  const svc = MetaAgentService.getInstance();
  (svc as any).aiService = { queuePromptForSession: vi.fn(), triggerQueuedPromptProcessingForSession: vi.fn(), ...aiService };
  svc.setProviderAuthenticationCheck(authenticated);
  svc.setProviderVersionCheck(null);
  return svc as any;
}

function created() {
  return vi.mocked(AISessionsRepository.create).mock.calls.at(-1)![0] as any;
}

beforeEach(() => {
  vi.mocked(AISessionsRepository.create).mockReset();
  vi.mocked(AISessionsRepository.updateMetadata).mockReset();
  vi.mocked(AISessionsRepository.get).mockReset();
  vi.mocked(database.query).mockReset().mockResolvedValue({ rows: [{ in_flight: '0', total: '0', active: '0' }] } as never);
  const rows: Record<string, unknown> = {
    root: ROOT, 'root-codex': ROOT_CODEX, 'root-opencode': ROOT_OPENCODE, member: MEMBER,
    adv: ADVISOR, 'adv-codex': ADVISOR_CODEX, 'adv-diverse': ADVISOR_DIVERSE, 'adv-orphan': ADVISOR_ORPHAN,
  };
  vi.mocked(AISessionsRepository.get).mockImplementation(async (id: string) => (rows[id] ?? null) as never);
});

describe('the advisor is created on its role default provider: OpenAI Codex', () => {
  it('omitting provider and model from a claude-code root gives the role default: openai-codex, gpt-6.1-sol, high, read, mission kept, diversity "diverse"; Codex availability and sign-in consulted', async () => {
    const enabled = vi.fn(() => true);
    const signedIn = vi.fn(SIGNED_IN);
    const result = await service({ isProviderEnabledForTeamMember: enabled }, signedIn).createChildSessionInternal('root', '/ws', { role: 'advisor', mission: MISSION, prompt: 'brief' });
    const row = created();
    expect(row.provider).toBe('openai-codex');
    expect(row.model).toBe('openai-codex:gpt-6.1-sol');
    expect(row.metadata.toolScope).toBe('read');
    expect(row.metadata.effortLevel).toBe('high');
    expect(row.metadata.teamChild).toEqual({ role: 'advisor', rootSessionId: 'root', depth: 1, mission: MISSION });
    expect(enabled).toHaveBeenCalledWith('openai-codex', '/ws');
    expect(signedIn).toHaveBeenCalledWith('openai-codex');
    expect(result.provider).toBe('openai-codex');
    expect(result.providerDiversity).toBe('diverse');
  });

  it('Codex unavailable (disabled, unverifiable, not signed in, sign-in unverifiable, sign-in check broken): the default is refused before any side effect, naming the default as unavailable, with no fallback to claude-code', async () => {
    const cases: Array<[Record<string, unknown>, ((provider: string) => Promise<boolean | null>) | null, RegExp]> = [
      [{ isProviderEnabledForTeamMember: () => false }, SIGNED_IN, /^Independent Advisor provider unavailable: openai-codex \(the role default\) is not enabled in this app's AI provider settings for this workspace\. No session was created and no fallback to another provider was applied: the user may enable openai-codex in the AI provider settings; the default provider of the Independent Advisor is unavailable, so report it to the user as it is/],
      [{}, SIGNED_IN, /^Independent Advisor provider unavailable: openai-codex \(the role default\) could not be verified as available/],
      [{ isProviderEnabledForTeamMember: () => { throw new Error('store locked'); } }, SIGNED_IN, /could not be verified as available/],
      [{ isProviderEnabledForTeamMember: () => true }, async () => false, /^Independent Advisor provider unavailable: openai-codex \(the role default\) is enabled but the user is not signed in to it\. No session was created and no fallback .*\(its own login, never a key you configure\); the default provider of the Independent Advisor is unavailable/],
      [{ isProviderEnabledForTeamMember: () => true }, null, /^Independent Advisor provider unavailable: openai-codex \(the role default\) could not be verified as signed in/],
      [{ isProviderEnabledForTeamMember: () => true }, async () => { throw new Error('auth child died'); }, /could not be verified as signed in/],
    ];
    for (const [aiService, authenticated, expected] of cases) {
      const queue = vi.fn();
      await expect(service({ ...aiService, queuePromptForSession: queue }, authenticated).createChildSessionInternal('root', '/ws', { role: 'advisor', mission: MISSION, prompt: 'brief' }))
        .rejects.toThrow(expected);
      expect(AISessionsRepository.create).not.toHaveBeenCalled();
      expect(AISessionsRepository.updateMetadata).not.toHaveBeenCalled();
      expect(queue).not.toHaveBeenCalled();
    }
  });

  it('no automatic fallback to Claude: a refused default never creates a claude-code advisor, and the message never suggests one silently', async () => {
    const error = await service({ isProviderEnabledForTeamMember: () => false }, SIGNED_IN).createChildSessionInternal('root', '/ws', { role: 'advisor' }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('claude-code');
    expect((error as Error).message).toContain('a deliberate choice you may only make by naming provider and model explicitly');
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
    expect(vi.mocked(AISessionsRepository.create).mock.calls.some((call) => (call[0] as any).provider === 'claude-code')).toBe(false);
  });

  it('the role default on the caller\'s own provider (a Codex root) never consults availability or sign-in; diversity "same"', async () => {
    const enabled = vi.fn(() => false);
    const signedIn = vi.fn(async () => false);
    const result = await service({ isProviderEnabledForTeamMember: enabled }, signedIn).createChildSessionInternal('root-codex', '/ws', { role: 'advisor' });
    expect(enabled).not.toHaveBeenCalled();
    expect(signedIn).not.toHaveBeenCalled();
    expect(created().provider).toBe('openai-codex');
    expect(created().model).toBe('openai-codex:gpt-6.1-sol');
    expect(result.providerDiversity).toBe('same');
  });

  it('naming the role\'s own provider without a model keeps the role\'s model default (gpt-6.1-sol), not the caller\'s model', async () => {
    const result = await service({ isProviderEnabledForTeamMember: () => true }, SIGNED_IN).createChildSessionInternal('root', '/ws', { role: 'advisor', provider: 'openai-codex' });
    expect(created().model).toBe('openai-codex:gpt-6.1-sol');
    expect(created().metadata.effortLevel).toBe('high');
    expect(result.providerDiversity).toBe('diverse');
  });

  it('the team provider named explicitly (claude-code, a model of it) stays possible as a deliberate choice: created, read, and reported as "same" against a claude-code root', async () => {
    const enabled = vi.fn(() => true);
    const signedIn = vi.fn(SIGNED_IN);
    const result = await service({ isProviderEnabledForTeamMember: enabled }, signedIn).createChildSessionInternal('root', '/ws', { role: 'advisor', provider: 'claude-code', model: 'claude-code:opus', mission: MISSION });
    expect(created().provider).toBe('claude-code');
    expect(created().model).toBe('claude-code:opus');
    expect(created().metadata.toolScope).toBe('read');
    expect(created().metadata.effortLevel).toBe('high');
    // The caller's own provider: available by construction, nothing consulted.
    expect(enabled).not.toHaveBeenCalled();
    expect(signedIn).not.toHaveBeenCalled();
    expect(result.provider).toBe('claude-code');
    expect(result.providerDiversity).toBe('same');
    // Without a model, the caller's model is reused (the role's model belongs to another provider).
    await service().createChildSessionInternal('root', '/ws', { role: 'advisor', provider: 'claude-code' });
    expect(created().provider).toBe('claude-code');
    expect(created().model).toBe('claude-code:opus');
  });

  it('an explicit model of the team provider is a deliberate choice too: still "same", still read', async () => {
    const result = await service().createChildSessionInternal('root', '/ws', { role: 'advisor', provider: 'claude-code', model: 'claude-code:fable', effortLevel: 'max', toolScope: 'full' });
    expect(created().model).toBe('claude-code:fable');
    expect(created().metadata.toolScope).toBe('read');
    expect(result.providerDiversity).toBe('same');
  });

  it('the other roles keep their defaults on the team provider (no regression)', async () => {
    const enabled = vi.fn(() => false);
    const signedIn = vi.fn(async () => false);
    const svc = service({ isProviderEnabledForTeamMember: enabled }, signedIn);
    for (const [role, expected] of [
      ['explorer', ['claude-code', 'claude-code:sonnet', 'medium', 'read']],
      ['implementer', ['claude-code', 'claude-code:sonnet', 'medium', undefined]],
      ['reviewer', ['claude-code', 'claude-code:sonnet', 'high', 'review']],
      ['architect', ['claude-code', 'claude-code:opus', 'high', 'read']],
      ['other', ['claude-code', 'claude-code:sonnet', 'medium', undefined]],
    ] as const) {
      await svc.createChildSessionInternal('root', '/ws', { role });
      const row = created();
      expect([row.provider, row.model, row.metadata.effortLevel, row.metadata.toolScope], role).toEqual([...expected]);
    }
    expect(enabled).not.toHaveBeenCalled();
    expect(signedIn).not.toHaveBeenCalled();
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

describe('an advisor on openai-codex: the provider-diverse second opinion', () => {
  it('is created from a claude-code root when Codex is enabled and signed in: provider openai-codex, its default model, high, read forced, mission kept, diversity "diverse"', async () => {
    const enabled = vi.fn(() => true);
    const result = await service({ isProviderEnabledForTeamMember: enabled }, SIGNED_IN)
      .createChildSessionInternal('root', '/ws', { role: 'advisor', provider: 'openai-codex', mission: MISSION, prompt: 'brief', toolScope: 'full' });
    const row = created();
    expect(row.provider).toBe('openai-codex');
    expect(row.model).toBe('openai-codex:gpt-6.1-sol');
    expect(row.metadata.toolScope).toBe('read');
    expect(row.metadata.effortLevel).toBe('high');
    expect(row.metadata.teamChild).toEqual({ role: 'advisor', rootSessionId: 'root', depth: 1, mission: MISSION });
    expect(enabled).toHaveBeenCalledWith('openai-codex', '/ws');
    expect(result.provider).toBe('openai-codex');
    expect(result.providerDiversity).toBe('diverse');
  });

  it('a known Codex model may be named (with or without the prefix); an unknown one is refused before anything is created', async () => {
    const svc = service({ isProviderEnabledForTeamMember: () => true }, SIGNED_IN);
    await svc.createChildSessionInternal('root', '/ws', { role: 'advisor', provider: 'openai-codex', model: 'openai-codex:gpt-5.5' });
    expect(created().model).toBe('openai-codex:gpt-5.5');
    await svc.createChildSessionInternal('root', '/ws', { role: 'advisor', model: 'openai-codex:gpt-6-sol' });
    expect(created().model).toBe('openai-codex:gpt-6-sol');
    vi.mocked(AISessionsRepository.create).mockReset();
    await expect(svc.createChildSessionInternal('root', '/ws', { role: 'advisor', provider: 'openai-codex', model: 'openai-codex:gpt-9-ultra' }))
      .rejects.toThrow(/^Independent Advisor model unavailable: openai-codex:gpt-9-ultra is not a model of openai-codex this build knows.*No session was created and no fallback/);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
  });

  it('is refused when Codex is not enabled, not signed in, or neither can be verified; nothing is created', async () => {
    await expect(service({ isProviderEnabledForTeamMember: () => false }, SIGNED_IN).createChildSessionInternal('root', '/ws', { role: 'advisor', provider: 'openai-codex' }))
      .rejects.toThrow(/^Independent Advisor provider unavailable: openai-codex \(requested explicitly\) is not enabled in this app's AI provider settings/);
    await expect(service({ isProviderEnabledForTeamMember: () => true }, async () => false).createChildSessionInternal('root', '/ws', { role: 'advisor', provider: 'openai-codex' }))
      .rejects.toThrow(/^Independent Advisor provider unavailable: openai-codex \(requested explicitly\) is enabled but the user is not signed in to it\. No session was created and no fallback .*\(its own login, never a key you configure\)/);
    await expect(service({ isProviderEnabledForTeamMember: () => true }, null).createChildSessionInternal('root', '/ws', { role: 'advisor', provider: 'openai-codex' }))
      .rejects.toThrow(/^Independent Advisor provider unavailable: openai-codex \(requested explicitly\) could not be verified as signed in/);
    await expect(service({ isProviderEnabledForTeamMember: () => true }, async () => { throw new Error('auth child died'); }).createChildSessionInternal('root', '/ws', { role: 'advisor', provider: 'openai-codex' }))
      .rejects.toThrow(/could not be verified as signed in/);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
  });

  it('a Codex member may only be read or review: a write or full member named onto Codex is refused for its scope, nothing created', async () => {
    const svc = service({ isProviderEnabledForTeamMember: () => true }, SIGNED_IN);
    await expect(svc.createChildSessionInternal('root', '/ws', { role: 'implementer', provider: 'openai-codex', toolScope: 'write' }))
      .rejects.toThrow(/^Team member \(implementer\) provider unavailable: openai-codex \(requested explicitly\) does not enforce a member's write tool scope/);
    await expect(svc.createChildSessionInternal('root', '/ws', { role: 'implementer', provider: 'openai-codex' }))
      .rejects.toThrow(/^Team member \(implementer\) provider unavailable: openai-codex \(requested explicitly\) does not enforce every member tool scope in Team mode, so a full-tools member cannot run on it/);
    await expect(svc.createChildSessionInternal('root', '/ws', { role: 'other', model: 'openai-codex:gpt-5.5' }))
      .rejects.toThrow(/^Team member \(other\) provider unavailable: openai-codex \(requested explicitly\) does not enforce every member tool scope/);
    // An Actions launch is a full member: refused on Codex too, before any workstream.
    await expect(svc.launchActionSession('root', '/ws', { prompt: 'brief', model: 'openai-codex:gpt-5.5', autoSubmit: true }))
      .rejects.toThrow(/^Team member \(other\) provider unavailable: openai-codex \(requested explicitly\) does not enforce every member tool scope/);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
    expect(AISessionsRepository.updateMetadata).not.toHaveBeenCalled();
    // An explorer (read) on Codex is accepted by the same rule as the advisor.
    await svc.createChildSessionInternal('root', '/ws', { role: 'explorer', provider: 'openai-codex' });
    expect(created().metadata.toolScope).toBe('read');
  });

  it('spawn_session and an Actions launch from a Codex root follow the same checks before any workstream exists', async () => {
    // An advisor of a Codex root stays on its role default (openai-codex, the root's own provider: nothing consulted).
    const svc = service({ isProviderEnabledForTeamMember: () => true }, SIGNED_IN);
    await svc.spawnSession('root-codex', '/ws', { prompt: 'brief', role: 'advisor', mission: MISSION });
    expect(created().provider).toBe('openai-codex');
    expect(created().model).toBe('openai-codex:gpt-6.1-sol');
    expect(created().metadata.teamChild).toEqual({ role: 'advisor', rootSessionId: 'root-codex', depth: 1, mission: MISSION });
    // An explorer of a Codex root defaults to the team provider (claude-code), checked for availability and sign-in.
    await svc.spawnSession('root-codex', '/ws', { prompt: 'brief', role: 'explorer' });
    expect(created().provider).toBe('claude-code');
    expect(created().model).toBe('claude-code:sonnet');
    // Inheriting the Codex root's model creates a Codex advisor (read): allowed, same provider as the root.
    await svc.spawnSession('root-codex', '/ws', { prompt: 'brief', role: 'advisor', inheritModel: true });
    expect(created().provider).toBe('openai-codex');
    expect(created().model).toBe('openai-codex:gpt-6.1-sol');
    expect(created().metadata.toolScope).toBe('read');
  });
});

describe('a provider the host cannot keep read-only is refused, explicitly and without fallback', () => {
  it.each([
    ['provider and model', { provider: 'opencode', model: 'opencode:any' }],
    ['a model of that provider only', { model: 'opencode:any' }],
    ['a provider only', { provider: 'opencode' }],
  ])('requested through %s: "Independent Advisor provider unavailable", nothing created, nothing queued', async (_how, args) => {
    const svc = service({ isProviderEnabledForTeamMember: vi.fn(() => true) }, SIGNED_IN);
    await expect(svc.createChildSessionInternal('root', '/ws', { role: 'advisor', mission: MISSION, prompt: 'brief', ...args }))
      .rejects.toThrow(/^Independent Advisor provider unavailable: opencode \(requested explicitly\) does not enforce a member's read tool scope in Team mode.*, so the advisor cannot run on it\. No session was created and no fallback to another provider was applied: omit provider and model to create it on the role default \(openai-codex\)/);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
    expect(svc.aiService.queuePromptForSession).not.toHaveBeenCalled();
    expect(svc.aiService.triggerQueuedPromptProcessingForSession).not.toHaveBeenCalled();
  });

  it.each(['openai-codex-acp', 'opencode', 'copilot-cli'])('%s is refused the same way', async (provider) => {
    await expect(service().createChildSessionInternal('root', '/ws', { role: 'advisor', provider, model: `${provider}:any` }))
      .rejects.toThrow(new RegExp(`^Independent Advisor provider unavailable: ${provider} \\(requested explicitly\\) does not enforce`));
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
  });

  it('the refusal is the same for the other roles, with their role name', async () => {
    await expect(service().createChildSessionInternal('root', '/ws', { role: 'reviewer', provider: 'opencode', model: 'opencode:any' }))
      .rejects.toThrow(/^Team member \(reviewer\) provider unavailable: opencode \(requested explicitly\) does not enforce a member's review tool scope/);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
  });

  it('a ready provider other than the caller\'s must be enabled and signed in: disabled is refused, unverifiable is refused, enabled is created and reported as diverse', async () => {
    // A coordinator on Codex creating an explorer on its role default (claude-code).
    await expect(service({ isProviderEnabledForTeamMember: vi.fn(() => false) }, SIGNED_IN).createChildSessionInternal('root-codex', '/ws', { role: 'explorer' }))
      .rejects.toThrow(/^Team member \(explorer\) provider unavailable: claude-code \(the role default\) is not enabled in this app's AI provider settings for this workspace\. No session was created and no fallback/);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();

    await expect(service(undefined, SIGNED_IN).createChildSessionInternal('root-codex', '/ws', { role: 'explorer' }))
      .rejects.toThrow(/^Team member \(explorer\) provider unavailable: claude-code \(the role default\) could not be verified as available/);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();

    const enabled = vi.fn(() => true);
    const result = await service({ isProviderEnabledForTeamMember: enabled }, SIGNED_IN).createChildSessionInternal('root-codex', '/ws', { role: 'explorer', mission: MISSION });
    expect(enabled).toHaveBeenCalledWith('claude-code', '/ws');
    expect(created().provider).toBe('claude-code');
    expect(created().model).toBe('claude-code:sonnet');
    expect(created().metadata.toolScope).toBe('read');
    expect(result.providerDiversity).toBe('diverse');
  });

  it('a settings read that throws is unverifiable, hence refused (fail-closed)', async () => {
    await expect(service({ isProviderEnabledForTeamMember: () => { throw new Error('store locked'); } }, SIGNED_IN).createChildSessionInternal('root-codex', '/ws', { role: 'explorer' }))
      .rejects.toThrow(/could not be verified as available/);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
  });

  it('spawn_session refuses before its own side effects: no workstream container, no re-parented caller, no row, no prompt', async () => {
    // The root has neither a worktree nor a parent, the case in which spawn_session
    // would otherwise create a workstream container and promote the caller into it.
    const svc = service({ isProviderEnabledForTeamMember: () => true }, SIGNED_IN);
    await expect(svc.spawnSession('root', '/ws', { prompt: 'brief', role: 'advisor', model: 'opencode:any' }))
      .rejects.toThrow(/^Independent Advisor provider unavailable: opencode \(requested explicitly\) does not enforce/);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
    expect(AISessionsRepository.updateMetadata).not.toHaveBeenCalled();
    expect(svc.aiService.queuePromptForSession).not.toHaveBeenCalled();
    // The same refusal, by the same rule, for a disabled role default (the advisor's Codex, from a claude-code root).
    await expect(service({ isProviderEnabledForTeamMember: vi.fn(() => false) }, SIGNED_IN).spawnSession('root', '/ws', { prompt: 'brief', role: 'advisor' }))
      .rejects.toThrow(/^Independent Advisor provider unavailable: openai-codex \(the role default\) is not enabled/);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
    expect(AISessionsRepository.updateMetadata).not.toHaveBeenCalled();
  });

  it('spawn_session with inheritModel on a caller whose provider the host cannot run names inheritModel as the cause', async () => {
    await expect(service().spawnSession('root-opencode', '/ws', { prompt: 'brief', role: 'advisor', inheritModel: true }))
      .rejects.toThrow(/^Independent Advisor provider unavailable: opencode \(inherited from the caller's model \(inheritModel\)\) does not enforce .* omit inheritModel \(and model\) to create it on the role default \(openai-codex\)/);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
  });

  it('an Actions launch from a team root with a model of a provider the host cannot run is refused before any workstream exists', async () => {
    const svc = service();
    await expect(svc.launchActionSession('root', '/ws', { prompt: 'brief', model: 'opencode:any', autoSubmit: true }))
      .rejects.toThrow(/^Team member \(other\) provider unavailable: opencode \(requested explicitly\) does not enforce every member tool scope/);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
    expect(AISessionsRepository.updateMetadata).not.toHaveBeenCalled();
    // Inheriting the model of a root on such a provider is refused as inherited.
    await expect(svc.launchActionSession('root-opencode', '/ws', { prompt: 'brief', autoSubmit: true }))
      .rejects.toThrow(/^Team member \(other\) provider unavailable: opencode \(inherited from the caller's model \(inheritModel\)\)/);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
  });

  it('a member creating an advisor at depth 2 gets no diversity in the creation result (the root is not read there); the update reports it', async () => {
    const result = await service({ isProviderEnabledForTeamMember: () => true }, SIGNED_IN).createChildSessionInternal('member', '/ws', { role: 'advisor' });
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

  it('a Codex advisor under a claude-code root: scope read reported as enforced, provider line "diverse", opinion independent by provider too', async () => {
    const svc = service();
    const result = await svc.buildSessionResultData('adv-codex', '/ws');
    expect(result.provider).toBe('openai-codex');
    expect(result.toolScope).toBe('read');
    expect(result.toolScopeEnforced).toBe(true);
    expect(result.providerDiversity).toBe('diverse');
    const update: string = svc.buildNotificationMessage('session:completed', result);
    // On Codex the read member has its shell switched off and verified off; it reads through the host's confined read tools.
    expect(update).toContain('Tool scope: read (this child had NO file-writing, shell (its Codex shell tool was switched off and verified off by the host');
    expect(update).toContain('it read files only through the host\'s workspace-confined read_file, list_files and search_files tools), delegation');
    expect(update).toContain('Provider: openai-codex (openai-codex:gpt-6.1-sol), a different provider from the coordinator\'s. This second opinion is independent by provider as well as by session');
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

describe('NIB.46 items 7.6 and 7.8 through the creation path', () => {
  it('7.6: an advisor named onto claude-code without a model gets Opus even when the coordinator runs Sonnet; a named model still wins', async () => {
    vi.mocked(AISessionsRepository.get).mockImplementation(async (id: string) => (id === 'root-sonnet'
      ? { ...ROOT, id: 'root-sonnet', model: 'claude-code:sonnet' }
      : null) as never);
    await service().createChildSessionInternal('root-sonnet', '/ws', { role: 'advisor', provider: 'claude-code', mission: MISSION });
    expect(created().provider).toBe('claude-code');
    expect(created().model).toBe('claude-code:opus');
    expect(created().metadata.effortLevel).toBe('high');
    await service().createChildSessionInternal('root-sonnet', '/ws', { role: 'advisor', provider: 'claude-code', model: 'claude-code:fable' });
    expect(created().model).toBe('claude-code:fable');
    // Other roles named onto their own provider keep their own default, not the coordinator's model.
    await service().createChildSessionInternal('root-sonnet', '/ws', { role: 'architect', provider: 'claude-code' });
    expect(created().model).toBe('claude-code:opus');
    await service().createChildSessionInternal('root-sonnet', '/ws', { role: 'explorer', provider: 'claude-code' });
    expect(created().model).toBe('claude-code:sonnet');
  });

  it('7.8: the Codex CLI version is checked before the advisor is created: too old or unknown refuses it with nothing created, a supported one passes', async () => {
    const svc = service({ isProviderEnabledForTeamMember: () => true }, SIGNED_IN);
    svc.setProviderVersionCheck(async (provider: string) => (provider === 'openai-codex' ? '0.150.0' : undefined));
    await expect(svc.createChildSessionInternal('root', '/ws', { role: 'advisor', mission: MISSION }))
      .rejects.toThrow(/its CLI is version 0\.150\.0, older than the minimum 0\.159\.1/);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
    svc.setProviderVersionCheck(async () => null);
    await expect(svc.createChildSessionInternal('root', '/ws', { role: 'advisor' })).rejects.toThrow(/its CLI version could not be verified/);
    svc.setProviderVersionCheck(async () => { throw new Error('auth child died'); });
    await expect(svc.createChildSessionInternal('root', '/ws', { role: 'advisor' })).rejects.toThrow(/its CLI version could not be verified/);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
    svc.setProviderVersionCheck(async () => '0.159.2');
    await svc.createChildSessionInternal('root', '/ws', { role: 'advisor' });
    expect(created().provider).toBe('openai-codex');
    // The check never touches a claude-code member.
    svc.setProviderVersionCheck(async () => '0.1.0');
    await svc.createChildSessionInternal('root', '/ws', { role: 'explorer' });
    expect(created().provider).toBe('claude-code');
    svc.setProviderVersionCheck(null);
  });
});

describe('NIB.31: the folder a session may run its project tests in comes from its own row', () => {
  it('worktree first, else workspace; a folder gone from disk, a relative path or an unknown session is refused', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nib31-'));
    const workspace = path.join(tmp, 'repo');
    const worktreeA = path.join(tmp, 'repo_worktrees', 'team-a');
    const worktreeB = path.join(tmp, 'repo_worktrees', 'team-b');
    for (const dir of [workspace, worktreeA, worktreeB]) fs.mkdirSync(dir, { recursive: true });
    const rows: Record<string, unknown> = {
      'reviewer-a': { id: 'reviewer-a', workspacePath: workspace, worktreePath: worktreeA },
      'reviewer-b': { id: 'reviewer-b', workspacePath: workspace, worktreePath: worktreeB },
      shared: { id: 'shared', workspacePath: workspace, worktreePath: null },
      gone: { id: 'gone', workspacePath: workspace, worktreePath: path.join(tmp, 'repo_worktrees', 'deleted') },
      relative: { id: 'relative', workspacePath: 'repo', worktreePath: null },
    };
    vi.mocked(AISessionsRepository.get).mockImplementation(async (id: string) => (rows[id] ?? null) as never);
    const svc = service();
    try {
      expect(await svc.resolveSessionWorkspaceRoot('reviewer-a')).toBe(worktreeA);
      expect(await svc.resolveSessionWorkspaceRoot('reviewer-b')).toBe(worktreeB);
      expect(await svc.resolveSessionWorkspaceRoot('shared')).toBe(workspace);
      expect(await svc.resolveSessionWorkspaceRoot('gone')).toBeNull();
      expect(await svc.resolveSessionWorkspaceRoot('relative')).toBeNull();
      expect(await svc.resolveSessionWorkspaceRoot('unknown')).toBeNull();
      expect(await svc.resolveSessionWorkspaceRoot('')).toBeNull();
      vi.mocked(AISessionsRepository.get).mockImplementation(async () => { throw new Error('db locked'); });
      expect(await svc.resolveSessionWorkspaceRoot('reviewer-a')).toBeNull();
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows may hold the dir briefly */ }
    }
  });
});
