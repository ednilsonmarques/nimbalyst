import { beforeEach, describe, expect, it, vi } from 'vitest';

// Phase 1A.1: (1) a member waiting only on tool-permission prompts no longer
// wakes the coordinator (questions, plan approvals, settles and errors still
// do, and a question behind an unanswered permission still does); (2) an
// architect's final report is judged against the manifest contract before it
// goes into the update: valid travels whole, too long keeps its YAML (bounded)
// with a notice, contract errors get a notice, and no "Preparation: complete"
// survives on an invalid manifest.
//
// Mock surface mirrors MetaAgentService.notificationEcho.test.ts.
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

import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { AgentMessagesRepository } from '@nimbalyst/runtime/storage/repositories/AgentMessagesRepository';
import { TOOL_MANIFEST_MAX_CHARS } from '@nimbalyst/runtime/ai/server/providers/toolManifest';
import { CHILD_UPDATE_FINAL_REPORT_MAX_CHARS, MetaAgentService, renderArchitectFinalReport } from '../MetaAgentService';

const fromParent = { promptProvenance: { actor: 'agent', origin: 'session-orchestration', originSessionId: 'parent-1' } };

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

/** A complete, contract-valid manifest body (the validator accepts it). */
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
  'generatedBy: { role: architect, model: claude-opus-5-5, ecc: "2.2.3" }',
].join('\n');
const VALID_BLOCK = '```yaml\n' + VALID_YAML + '\n```';

/** A manifest message of exactly `total` characters: the YAML, then Markdown padding, then the Preparation line. */
function manifestMessage(total: number, yaml: string = VALID_YAML): string {
  const tail = '\n\nPreparation: complete';
  const head = '```yaml\n' + yaml + '\n```\n\n## Notes\n';
  const padding = 'x'.repeat(Math.max(0, total - head.length - tail.length));
  const text = `${head}${padding}${tail}`;
  expect(text.length).toBe(total);
  return text;
}

describe('renderArchitectFinalReport', () => {
  it('keeps a valid manifest within the contract whole', () => {
    const text = manifestMessage(TOOL_MANIFEST_MAX_CHARS);
    expect(renderArchitectFinalReport(text)).toBe(text);
  });

  it('above the contract keeps the YAML whole, drops the Markdown and the Preparation line, and tells the coordinator what to do', () => {
    const text = manifestMessage(TOOL_MANIFEST_MAX_CHARS + 93);
    const rendered = renderArchitectFinalReport(text);
    expect(rendered).toContain(VALID_BLOCK);
    expect(rendered).toContain('MANIFEST TOO LONG');
    expect(rendered).toContain(`${TOOL_MANIFEST_MAX_CHARS + 93} characters`);
    expect(rendered).toContain('the limit is 7500');
    expect(rendered).not.toContain('Preparation: complete');
    expect(rendered).not.toContain('[truncated:');
    expect(rendered).toContain('Do not declare per manifest M-1');
    expect(rendered).toContain('as M-2 with supersedes: M-1');
    // The Markdown is gone with its padding: only the YAML and the notice remain.
    expect(rendered).not.toContain('## Notes');
    expect(rendered).not.toMatch(/xxxxxxxxxx/);
  });

  it('a "Preparation: complete" line smuggled into the YAML of an over-limit manifest does not survive', () => {
    const text = manifestMessage(TOOL_MANIFEST_MAX_CHARS + 1, `${VALID_YAML}\nPreparation: complete`);
    const rendered = renderArchitectFinalReport(text);
    expect(rendered).not.toMatch(/^Preparation:\s*complete/m);
    expect(rendered).toContain('MANIFEST TOO LONG');
  });

  it('a YAML block far above any valid manifest is bounded with an explicit marker, never silently', () => {
    const huge = `${VALID_YAML}\nevidence2: "${'z'.repeat(100_000)}"`;
    const rendered = renderArchitectFinalReport(`\`\`\`yaml\n${huge}\n\`\`\`\n\nPreparation: complete`);
    expect(rendered.length).toBeLessThan(CHILD_UPDATE_FINAL_REPORT_MAX_CHARS + 1200);
    expect(rendered).toContain('[YAML cut at 8000 characters');
    expect(rendered).toContain('MANIFEST TOO LONG');
  });

  it('a manifest within the limit that breaks the contract travels with its errors and without a complete Preparation line', () => {
    const yaml = VALID_YAML.replace('mcpRecommended: []', 'mcpRecommended:\n  - { server: nimbalyst-host, purpose: tests, scope: review, authorizationRequired: false }');
    const text = manifestMessage(6000, yaml);
    const rendered = renderArchitectFinalReport(text);
    expect(rendered).toContain('MANIFEST INVALID');
    expect(rendered).toContain("nimbalyst-host is Nimbalyst's own infrastructure");
    expect(rendered).not.toMatch(/^Preparation:\s*complete/m);
    expect(rendered).toContain('Preparation: invalid (see the notice below)');
    expect(rendered).toContain('re-emit the whole manifest corrected as M-2 with supersedes: M-1');
    // The YAML itself still travels, so the coordinator can judge the rest.
    expect(rendered).toContain('toolManifest: 1');
  });

  it('a manifest the validator cannot even judge (a recursive YAML alias) is reported invalid, never thrown', () => {
    const yaml = VALID_YAML.replace('    - { role: implementer, scope: full, why: owns the files }', '    - { role: implementer, scope: &a [*a], why: owns the files }');
    const rendered = renderArchitectFinalReport(manifestMessage(5000, yaml));
    expect(rendered).toContain('MANIFEST INVALID');
    expect(rendered).not.toMatch(/^Preparation:\s*complete/m);
  });

  it('a final message that is not a manifest gets the ordinary cap and marker', () => {
    const plain = 'y'.repeat(CHILD_UPDATE_FINAL_REPORT_MAX_CHARS + 10);
    const rendered = renderArchitectFinalReport(plain);
    expect(rendered).toContain('[truncated: 10 more characters; get_session_result has the full text]');
    expect(rendered.startsWith('y'.repeat(CHILD_UPDATE_FINAL_REPORT_MAX_CHARS))).toBe(true);
  });
});

