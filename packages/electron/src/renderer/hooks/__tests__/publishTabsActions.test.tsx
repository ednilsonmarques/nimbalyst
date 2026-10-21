// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import * as fs from 'fs';
import * as path from 'path';
import { store, editorDirtyAtom, makeEditorKey } from '@nimbalyst/runtime/store';
import { publishTabsActions, usePublishTabsActions } from '../publishTabsActions';
import { useWindowLifecycle } from '../useWindowLifecycle';

const FILE = '/ws/notes.md';

function fakeTabs(filePath: string) {
  const tab = { id: 't1', filePath };
  return {
    getSnapshot: () => ({ tabOrder: ['t1'], tabs: new Map([['t1', tab]]), activeTabId: 't1' }),
    updateTab: vi.fn(),
  };
}

function fireBeforeUnload(): BeforeUnloadEvent {
  const e = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
  window.dispatchEvent(e);
  return e;
}

describe('window lifecycle sees the real tabs (NIB.97)', () => {
  afterEach(() => {
    store.set(editorDirtyAtom(makeEditorKey(FILE)), false);
    delete (window as any).electronAPI;
  });

  it('publishes the actions and clears only its own on cleanup', () => {
    const ref: { current: any } = { current: null };
    const a = fakeTabs(FILE);
    const cleanup = publishTabsActions(ref, a);
    expect(ref.current).toBe(a);
    const b = fakeTabs(FILE);
    ref.current = b; // someone else took over
    cleanup();
    expect(ref.current).toBe(b);
    ref.current = null;
    publishTabsActions(ref, a)();
    expect(ref.current).toBe(null);
    expect(() => publishTabsActions(undefined, a)()).not.toThrow();
  });

  it('a dirty tab blocks unload and the fallback save runs once the actions are published', () => {
    const saveFile = vi.fn().mockResolvedValue({ success: true });
    (window as any).electronAPI = { saveFile };
    store.set(editorDirtyAtom(makeEditorKey(FILE)), true);
    const tabsRef: { current: any } = { current: null };
    const getContentRef = { current: () => 'edited text' };
    const currentFilePathRef = { current: FILE as string | null };

    renderHook(() => useWindowLifecycle({ tabsRef, getContentRef, currentFilePathRef } as any));

    // Today's App wiring: nothing assigns the ref, so the hook sees no tabs and lets the unload through.
    const before = fireBeforeUnload();
    expect(before.defaultPrevented).toBe(false);
    expect(saveFile).not.toHaveBeenCalled();

    // With EditorMode publishing its actions the hook sees the dirty tab.
    const cleanup = publishTabsActions(tabsRef, fakeTabs(FILE));
    const after = fireBeforeUnload();
    expect(after.defaultPrevented).toBe(true);
    expect(saveFile).toHaveBeenCalledWith('edited text', FILE);
    cleanup();
  });

  it('a clean tab does not block unload', () => {
    const tabsRef: { current: any } = { current: null };
    renderHook(() => useWindowLifecycle({ tabsRef, getContentRef: { current: () => '' }, currentFilePathRef: { current: FILE } } as any));
    publishTabsActions(tabsRef, fakeTabs(FILE));
    expect(fireBeforeUnload().defaultPrevented).toBe(false);
  });

  it('usePublishTabsActions publishes while mounted, follows a new actions object and clears on unmount', () => {
    const ref: { current: any } = { current: null };
    const first = fakeTabs(FILE);
    const second = fakeTabs(FILE);
    const { rerender, unmount } = renderHook(({ actions }) => usePublishTabsActions(ref, actions), { initialProps: { actions: first } });
    expect(ref.current).toBe(first);
    rerender({ actions: second });
    expect(ref.current).toBe(second);
    unmount();
    expect(ref.current).toBe(null);
  });

  it('end to end: EditorMode-style publisher + the real lifecycle hook block a dirty unload, and stop after unmount', () => {
    store.set(editorDirtyAtom(makeEditorKey(FILE)), true);
    (window as any).electronAPI = { saveFile: vi.fn().mockResolvedValue({ success: true }) };
    const tabsRef: { current: any } = { current: null };
    const actions = fakeTabs(FILE);
    const publisher = renderHook(() => usePublishTabsActions(tabsRef, actions));
    renderHook(() => useWindowLifecycle({ tabsRef, getContentRef: { current: () => 'x' }, currentFilePathRef: { current: FILE } } as any));
    expect(fireBeforeUnload().defaultPrevented).toBe(true);
    publisher.unmount();
    expect(fireBeforeUnload().defaultPrevented).toBe(false);
  });

  it('App passes its tabsRef to EditorMode (source check: App is too large to render in a unit test)', () => {
    const app = fs.readFileSync(path.resolve(__dirname, '../../App.tsx'), 'utf8');
    const element = app.slice(app.indexOf('<EditorMode\n') >= 0 ? app.indexOf('<EditorMode\n') : app.indexOf('<EditorMode\r\n'));
    expect(element.slice(0, element.indexOf('/>'))).toContain('tabsRef={tabsRef}');
  });
});
