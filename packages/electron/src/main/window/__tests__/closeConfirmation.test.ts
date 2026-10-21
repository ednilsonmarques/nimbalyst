// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { setLanguage } from '@nimbalyst/runtime/i18n';
import type { WindowState } from '../../types';
import {
  buildUnloadPrompt,
  forgetCloseConfirmation,
  clearCloseAttempt,
  handleCloseWindowCancel,
  handleCloseWindowDiscard,
  handleCloseWindowSave,
  handleCloseWindowSaveStarted,
  handleWillPreventUnload,
  isDocumentReplacingNavigation,
  registerCloseListeners,
  setAttemptClockForTests,
} from '../closeConfirmation';

function state(partial: Partial<WindowState> = {}): WindowState {
  return { mode: 'workspace', filePath: null, workspacePath: '/ws', documentEdited: false, ...partial } as WindowState;
}

/** An EventEmitter that behaves like BrowserWindow for 'close': one event object shared by all listeners. */
function fakeWindow() {
  const emitter = new EventEmitter();
  const send = vi.fn();
  const win: any = {
    on: (name: string, fn: (...a: any[]) => void) => emitter.on(name, fn),
    close: vi.fn(),
    destroy: vi.fn(),
    isDestroyed: () => false,
    webContents: { send },
  };
  const requestClose = () => {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    emitter.emit('close', event);
    return event;
  };
  const emitClosed = () => emitter.emit('closed');
  return { win, send, requestClose, emitClosed };
}

/** The listeners as WindowManager wires them: onProceed only snapshots, onClosed releases the state. */
function wire(states: Map<number, WindowState>, opts: { quitting?: boolean } = {}) {
  const fake = fakeWindow();
  const onProceed = vi.fn();
  registerCloseListeners(fake.win, {
    windowId: 1,
    getState: () => states.get(1),
    isQuitting: () => !!opts.quitting,
    onProceed,
    onClosed: () => { states.delete(1); },
  });
  return { ...fake, onProceed };
}

afterEach(async () => {
  forgetCloseConfirmation(1);
  setAttemptClockForTests(null);
  await setLanguage('en');
});

describe('close listeners (B1)', () => {
  it('keeps the window state when the confirmation cancelled the close', () => {
    const states = new Map<number, WindowState>([[1, state({ documentEdited: true })]]);
    const { send, requestClose, onProceed } = wire(states);
    const event = requestClose();
    expect(event.defaultPrevented).toBe(true);
    expect(send).toHaveBeenCalledWith('confirm-close-unsaved');
    expect(onProceed).not.toHaveBeenCalled();
    expect(states.has(1)).toBe(true);
  });

  it('a close that proceeds only snapshots; the state is released when the window is closed (also when quitting)', () => {
    const states = new Map<number, WindowState>([[1, state()]]);
    const { requestClose, emitClosed, onProceed } = wire(states);
    requestClose();
    expect(onProceed).toHaveBeenCalledTimes(1);
    expect(states.has(1)).toBe(true);
    emitClosed();
    expect(states.has(1)).toBe(false);

    const quitting = new Map<number, WindowState>([[1, state({ documentEdited: true })]]);
    const q = wire(quitting, { quitting: true });
    q.requestClose();
    expect(q.send).not.toHaveBeenCalled();
    q.emitClosed();
    expect(quitting.has(1)).toBe(false);
  });
});

describe('a close that Electron cancels after the close listeners (A1)', () => {
  it('main thinks clean, renderer dirty: beforeunload -> Stay keeps the state, and a later dirty report + close works', () => {
    const states = new Map<number, WindowState>([[1, state({ documentEdited: false })]]);
    const { send, requestClose, emitClosed, onProceed } = wire(states);

    // close listeners: nothing to confirm, so the close proceeds past both of them
    const first = requestClose();
    expect(first.defaultPrevented).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(onProceed).toHaveBeenCalledTimes(1);

    // ...but the renderer's beforeunload blocks the unload and the user picks "Stay"
    const stay = handleWillPreventUnload({ preventDefault: vi.fn() }, { windowId: 1, isQuitting: () => false, prompt: () => 1 });
    expect(stay).toBe('stay');
    expect(states.has(1)).toBe(true); // no 'closed' event: the window is still there with its state

    // the renderer's dirty report now lands, and the next close asks
    states.get(1)!.documentEdited = true;
    const second = requestClose();
    expect(second.defaultPrevented).toBe(true);
    expect(send).toHaveBeenCalledWith('confirm-close-unsaved');
    expect(states.has(1)).toBe(true);

    // finally the window really closes: only now is the state released
    states.get(1)!.documentEdited = false;
    requestClose();
    emitClosed();
    expect(states.has(1)).toBe(false);
  });
});

