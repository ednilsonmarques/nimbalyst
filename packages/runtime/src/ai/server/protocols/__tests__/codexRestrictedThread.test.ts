// @vitest-environment node
/**
 * A restricted Team mode child's Codex thread: read-only sandbox, `untrusted`
 * approvals, no automatic reviewer, no extra writable roots, and the config
 * overrides the provider computed (web search off, user servers and plugins
 * disabled) carried through to thread/start.
 */
import { describe, expect, it } from 'vitest';
import { resolveCodexPermissionProfile } from '../codexPermissionProfile';
import { buildCodexThreadStartParams, readRestrictedToolScope } from '../codexAppServer/threadConfiguration';

describe('resolveCodexPermissionProfile', () => {
  it('a restricted scope wins over every project permission pair', () => {
    for (const mode of ['bypass-all', 'allow-all', 'ask', undefined]) {
      for (const verified of [true, false]) {
        expect(resolveCodexPermissionProfile(mode, verified, 'read'), `${mode}/${verified}`).toEqual({ sandboxMode: 'read-only', approvalPolicy: 'untrusted' });
        expect(resolveCodexPermissionProfile(mode, verified, 'review'), `${mode}/${verified}`).toEqual({ sandboxMode: 'read-only', approvalPolicy: 'untrusted' });
      }
    }
  });

  it('without a restriction the project pair decides, as before', () => {
    expect(resolveCodexPermissionProfile('bypass-all', true)).toEqual({ sandboxMode: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' });
    expect(resolveCodexPermissionProfile('bypass-all', false)).toEqual({ sandboxMode: 'danger-full-access', approvalPolicy: 'never' });
    expect(resolveCodexPermissionProfile('allow-all', false, null)).toEqual({ sandboxMode: 'workspace-write', approvalPolicy: 'never' });
    expect(resolveCodexPermissionProfile(undefined, false, undefined)).toEqual({ sandboxMode: 'workspace-write', approvalPolicy: 'never' });
  });
});

describe('buildCodexThreadStartParams for a restricted thread', () => {
  const overrides = {
    show_raw_agent_reasoning: true,
    web_search: 'disabled',
    plugins: { 'browser@openai-bundled': { enabled: false }, 'computer-use@openai-bundled': { enabled: false } },
    mcp_servers: { nimbalyst: { url: 'http://127.0.0.1:1/mcp/core' }, node_repl: { enabled: false } },
  };
  const options: any = {
    workspacePath: 'C:\\ws',
    model: 'gpt-6.1-sol',
    permissionMode: 'bypass-all',
    mcpServers: {},
    raw: {
      agentVerified: true,
      effortLevel: 'high',
      systemPrompt: '## Team Member: Independent Advisor ...',
      additionalDirectories: ['C:\\ws-sibling'],
      codexConfigOverrides: overrides,
      restrictedToolScope: 'read',
    },
  };

  it('reads the restriction from raw and starts a read-only, untrusted thread with no reviewer and no extra writable roots', () => {
    expect(readRestrictedToolScope(options)).toBe('read');
    const params = buildCodexThreadStartParams(options);
    expect(params.sandbox).toBe('read-only');
    expect(params.approvalPolicy).toBe('untrusted');
    expect(params.approvalsReviewer).toBeUndefined();
    expect(params.developerInstructions).toContain('Team Member: Independent Advisor');
    expect(params.config).toEqual({ ...overrides, model_reasoning_effort: 'high' });
    expect((params.config as Record<string, unknown>)['sandbox_workspace_write.writable_roots']).toBeUndefined();
  });

  it('the same options without the restriction start the Agent-verified workspace-write thread with the sibling roots, as before', () => {
    const plain = { ...options, raw: { ...options.raw, restrictedToolScope: undefined } } as never;
    expect(readRestrictedToolScope(plain)).toBeNull();
    const params = buildCodexThreadStartParams(plain);
    expect(params.sandbox).toBe('workspace-write');
    expect(params.approvalPolicy).toBe('on-request');
    expect(params.approvalsReviewer).toBe('auto_review');
    expect((params.config as Record<string, unknown>)['sandbox_workspace_write.writable_roots']).toEqual(['C:\\ws-sibling']);
  });

  it('a junk restriction value is no restriction (the provider never sends one it did not resolve)', () => {
    expect(readRestrictedToolScope({ raw: { restrictedToolScope: 'write' } } as never)).toBeNull();
    expect(readRestrictedToolScope({ raw: { restrictedToolScope: 42 } } as never)).toBeNull();
    expect(readRestrictedToolScope({} as never)).toBeNull();
  });
});
