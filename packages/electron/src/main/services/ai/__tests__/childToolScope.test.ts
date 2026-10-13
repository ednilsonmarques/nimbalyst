import { describe, expect, it, vi } from 'vitest';

vi.mock('../providerResolution', () => ({
  usesHostSuppliedToolLoop: (provider: string) => provider === 'antigravity-gemini-agent',
}));

import { describeChildToolScope, isToolScopeEnforced } from '../childToolScope';

describe('isToolScopeEnforced', () => {
  it('is true for claude-code and host tool-loop providers', () => {
    expect(isToolScopeEnforced('claude-code')).toBe(true);
    expect(isToolScopeEnforced('antigravity-gemini-agent')).toBe(true);
  });

  it('is false for providers that ignore the scope, and for a missing provider', () => {
    expect(isToolScopeEnforced('claude-code-cli')).toBe(false);
    expect(isToolScopeEnforced('openai-codex')).toBe(false);
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
    expect(describeChildToolScope('write', true)).toContain('this child had NO shell (run_command/Bash) or delegation tools');
  });

  it('review states that its only execution was the workspace tests', () => {
    const line = describeChildToolScope('review', true)!;
    expect(line).toContain('Tool scope: review');
    expect(line).toContain('NO file-writing, shell (run_command/Bash), delegation, skill, hook, web (WebFetch/WebSearch), external MCP (user servers, plugins, claude.ai connectors) or app-changing tools');
    expect(line).toContain('its only execution was the workspace\'s own tests through run_project_tests');
    expect(describeChildToolScope('review', false)).toContain('does not enforce it');
  });

  it('does not claim a denial the provider never applied', () => {
    const line = describeChildToolScope('write', false)!;
    expect(line).toContain('does not enforce it');
    expect(line).not.toContain('had NO');
  });
});