describe('close-window-save / close-window-discard (B2)', () => {
  const env = (states: Map<number, WindowState>) => ({ getWindowId: () => 1, getState: (id: number) => states.get(id) });
  const start = (win: any, states: Map<number, WindowState>, attemptId = 'a1') => handleCloseWindowSaveStarted(win, { attemptId }, env(states));

  it('closes (via close, never destroy) only on a confirmed save of the current attempt with no remaining unsaved changes', () => {
    const states = new Map([[1, state({ documentEdited: false })]]);
    const { win } = fakeWindow();
    start(win, states);
    expect(handleCloseWindowSave(win, { ok: true, attemptId: 'a1' }, env(states))).toBe('closing');
    expect(win.close).toHaveBeenCalledTimes(1);
    expect(win.destroy).not.toHaveBeenCalled();
  });

  it('keeps the window open when the save failed, was not reported, or the window is still edited', () => {
    for (const payload of [{ ok: false, attemptId: 'a1', failed: ['a.md'] }, undefined, null, {}, { ok: 'true', attemptId: 'a1' }, 'ok', { ok: true }]) {
      const states = new Map([[1, state()]]);
      const { win } = fakeWindow();
      start(win, states);
      expect(handleCloseWindowSave(win, payload, env(states)), JSON.stringify(payload)).toBe('kept-open');
      expect(win.close).not.toHaveBeenCalled();
      expect(win.destroy).not.toHaveBeenCalled();
      forgetCloseConfirmation(1);
    }
    const edited = new Map([[1, state({ documentEdited: true })]]);
    const { win } = fakeWindow();
    start(win, edited);
    expect(handleCloseWindowSave(win, { ok: true, attemptId: 'a1' }, env(edited))).toBe('kept-open');
    expect(win.close).not.toHaveBeenCalled();
    expect(win.destroy).not.toHaveBeenCalled();
  });

  it('a window with no state is not proof of "saved"', () => {
    const { win } = fakeWindow();
    start(win, new Map());
    expect(handleCloseWindowSave(win, { ok: true, attemptId: 'a1' }, env(new Map()))).toBe('kept-open');
    expect(win.close).not.toHaveBeenCalled();
  });

  it('ignores destroyed or unknown windows', () => {
    const states = new Map([[1, state()]]);
    expect(handleCloseWindowSave({ ...fakeWindow().win, isDestroyed: () => true }, { ok: true, attemptId: 'a1' }, env(states))).toBe('kept-open');
    expect(handleCloseWindowSave(null, { ok: true, attemptId: 'a1' }, env(states))).toBe('kept-open');
    const { win } = fakeWindow();
    expect(handleCloseWindowSave(win, { ok: true, attemptId: 'a1' }, { getWindowId: () => null, getState: () => undefined })).toBe('kept-open');
  });

  it('discard clears the edited flag so the normal close proceeds, then closes', () => {
    const states = new Map([[1, state({ documentEdited: true })]]);
    const { win, send, requestClose, emitClosed } = wire(states);
    win.close.mockImplementation(() => { requestClose(); emitClosed(); });
    expect(handleCloseWindowDiscard(win, env(states))).toBe('closing');
    expect(send).not.toHaveBeenCalled(); // no second confirmation
    expect(states.has(1)).toBe(false); // the window closed and released its state
  });
});

