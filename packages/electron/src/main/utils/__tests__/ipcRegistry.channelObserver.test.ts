// @vitest-environment node
/**
 * NIB.85 stage d3: safeHandle / safeOn / safeOnce report each invoked channel to
 * an installed observer. The observer cannot change behavior: handlers still
 * run, results still return, a throwing observer is ignored.
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

import { safeHandle, safeOn, safeOnce, installIpcChannelObserver } from '../ipcRegistry';

describe('ipcRegistry channel observer', () => {
  beforeEach(() => { handlers.clear(); listeners.clear(); });
  afterEach(() => { installIpcChannelObserver(null); });

  it('reports invoke, on and once channels and still runs the handlers', async () => {
    const seen: string[] = [];
    installIpcChannelObserver((channel) => { seen.push(channel); });
    const h = vi.fn(async () => 'ok');
    const on = vi.fn();
    const once = vi.fn();
    safeHandle('obs:invoke', h);
    safeHandle('ai:sendMessage', h);
    safeOn('obs:on', on);
    safeOnce('obs:once', once);
    await expect(handlers.get('obs:invoke')!({})).resolves.toBe('ok');
    await expect(handlers.get('ai:sendMessage')!({})).resolves.toBe('ok');
    listeners.get('obs:on')!({}, 1);
    listeners.get('obs:once')!({}, 1);
    expect(seen).toEqual(['obs:invoke', 'ai:sendMessage', 'obs:on', 'obs:once']);
    expect(on).toHaveBeenCalledTimes(1);
    expect(once).toHaveBeenCalledTimes(1);
  });

  it('ignores an observer that throws', async () => {
    installIpcChannelObserver(() => { throw new Error('observer failed'); });
    safeHandle('obs:throws', async () => 'still-ok');
    await expect(handlers.get('obs:throws')!({})).resolves.toBe('still-ok');
  });

  it('does nothing when no observer is installed', async () => {
    safeHandle('obs:none', async () => 'fine');
    await expect(handlers.get('obs:none')!({})).resolves.toBe('fine');
  });
});