describe('[Child Session Update] of an architect (Phase 1A.1)', () => {
  async function notificationFor(finalMessage: string) {
    vi.mocked(AISessionsRepository.get).mockResolvedValue(row() as never);
    vi.mocked(AgentMessagesRepository.list).mockResolvedValue([
      { direction: 'input', content: 'TASK', metadata: fromParent },
      { direction: 'output', content: finalMessage, metadata: null },
    ] as never);
    const service = MetaAgentService.getInstance() as any;
    const result = await service.buildSessionResultData('child-1', '/ws', undefined, false, {
      excludeInputFromSessionId: 'parent-1',
      wholeFinalOutput: true,
    });
    return service.buildNotificationMessage('session:completed', result, true) as string;
  }

  it('a manifest above the contract arrives with its YAML whole and marked invalid, never cut at the cap', async () => {
    const text = await notificationFor(manifestMessage(CHILD_UPDATE_FINAL_REPORT_MAX_CHARS + 400));
    expect(text).toContain('[Child Session Update]');
    expect(text).toContain(VALID_BLOCK);
    expect(text).toContain('MANIFEST TOO LONG');
    expect(text).not.toContain('[truncated:');
    expect(text).not.toContain('Preparation: complete');
  });

  it('a valid manifest within the contract arrives whole, Preparation line included', async () => {
    const message = manifestMessage(TOOL_MANIFEST_MAX_CHARS - 1);
    const text = await notificationFor(message);
    expect(text).toContain(message);
    expect(text).not.toContain('MANIFEST TOO LONG');
    expect(text).not.toContain('MANIFEST INVALID');
    expect(text).toContain('Preparation: complete');
  });
});

