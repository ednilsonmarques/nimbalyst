// @vitest-environment node
/**
 * NIB.85 stage d1: safeHandle / safeOn / safeOnce consult an installed sender
 * validator. With none installed (every other unit test) they behave as before.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const handlers = new Map<string, (...args: any[]) => any>();
const listeners = new Map<string, (...args: any[]) => any>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => any) => { handlers.set(channel, handler); }),
    on: vi.fn((channel: string, listener: (...args: any[]) => any) => { listeners.set(channel, listener); }),
    once: vi.fn((channel: string, listener: (...args: any[]) => any) => { listeners.set(channel, listener); }),
  },
}));

import { safeHandle, safeOn, safeOnce, installIpcSenderValidator } from '../ipcRegistry';

const goodEvent = { sender: { id: 1 }, senderFrame: { url: 'app' } };
const badEvent = { sender: { id: 2 }, senderFrame: { url: 'evil' } };

describe('ipcRegistry sender validation', () => {
  beforeEach(() => {
    handlers.clear();
    listeners.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    installIpcSenderValidator(null);
    vi.restoreAllMocks();
  });

  it('runs every handler normally when no validator is installed', async () => {
    const h = vi.fn(async () => 'ok');
    safeHandle('sv:plain', h);
    await expect(handlers.get('sv:plain')!(badEvent)).resolves.toBe('ok');
  });

  it('rejects an invoke from a rejected sender without running the handler', async () => {
    installIpcSenderValidator((event) => (event as any).senderFrame.url === 'app' ? { allowed: true } : { allowed: false, reason: 'foreign-url' });
    const h = vi.fn(async () => 'ok');
    safeHandle('sv:invoke', h);
    await expect(handlers.get('sv:invoke')!(goodEvent)).resolves.toBe('ok');
    await expect(handlers.get('sv:invoke')!(badEvent)).rejects.toThrow(/sender/i);
    expect(h).toHaveBeenCalledTimes(1);
  });

  it('also guards channels that are registered unwrapped for timing (UNTIMED list)', async () => {
    installIpcSenderValidator(() => ({ allowed: false, reason: 'subframe' }));
    const h = vi.fn(async () => 'ok');
    safeHandle('ai:sendMessage', h);
    await expect(handlers.get('ai:sendMessage')!(goodEvent)).rejects.toThrow(/sender/i);
    expect(h).not.toHaveBeenCalled();
  });

  it('drops a send from a rejected sender (safeOn and safeOnce) without throwing', () => {
    installIpcSenderValidator((event) => (event as any).senderFrame.url === 'app' ? { allowed: true } : { allowed: false, reason: 'foreign-url' });
    const on = vi.fn();
    const once = vi.fn();
    safeOn('sv:on', on);
    safeOnce('sv:once', once);
    expect(() => listeners.get('sv:on')!(badEvent, 'x')).not.toThrow();
    expect(() => listeners.get('sv:once')!(badEvent, 'x')).not.toThrow();
    expect(on).not.toHaveBeenCalled();
    expect(once).not.toHaveBeenCalled();
    listeners.get('sv:on')!(goodEvent, 'x');
    expect(on).toHaveBeenCalledTimes(1);
  });

  it('logs a rejection once per channel and reason, not on every call', async () => {
    installIpcSenderValidator(() => ({ allowed: false, reason: 'foreign-url' }));
    safeHandle('sv:log', async () => 'ok');
    const warn = vi.mocked(console.warn);
    warn.mockClear();
    for (let i = 0; i < 5; i += 1) {
      await expect(handlers.get('sv:log')!(badEvent)).rejects.toThrow();
    }
    const lines = warn.mock.calls.filter((c) => String(c[0]).includes('sv:log'));
    expect(lines.length).toBe(1);
  });

  it('log-only mode logs but still runs the handler', async () => {
    installIpcSenderValidator(() => ({ allowed: false, reason: 'subframe' }), { enforce: false });
    const h = vi.fn(async () => 'ok');
    safeHandle('sv:logonly', h);
    await expect(handlers.get('sv:logonly')!(badEvent)).resolves.toBe('ok');
    expect(h).toHaveBeenCalledTimes(1);
  });
});
