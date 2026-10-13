import { describe, expect, it } from 'vitest';
import { RESTRICTED_SCOPE_SLASH_ALLOWLIST, RESTRICTED_SCOPE_SLASH_NOTICE, neutralizeRestrictedPrompt } from '../restrictedPrompt';

describe('neutralizeRestrictedPrompt', () => {
  it('hands a read or review child a slash command as plain text, keeping the original line', () => {
    for (const scope of ['read', 'review'] as const) {
      const out = neutralizeRestrictedPrompt('/probe:hooks-skill now', scope);
      expect(out.neutralized, scope).toBe(true);
      expect(out.message.startsWith('/'), scope).toBe(false);
      expect(out.message, scope).toBe(RESTRICTED_SCOPE_SLASH_NOTICE + '/probe:hooks-skill now');
    }
  });

  it('ignores leading whitespace when detecting the command', () => {
    expect(neutralizeRestrictedPrompt('  \n/init', 'read').neutralized).toBe(true);
    expect(neutralizeRestrictedPrompt('\t/ecc:plan something', 'review').neutralized).toBe(true);
  });

  it('lets the built-ins Nimbalyst relies on through, with or without arguments', () => {
    for (const cmd of ['/context', '/compact', '/compact focus on the tests', '/clear']) {
      expect(neutralizeRestrictedPrompt(cmd, 'read'), cmd).toEqual({ message: cmd, neutralized: false });
    }
    expect(RESTRICTED_SCOPE_SLASH_ALLOWLIST).toEqual(['/context', '/compact', '/clear']);
  });

  it('does not confuse a prefix match with an allowlisted command', () => {
    expect(neutralizeRestrictedPrompt('/contextual-skill', 'read').neutralized).toBe(true);
    expect(neutralizeRestrictedPrompt('/compact-everything', 'review').neutralized).toBe(true);
    expect(neutralizeRestrictedPrompt('/Compact', 'read').neutralized).toBe(true);
  });

  it('leaves plain prompts, write and full children and unscoped sessions untouched', () => {
    expect(neutralizeRestrictedPrompt('what is 10 / 5', 'read')).toEqual({ message: 'what is 10 / 5', neutralized: false });
    for (const scope of ['write', 'full', undefined] as const) {
      expect(neutralizeRestrictedPrompt('/probe:hooks-skill', scope), String(scope)).toEqual({ message: '/probe:hooks-skill', neutralized: false });
    }
  });

  it('does not touch a "!" prefix, which the SDK already delivers as plain text (probe P6d)', () => {
    expect(neutralizeRestrictedPrompt('!echo hi', 'read')).toEqual({ message: '!echo hi', neutralized: false });
  });
});
