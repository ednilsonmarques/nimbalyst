// @vitest-environment node
/**
 * Portal F1.1 -- the single main-side authorization module. A browser caller is
 * either the user's UI (no actor at all) or an agent holding a token that main
 * issued for one tool call. A bare session id, a forged token or any other
 * value is refused, never read as the user.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => (await import('./helpers/fakeElectronBrowser')).createElectronMock());
vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } },
}));

import {
  EXTENSION_DEV_TEST_ACTOR,
  issueActorToken,
  revokeActorToken,
  resolveCaller,
  withActorToken,
  selectPartition,
  isAgentPartitionName,
  __resetActorTokensForTests,
} from '../BrowserAuthority';

beforeEach(() => __resetActorTokensForTests());
afterEach(() => vi.useRealTimers());

describe('resolveCaller', () => {
  it('treats an absent or null actor as the user', () => {
    expect(resolveCaller(undefined)).toEqual({ ok: true, actor: undefined });
    expect(resolveCaller(null)).toEqual({ ok: true, actor: undefined });
  });

  it('resolves a main-issued token to the actor it was issued for', () => {
    const token = issueActorToken('ai-session-A');
    expect(token).not.toContain('ai-session-A');
    expect(resolveCaller(token)).toEqual({ ok: true, actor: 'ai-session-A' });
  });

  it('refuses a bare session id (what a renderer could invent)', () => {
    expect(resolveCaller('ai-session-A').ok).toBe(false);
    expect(resolveCaller(EXTENSION_DEV_TEST_ACTOR).ok).toBe(false);
    expect(resolveCaller('unattributed-ai-session').ok).toBe(false);
  });

  it.each(['', 0, false, {}, [], 42])('refuses malformed actor %j', (raw) => {
    expect(resolveCaller(raw).ok).toBe(false);
  });

  it('refuses a guessed token and a revoked token', () => {
    expect(resolveCaller('nimactor_' + 'a'.repeat(48)).ok).toBe(false);
    const token = issueActorToken('ai-session-A');
    revokeActorToken(token);
    expect(resolveCaller(token).ok).toBe(false);
  });

  it('refuses an expired token', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const token = issueActorToken('ai-session-A', 1000);
    vi.setSystemTime(new Date('2026-01-01T00:00:02Z'));
    expect(resolveCaller(token).ok).toBe(false);
  });

  it('gives distinct tokens to the same actor', () => {
    expect(issueActorToken('ai-session-A')).not.toBe(issueActorToken('ai-session-A'));
  });
});

describe('withActorToken', () => {
  it('reports whether the token was presented, and revokes it afterwards', async () => {
    let seen = '';
    const unused = await withActorToken('ai-session-A', async (token) => {
      seen = token;
      return 1;
    });
    expect(unused.used).toBe(false);
    expect(resolveCaller(seen).ok).toBe(false);

    const used = await withActorToken('ai-session-A', async (token) => {
      resolveCaller(token);
      return 2;
    });
    expect(used).toMatchObject({ value: 2, used: true });
  });

  it('revokes the token when the work throws', async () => {
    let seen = '';
    await expect(
      withActorToken('ai-session-A', async (token) => {
        seen = token;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(resolveCaller(seen).ok).toBe(false);
  });
});

describe('selectPartition', () => {
  it('leaves the user partition choice exactly as today', () => {
    expect(selectPartition(null, undefined)).toBe('browser-preview');
    expect(selectPartition(null, 'persist:work')).toBe('persist:work');
    expect(selectPartition(null, 'x')).toBe('browser-x');
  });

  it('gives each agent portal a fresh, non-persistent partition of its own', () => {
    const a = selectPartition('ai-session-A', undefined);
    const b = selectPartition('ai-session-A', undefined);
    const c = selectPartition('ai-session-B', undefined);
    expect(new Set([a, b, c]).size).toBe(3);
    for (const name of [a, b, c]) {
      expect(name).not.toBe('browser-preview');
      expect(name.startsWith('persist:')).toBe(false);
      expect(isAgentPartitionName(name)).toBe(true);
    }
  });

  it('refuses any partition request from an agent, user or persisted', () => {
    for (const requested of ['preview', 'browser-preview', 'persist:work', 'agent-portal-x', 'x']) {
      expect(() => selectPartition('ai-session-A', requested)).toThrow(/partition/i);
    }
  });

  it('never classifies a user partition as an agent partition', () => {
    expect(isAgentPartitionName('browser-preview')).toBe(false);
    expect(isAgentPartitionName('persist:agent-portal-x')).toBe(false);
  });
});