describe('the save-and-close attempt is guarded as a whole (A2)', () => {
  const env = (states: Map<number, WindowState>) => ({ getWindowId: () => 1, getState: (id: number) => states.get(id) });

  it('delayed save + a second close request + cancel: the window stays open', () => {
    const states = new Map([[1, state({ documentEdited: true })]]);
    const w = wire(states);
    // first close -> one dialog
    w.requestClose();
    expect(w.send).toHaveBeenCalledTimes(1);
    // the user clicks Save: the attempt starts and the save is slow
    handleCloseWindowSaveStarted(w.win, { attemptId: 'a1' }, env(states));
    // a second close request while the attempt is in flight is ignored: no second dialog
    const second = w.requestClose();
    expect(second.defaultPrevented).toBe(true);
    expect(w.send).toHaveBeenCalledTimes(1);
    // the user cancels
    handleCloseWindowCancel(w.win, { attemptId: 'a1' }, env(states));
    // the slow save finally succeeds: its late success cannot close the window
    states.get(1)!.documentEdited = false;
    expect(handleCloseWindowSave(w.win, { ok: true, attemptId: 'a1' }, env(states))).toBe('kept-open');
    expect(w.win.close).not.toHaveBeenCalled();
    expect(states.has(1)).toBe(true);
  });

  it('delayed save that completes (no cancel): the window closes exactly once, and a replay is ignored', () => {
    const states = new Map([[1, state({ documentEdited: true })]]);
    const w = wire(states);
    w.requestClose();
    handleCloseWindowSaveStarted(w.win, { attemptId: 'a1' }, env(states));
    w.requestClose();
    expect(w.send).toHaveBeenCalledTimes(1);
    states.get(1)!.documentEdited = false;
    expect(handleCloseWindowSave(w.win, { ok: true, attemptId: 'a1' }, env(states))).toBe('closing');
    expect(handleCloseWindowSave(w.win, { ok: true, attemptId: 'a1' }, env(states))).toBe('kept-open');
    expect(w.win.close).toHaveBeenCalledTimes(1);
  });

  it('a newer attempt invalidates the older one; a stale id or a missing id never closes', () => {
    const states = new Map([[1, state({ documentEdited: false })]]);
    const { win } = fakeWindow();
    handleCloseWindowSaveStarted(win, { attemptId: 'old' }, env(states));
    handleCloseWindowSaveStarted(win, { attemptId: 'new' }, env(states));
    expect(handleCloseWindowSave(win, { ok: true, attemptId: 'old' }, env(states))).toBe('kept-open');
    expect(handleCloseWindowSave(win, { ok: true }, env(states))).toBe('kept-open');
    expect(win.close).not.toHaveBeenCalled();
    expect(handleCloseWindowSave(win, { ok: true, attemptId: 'new' }, env(states))).toBe('closing');
  });

  it('discard invalidates an attempt in flight, and an attempt that never reports back expires', () => {
    const states = new Map([[1, state({ documentEdited: false })]]);
    const a = fakeWindow();
    handleCloseWindowSaveStarted(a.win, { attemptId: 'a1' }, env(states));
    handleCloseWindowDiscard(a.win, env(states));
    expect(a.win.close).toHaveBeenCalledTimes(1);
    expect(handleCloseWindowSave(a.win, { ok: true, attemptId: 'a1' }, env(states))).toBe('kept-open');
    expect(a.win.close).toHaveBeenCalledTimes(1);

    forgetCloseConfirmation(1);
    let clock = 1_000;
    setAttemptClockForTests(() => clock);
    const b = fakeWindow();
    handleCloseWindowSaveStarted(b.win, { attemptId: 'b1' }, env(states));
    clock += 6 * 60 * 1000;
    expect(handleCloseWindowSave(b.win, { ok: true, attemptId: 'b1' }, env(states))).toBe('kept-open');
    expect(b.win.close).not.toHaveBeenCalled();
  });
});

