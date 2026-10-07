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
    expect(describeChildToolScope('read', true)).toContain('this child had NO file-writing, shell (run_command/Bash), delegation, or app-changing tools');
    expect(describeChildToolScope('write', true)).toContain('this child had NO shell (run_command/Bash) or delegation tools');
  });

  it('does not claim a denial the provider never applied', () => {
    const line = describeChildToolScope('write', false)!;
    expect(line).toContain('does not enforce it');
    expect(line).not.toContain('had NO');
  });
});
