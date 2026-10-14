import { describe, expect, it, vi } from 'vitest';

vi.mock('../providerResolution', () => ({
  usesHostSuppliedToolLoop: (provider: string) => provider === 'antigravity-gemini-agent',
}));

import { describeChildToolScope, isToolScopeEnforced } from '../childToolScope';

describe('isToolScopeEnforced', () => {
  it('is true for claude-code and host tool-loop providers, at every scope', () => {
    expect(isToolScopeEnforced('claude-code')).toBe(true);
    expect(isToolScopeEnforced('claude-code', 'write')).toBe(true);
    expect(isToolScopeEnforced('antigravity-gemini-agent')).toBe(true);
    expect(isToolScopeEnforced('antigravity-gemini-agent', 'read')).toBe(true);
  });

  it('is true for openai-codex at read and review only (the session-scoped MCP server plus the read-only thread), never for write or without a scope', () => {
    expect(isToolScopeEnforced('openai-codex', 'read')).toBe(true);
    expect(isToolScopeEnforced('openai-codex', 'review')).toBe(true);
    expect(isToolScopeEnforced('openai-codex', 'write')).toBe(false);
    expect(isToolScopeEnforced('openai-codex', 'full')).toBe(false);
    expect(isToolScopeEnforced('openai-codex')).toBe(false);
  });

  it('is false for providers that ignore the scope, and for a missing provider', () => {
    expect(isToolScopeEnforced('claude-code-cli')).toBe(false);
    expect(isToolScopeEnforced('openai-codex-acp', 'read')).toBe(false);
    expect(isToolScopeEnforced('opencode', 'read')).toBe(false);
    expect(isToolScopeEnforced(null)).toBe(false);
    expect(isToolScopeEnforced(undefined)).toBe(false);
  });
});

describe('describeChildToolScope', () => {
  it('says nothing for full or missing scopes', () => {
    expect(describeChildToolScope(null, true)).toBeNull();
    expect(describeChildToolScope('full', true)).toBeNull();
  });

  it('asserts the denial only when the provider enforces it', () => {
    // Since Phase 0 the read line names every denied family (skill, hook, web, external MCP), so the model cannot claim one of them was available.
    expect(describeChildToolScope('read', true)).toContain('this child had NO file-writing, shell (run_command/Bash), delegation, skill, hook, web (WebFetch/WebSearch), external MCP (user servers, plugins, claude.ai connectors) or app-changing tools');
    expect(describeChildToolScope('write', true)).toContain('this child had NO shell (run_command/Bash), test-runner (run_project_tests) or delegation tools');
  });

  it('review states that its only execution was the workspace tests', () => {
    const line = describeChildToolScope('review', true)!;
    expect(line).toContain('Tool scope: review');
    expect(line).toContain('NO file-writing, shell (run_command/Bash), delegation, skill, hook, web (WebFetch/WebSearch), external MCP (user servers, plugins, claude.ai connectors) or app-changing tools');
    expect(line).toContain('its only execution was the workspace\'s own tests through run_project_tests');
    expect(describeChildToolScope('review', false)).toContain('does not enforce it');
  });

  it('on openai-codex a read or review child is described with its shell\'s known-safe read commands, never as having no shell', () => {
    const read = describeChildToolScope('read', true, 'openai-codex')!;
    expect(read).toContain('Tool scope: read (this child had NO file-writing, shell (every command, patch and approval of this child was refused by the host, at most Codex\'s own known-safe read-only commands, ls, cat, head, tail, wc, nl, pwd, grep, rg, find, sed -n, git status / log / diff / show, could run; it read files through the host\'s read_file, list_files and search_files tools), delegation, skill, hook, web');
    expect(read).not.toContain('shell (run_command/Bash)');
    expect(describeChildToolScope('review', true, 'openai-codex')).toContain('it read files through the host\'s read_file, list_files and search_files tools');
    expect(describeChildToolScope('read', true, 'claude-code')).toContain('shell (run_command/Bash)');
    expect(describeChildToolScope('read', true)).toContain('shell (run_command/Bash)');
  });

  it('does not claim a denial the provider never applied', () => {
    const line = describeChildToolScope('write', false)!;
    expect(line).toContain('does not enforce it');
    expect(line).not.toContain('had NO');
  });
});