describe('a report for the current attempt always ends it (blocker, round 3)', () => {
  const env = (states: Map<number, WindowState>) => ({ getWindowId: () => 1, getState: (id: number) => states.get(id) });

  it('save failed: kept open, and the next close request asks again (the X is not dead)', () => {
    const states = new Map([[1, state({ documentEdited: true })]]);
    const w = wire(states);
    w.requestClose();
    expect(w.send).toHaveBeenCalledTimes(1);
    handleCloseWindowSaveStarted(w.win, { attemptId: 'a1' }, env(states));
    expect(handleCloseWindowSave(w.win, { ok: false, attemptId: 'a1', failed: ['b.md'] }, env(states))).toBe('kept-open');
    const next = w.requestClose();
    expect(next.defaultPrevented).toBe(true);
    expect(w.send).toHaveBeenCalledTimes(2);
    expect(w.win.close).not.toHaveBeenCalled();
  });

  it('ok reported but the window is still edited: kept open, and the next close request asks again', () => {
    const states = new Map([[1, state({ documentEdited: true })]]);
    const w = wire(states);
    w.requestClose();
    handleCloseWindowSaveStarted(w.win, { attemptId: 'a1' }, env(states));
    expect(handleCloseWindowSave(w.win, { ok: true, attemptId: 'a1' }, env(states))).toBe('kept-open');
    w.requestClose();
    expect(w.send).toHaveBeenCalledTimes(2);
    expect(w.win.close).not.toHaveBeenCalled();
  });

  it('a stale report does not end the attempt that is actually current', () => {
    const states = new Map([[1, state({ documentEdited: true })]]);
    const w = wire(states);
    w.requestClose();
    handleCloseWindowSaveStarted(w.win, { attemptId: 'new' }, env(states));
    expect(handleCloseWindowSave(w.win, { ok: false, attemptId: 'old' }, env(states))).toBe('kept-open');
    w.requestClose(); // still guarded by 'new': no second dialog
    expect(w.send).toHaveBeenCalledTimes(1);
  });

  it('while an attempt is active, a close is cancelled even if the edited flag reads false', () => {
    const states = new Map([[1, state({ documentEdited: false })]]);
    const w = wire(states);
    handleCloseWindowSaveStarted(w.win, { attemptId: 'a1' }, env(states));
    const event = w.requestClose();
    expect(event.defaultPrevented).toBe(true);
    expect(w.send).not.toHaveBeenCalled();
    expect(w.onProceed).not.toHaveBeenCalled();
    // but quitting is never blocked
    const q = wire(new Map([[1, state()]]), { quitting: true });
    handleCloseWindowSaveStarted(q.win, { attemptId: 'q1' }, env(states));
    expect(q.requestClose().defaultPrevented).toBe(false);
  });

  it('a navigation or a renderer crash ends the attempt', () => {
    const states = new Map([[1, state({ documentEdited: true })]]);
    const w = wire(states);
    handleCloseWindowSaveStarted(w.win, { attemptId: 'a1' }, env(states));
    clearCloseAttempt(1);
    expect(handleCloseWindowSave(w.win, { ok: true, attemptId: 'a1' }, env(states))).toBe('kept-open');
    w.requestClose();
    expect(w.send).toHaveBeenCalledTimes(1);
  });

  it('only a main-frame navigation that replaces the document counts', () => {
    expect(isDocumentReplacingNavigation([{ isMainFrame: true, isSameDocument: false }])).toBe(true);
    expect(isDocumentReplacingNavigation([{ isMainFrame: false, isSameDocument: false }])).toBe(false);
    expect(isDocumentReplacingNavigation([{ isMainFrame: true, isSameDocument: true }])).toBe(false);
    // legacy positional form: (event, url, isInPlace, isMainFrame)
    expect(isDocumentReplacingNavigation([{}, 'file:///x', false, true])).toBe(true);
    expect(isDocumentReplacingNavigation([{}, 'file:///x', true, true])).toBe(false);
    expect(isDocumentReplacingNavigation([{}, 'file:///x', false, false])).toBe(false);
  });
});

