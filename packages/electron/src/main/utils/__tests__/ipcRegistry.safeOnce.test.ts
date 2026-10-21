// @vitest-environment node
/**
 * safeOnce with a REAL EventEmitter behind ipcMain (so `once` semantics are the
 * real ones): a message from a rejected sender must not use up the one-shot
 * listener that the next, accepted, message is waiting for.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { fakeIpcMain } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('events');
  const emitter = new EventEmitter();
  (emitter as any).handle = () => {};
  return { fakeIpcMain: emitter as import('events').EventEmitter & { handle: () => void } };
});

vi.mock('electron', () => ({ ipcMain: fakeIpcMain }));

import { safeOnce, safeOn, installIpcSenderValidator } from '../ipcRegistry';

const good = { sender: { id: 1 }, senderFrame: { url: 'app' } };
const bad = { sender: { id: 2 }, senderFrame: { url: 'evil' } };
const validator = (event: unknown) =>
  (event as any).senderFrame.url === 'app' ? ({ allowed: true } as const) : ({ allowed: false, reason: 'foreign-url' } as const);

describe('safeOnce with a real EventEmitter', () => {
  beforeEach(() => {
    fakeIpcMain.removeAllListeners();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    installIpcSenderValidator(null);
    vi.restoreAllMocks();
  });

  it('delivers the accepted event that follows a rejected one', () => {
    installIpcSenderValidator(validator);
    const h = vi.fn();
    safeOnce('once:after-reject', h);
    fakeIpcMain.emit('once:after-reject', bad, 'from-evil');
    expect(h).not.toHaveBeenCalled();
    fakeIpcMain.emit('once:after-reject', good, 'from-app');
    expect(h).toHaveBeenCalledTimes(1);
    expect(h.mock.calls[0][1]).toBe('from-app');
  });

  it('still fires only once after an accepted event', () => {
    installIpcSenderValidator(validator);
    const h = vi.fn();
    safeOnce('once:only-once', h);
    fakeIpcMain.emit('once:only-once', good, 1);
    fakeIpcMain.emit('once:only-once', good, 2);
    expect(h).toHaveBeenCalledTimes(1);
    expect(fakeIpcMain.listenerCount('once:only-once')).toBe(0);
  });

  it('can register the same handler again after it has fired', () => {
    installIpcSenderValidator(validator);
    const h = vi.fn();
    safeOnce('once:rearm', h);
    fakeIpcMain.emit('once:rearm', good, 1);
    safeOnce('once:rearm', h);
    fakeIpcMain.emit('once:rearm', good, 2);
    expect(h).toHaveBeenCalledTimes(2);
  });

  it('does not use up the listener on a rejected event even when the validator throws', () => {
    installIpcSenderValidator(() => { throw new Error('validator broke'); });
    const h = vi.fn();
    safeOnce('once:validator-throws', h);
    fakeIpcMain.emit('once:validator-throws', good, 1);
    expect(h).not.toHaveBeenCalled();
    installIpcSenderValidator(validator);
    fakeIpcMain.emit('once:validator-throws', good, 2);
    expect(h).toHaveBeenCalledTimes(1);
  });

  it('works unchanged without a validator, and for safeOn', () => {
    const once = vi.fn();
    const on = vi.fn();
    safeOnce('once:plain', once);
    safeOn('on:plain', on);
    fakeIpcMain.emit('once:plain', bad, 1);
    fakeIpcMain.emit('once:plain', bad, 2);
    fakeIpcMain.emit('on:plain', bad, 1);
    fakeIpcMain.emit('on:plain', bad, 2);
    expect(once).toHaveBeenCalledTimes(1);
    expect(on).toHaveBeenCalledTimes(2);
  });
});
