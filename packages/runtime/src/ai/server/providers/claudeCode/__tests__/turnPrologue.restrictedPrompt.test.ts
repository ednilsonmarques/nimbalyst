// @vitest-environment node
/**
 * buildTurnQuery hands a read/review child a slash prompt as plain text before
 * anything is built from it (scope probe P6). This exercises the ordering in
 * the prologue itself; the pure rule lives in restrictedPrompt.test.ts.
 */

import os from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ buildSdkOptions: vi.fn() }));
vi.mock('../sdkOptionsBuilder', () => ({ buildSdkOptions: mocks.buildSdkOptions }));
vi.mock('../ClaudeCodeTranscriptAdapter', () => ({
  ClaudeCodeTranscriptAdapter: class { userMessage(): void {} },
}));

import { buildTurnQuery, type TurnQueryHost } from '../turnPrologue';
import { createTurnState } from '../turnState';
import { RESTRICTED_SCOPE_SLASH_NOTICE } from '../restrictedPrompt';

type Host = TurnQueryHost & { emitted: string[] };

function makeHost(overrides: Partial<TurnQueryHost> = {}): Host {
  const emitted: string[] = [];
  return {
    emitted,
    getAgentRole: vi.fn(async () => 'standard' as const),
    getWorkflowPreset: vi.fn(async () => 'default' as any),
    getToolScope: vi.fn(async () => 'read' as const),
    ensureGitContext: vi.fn(async () => {}),
    ensureSessionDirective: vi.fn(async () => {}),
    ensureTeamContext: vi.fn(async () => {}),
    buildSystemPrompt: () => 'system prompt',
    emit: (event: string) => { emitted.push(event); },
    withPromptProvenanceMetadata: () => ({}),
    logAgentMessage: vi.fn(async () => {}),
    resolveModelVariant: () => 'opus',
    getMcpServersSnapshot: async () => ({}),
    createCanUseToolHandler: () => () => true,
    toolHooksService: {} as any,
    teammateManager: {} as any,
    sessions: {} as any,
    config: {} as any,
    abortController: new AbortController(),
    currentMode: 'agent',
    metaAgentAllowedTools: ['Read'],
    publishSdkResult: () => {},
    ...overrides,
  } as Host;
}

function makeParams(extra: Record<string, unknown> = {}) {
  const dir = os.tmpdir();
  return {
    sessionId: 'child-1',
    workspacePath: dir,
    paths: { currentMode: 'agent', pathForTrust: dir, permissionsPath: dir, mcpConfigWorkspacePath: dir },
    prepared: {
      staging: { root: dir, mode: 'temp' },
      preflightAttachmentDenyRule: null,
      imageContentBlocks: [],
      documentContentBlocks: [],
      largeAttachmentFilePaths: [],
      failedAttachments: [],
    },
    ...extra,
  } as any;
}

function makeState(message: string) {
  const state = createTurnState({ startTime: Date.now(), hideMessages: false, originalMessage: message });
  state.message = message;
  return state;
}

/** The prompt text the SDK would receive: what the prologue passed to buildSdkOptions. */
const sentMessage = (): string => mocks.buildSdkOptions.mock.calls[0]?.[1]?.message;

beforeEach(() => {
  mocks.buildSdkOptions.mockReset();
  mocks.buildSdkOptions.mockImplementation(async (_deps: unknown, params: { message: string }) => ({
    options: { cwd: os.tmpdir(), disallowedTools: [], mcpServers: {}, model: 'opus' },
    promptController: null,
    helperMethod: 'native',
    message: params.message,
  }));
});

describe('buildTurnQuery and slash prompts for restricted children', () => {
  it('hands a read child a slash command as plain text, before the document context is attached', async () => {
    const host = makeHost();
    const state = makeState('/probe:hooks-skill run it');
    await buildTurnQuery(host, state, makeParams({ documentContext: { documentContextPrompt: 'DOC CONTEXT' } }));

    expect(host.getToolScope).toHaveBeenCalledWith('child-1');
    expect(state.isSlashCommand).toBe(false);
    expect(sentMessage().startsWith(RESTRICTED_SCOPE_SLASH_NOTICE)).toBe(true);
    expect(sentMessage()).toContain('/probe:hooks-skill run it');
    expect(sentMessage()).toContain('DOC CONTEXT');
  });

  it('lets a review child keep the built-in /context command the app itself sends', async () => {
    const host = makeHost({ getToolScope: vi.fn(async () => 'review' as const) });
    const state = makeState('/context');
    await buildTurnQuery(host, state, makeParams());

    expect(state.isSlashCommand).toBe(true);
    expect(sentMessage()).toBe('/context');
  });

  it('never reads a scope for the meta-agent and leaves its slash commands alone', async () => {
    const host = makeHost({ getAgentRole: vi.fn(async () => 'meta-agent' as const) });
    const state = makeState('/probe:hooks-skill');
    await buildTurnQuery(host, state, makeParams());

    expect(host.getToolScope).not.toHaveBeenCalled();
    expect(state.isSlashCommand).toBe(true);
    expect(sentMessage()).toBe('/probe:hooks-skill');
  });

  it('leaves an unrestricted (full) child alone', async () => {
    const host = makeHost({ getToolScope: vi.fn(async () => 'full' as const) });
    const state = makeState('/probe:hooks-skill');
    await buildTurnQuery(host, state, makeParams());

    expect(state.isSlashCommand).toBe(true);
    expect(sentMessage()).toBe('/probe:hooks-skill');
  });

  it('fails closed when the scope cannot be read: nothing is emitted or built', async () => {
    const host = makeHost({ getToolScope: vi.fn(async () => { throw new Error('scope store unavailable'); }) });
    const state = makeState('/probe:hooks-skill');

    await expect(buildTurnQuery(host, state, makeParams())).rejects.toThrow('scope store unavailable');
    expect(host.emitted).not.toContain('promptAdditions');
    expect(mocks.buildSdkOptions).not.toHaveBeenCalled();
  });
});