describe('a cancel during the attempt returns normal close behaviour at once (blocker, advisor 44ee9298)', () => {
  const env = (states: Map<number, WindowState>) => ({ getWindowId: () => 1, getState: (id: number) => states.get(id) });

  it('cancel with the attempt id clears it: the next close asks again, and the late save result cannot close the window', () => {
    const states = new Map([[1, state({ documentEdited: true })]]);
    const w = wire(states);
    w.requestClose();
    expect(w.send).toHaveBeenCalledTimes(1);
    handleCloseWindowSaveStarted(w.win, { attemptId: 'a1' }, env(states));
    w.requestClose(); // while saving: cancelled, no second dialog
    expect(w.send).toHaveBeenCalledTimes(1);

    handleCloseWindowCancel(w.win, { attemptId: 'a1' }, env(states)); // the user cancels the saving state

    const again = w.requestClose();
    expect(again.defaultPrevented).toBe(true);
    expect(w.send).toHaveBeenCalledTimes(2); // the dialog is asked for again immediately, not after 5 minutes

    states.get(1)!.documentEdited = false;
    expect(handleCloseWindowSave(w.win, { ok: true, attemptId: 'a1' }, env(states))).toBe('kept-open');
    expect(w.win.close).not.toHaveBeenCalled();
  });

  it('a cancel for an older attempt does not clear a newer one; a cancel without an id clears whatever is in flight', () => {
    const states = new Map([[1, state({ documentEdited: true })]]);
    const w = wire(states);
    handleCloseWindowSaveStarted(w.win, { attemptId: 'new' }, env(states));
    handleCloseWindowCancel(w.win, { attemptId: 'old' }, env(states));
    w.requestClose();
    expect(w.send).not.toHaveBeenCalled(); // 'new' is still guarding the window

    handleCloseWindowCancel(w.win, undefined, env(states));
    w.requestClose();
    expect(w.send).toHaveBeenCalledTimes(1);
  });
});

describe('will-prevent-unload (N3)', () => {
  const ev = () => ({ preventDefault: vi.fn() });

  it('asks natively, defaulting to Stay; Reload allows the unload, Stay/Esc/error keep the page', () => {
    const prompt = vi.fn().mockReturnValue(1);
    const stay = ev();
    expect(handleWillPreventUnload(stay, { windowId: 1, isQuitting: () => false, prompt })).toBe('stay');
    expect(stay.preventDefault).not.toHaveBeenCalled();
    const opts = prompt.mock.calls[0][0];
    expect(opts.buttons).toEqual(['Leave', 'Stay']);
    // Electron does not say whether the unload is a reload or a close, so the wording is neutral
    expect(opts.message).not.toMatch(/reload/i);
    expect(opts.defaultId).toBe(1);
    expect(opts.cancelId).toBe(1);

    const reload = ev();
    expect(handleWillPreventUnload(reload, { windowId: 1, isQuitting: () => false, prompt: () => 0 })).toBe('allow');
    expect(reload.preventDefault).toHaveBeenCalledTimes(1);

    const broken = ev();
    expect(handleWillPreventUnload(broken, { windowId: 1, isQuitting: () => false, prompt: () => { throw new Error('x'); } })).toBe('stay');
    expect(broken.preventDefault).not.toHaveBeenCalled();
  });

  it('never blocks quitting, and does not ask again after the user already decided to close', () => {
    const prompt = vi.fn();
    const quit = ev();
    expect(handleWillPreventUnload(quit, { windowId: 1, isQuitting: () => true, prompt })).toBe('allow');
    expect(quit.preventDefault).toHaveBeenCalled();

    const states = new Map([[1, state({ documentEdited: true })]]);
    const { win } = fakeWindow();
    handleCloseWindowDiscard(win, { getWindowId: () => 1, getState: (id) => states.get(id) });
    const decided = ev();
    expect(handleWillPreventUnload(decided, { windowId: 1, isQuitting: () => false, prompt })).toBe('allow');
    expect(prompt).not.toHaveBeenCalled();
  });

  it('forgetCloseConfirmation (called on the closed event) clears the decision, so a later unload asks again', () => {
    const states = new Map([[1, state({ documentEdited: true })]]);
    const { win } = fakeWindow();
    handleCloseWindowDiscard(win, { getWindowId: () => 1, getState: (id) => states.get(id) });
    const prompt = vi.fn().mockReturnValue(1);
    expect(handleWillPreventUnload({ preventDefault: vi.fn() }, { windowId: 1, isQuitting: () => false, prompt })).toBe('allow');
    expect(prompt).not.toHaveBeenCalled();

    forgetCloseConfirmation(1);
    expect(handleWillPreventUnload({ preventDefault: vi.fn() }, { windowId: 1, isQuitting: () => false, prompt })).toBe('stay');
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('is localised in pt-BR', async () => {
    await setLanguage('pt-BR');
    const o = buildUnloadPrompt();
    expect(o.message).toBe('Há alterações não salvas. Sair desta página e perder as alterações?');
    expect(o.buttons).toEqual(['Sair', 'Ficar']);
    expect(o.message).not.toMatch(/recarregar/i);
  });
});