describe('coordinator wakeups (Phase 1A.1)', () => {
  const parentRow = { id: 'parent-1', workspacePath: '/ws', agentRole: 'standard', metadata: { teamMode: true }, createdBySessionId: null };
  let service: any;
  let queued: ReturnType<typeof vi.fn>;
  let triggered: ReturnType<typeof vi.fn>;

  const permission = (id: string) => ({ id, promptId: id, promptType: 'permission_request', createdAt: 1, content: { type: 'permission_request', requestId: id, toolName: 'Bash' } });
  const question = (id: string) => ({ id, promptId: id, promptType: 'ask_user_question_request', createdAt: 2, content: { questions: [{ question: 'Which API?' }] } });

  beforeEach(() => {
    service = MetaAgentService.getInstance() as any;
    queued = vi.fn().mockResolvedValue({ id: 'q1' });
    triggered = vi.fn().mockResolvedValue(undefined);
    service.aiService = { queuePromptForSession: queued, triggerQueuedPromptProcessingForSession: triggered };
    vi.mocked(AISessionsRepository.get).mockImplementation(async (id: string) => (id === 'parent-1' ? parentRow : row({ metadata: { toolScope: 'full', teamChild: { role: 'implementer', rootSessionId: 'parent-1', depth: 1 } } })) as never);
  });

  function resultWith(pendingPrompt: Record<string, unknown> | null, status = 'waiting_for_input') {
    return {
      sessionId: 'child-1', title: 'Implementer', provider: 'claude-code', model: 'claude-code:sonnet', status,
      lastActivity: null, originalPrompt: null, userPrompts: [], lastResponse: 'working', fullResponse: null,
      recentMessages: [{ direction: 'output', text: 'working' }], editedFiles: [], pendingPrompt, createdAt: 1, updatedAt: 2,
      toolScope: null, toolScopeEnforced: false,
    };
  }

  it('does not wake the coordinator for a member waiting only on tool-permission prompts: that decision is the user\'s', async () => {
    vi.spyOn(service, 'buildSessionResultData').mockResolvedValue(resultWith(permission('perm-1')));
    vi.spyOn(service, 'listPendingInteractivePrompts').mockResolvedValue([permission('perm-1'), permission('perm-2')]);
    await service.handleChildSessionEvent('child-1', 'session:waiting');
    expect(queued).not.toHaveBeenCalled();
    expect(triggered).not.toHaveBeenCalled();
  });

  it('still wakes the coordinator for a question it can answer', async () => {
    vi.spyOn(service, 'buildSessionResultData').mockResolvedValue(resultWith(question('q-1')));
    vi.spyOn(service, 'listPendingInteractivePrompts').mockResolvedValue([question('q-1')]);
    await service.handleChildSessionEvent('child-1', 'session:waiting');
    expect(queued).toHaveBeenCalledTimes(1);
    expect(String(queued.mock.calls[0][1])).toContain('ACTION REQUIRED');
    expect(String(queued.mock.calls[0][1])).toContain('Which API?');
  });

  it('a question behind an older unanswered permission still wakes the coordinator, and the question is what it sees', async () => {
    vi.spyOn(service, 'buildSessionResultData').mockResolvedValue(resultWith(permission('perm-old')));
    vi.spyOn(service, 'listPendingInteractivePrompts').mockResolvedValue([permission('perm-old'), question('q-new')]);
    await service.handleChildSessionEvent('child-1', 'session:waiting');
    expect(queued).toHaveBeenCalledTimes(1);
    const text = String(queued.mock.calls[0][1]);
    expect(text).toContain('Which API?');
    expect(text).toContain('promptId: "q-new"');
    expect(text).not.toContain('Tool requesting permission');
  });

  it('still wakes the coordinator when the member settles, so no report is lost', async () => {
    vi.spyOn(service, 'buildSessionResultData').mockResolvedValue(resultWith(null, 'idle'));
    vi.spyOn(service, 'listPendingInteractivePrompts').mockResolvedValue([]);
    await service.handleChildSessionEvent('child-1', 'session:completed');
    expect(queued).toHaveBeenCalledTimes(1);
    expect(String(queued.mock.calls[0][1])).toContain('[Child Session Update]');
    expect(triggered).toHaveBeenCalledTimes(1);
  });

  it('still wakes the coordinator on a member error', async () => {
    vi.spyOn(service, 'buildSessionResultData').mockResolvedValue({ ...resultWith(null, 'error'), errorMessage: 'boom' });
    vi.spyOn(service, 'listPendingInteractivePrompts').mockResolvedValue([]);
    await service.handleChildSessionEvent('child-1', 'session:error');
    expect(queued).toHaveBeenCalledTimes(1);
    expect(String(queued.mock.calls[0][1])).toContain('Error: boom');
  });

  it('an update that still mentions a pending permission never tells the coordinator to allow it', () => {
    const text = service.buildNotificationMessage('session:completed', resultWith(permission('perm-1'), 'idle')) as string;
    expect(text).toContain('Tool requesting permission: Bash');
    expect(text).toContain("the user's decision");
    expect(text).not.toContain('"decision": "allow"');
  });
});
