import { afterEach, describe, expect, it, vi } from 'vitest';
import { store, editorDirtyAtom, makeEditorKey } from '@nimbalyst/runtime/store';
import { createDocumentEditedSync, type TabsActionsLike } from '../documentEditedSync';

const A = '/ws/a.md';
const B = '/ws/b.md';

function fakeTabs(paths: string[]) {
  let listeners: Array<() => void> = [];
  const tabs = new Map(paths.map((p, i) => [`t${i}`, { filePath: p }]));
  const actions: TabsActionsLike & { add(path: string): void } = {
    getSnapshot: () => ({ tabOrder: [...tabs.keys()], tabs }),
    subscribe: (fn) => { listeners.push(fn); return () => { listeners = listeners.filter((l) => l !== fn); }; },
    add(path) { tabs.set(`t${tabs.size}`, { filePath: path }); listeners.forEach((l) => l()); },
  };
  return actions;
}

afterEach(() => {
  store.set(editorDirtyAtom(makeEditorKey(A)), false);
  store.set(editorDirtyAtom(makeEditorKey(B)), false);
});

describe('document edited sync (N2)', () => {
  it('reports a dirty change immediately, without waiting for the 500 ms backstop', () => {
    const report = vi.fn();
    const actions = fakeTabs([A]);
    const sync = createDocumentEditedSync({ getTabsActions: () => actions, store, report });
    sync.sync();
    expect(report).toHaveBeenLastCalledWith(false);
    report.mockClear();

    store.set(editorDirtyAtom(makeEditorKey(A)), true);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenLastCalledWith(true);

    store.set(editorDirtyAtom(makeEditorKey(A)), false);
    expect(report).toHaveBeenLastCalledWith(false);
    sync.dispose();
  });

  it('re-asserts the state on every dirty change (the main process clears its flag on any save), and the backstop always reports', () => {
    const report = vi.fn();
    const actions = fakeTabs([A, B]);
    const sync = createDocumentEditedSync({ getTabsActions: () => actions, store, report });
    sync.sync();
    store.set(editorDirtyAtom(makeEditorKey(A)), true);
    store.set(editorDirtyAtom(makeEditorKey(B)), true); // still edited: reported again
    expect(report.mock.calls.filter((c) => c[0] === true)).toHaveLength(2);
    // tab A is saved (its flag clears) while B is still dirty: the window is still edited and says so
    report.mockClear();
    store.set(editorDirtyAtom(makeEditorKey(A)), false);
    expect(report).toHaveBeenLastCalledWith(true);
    report.mockClear();
    sync.sync();
    expect(report).toHaveBeenCalledWith(true);
    sync.dispose();
  });

  it('picks up tabs opened later, and a tab that is closed no longer counts', () => {
    const report = vi.fn();
    const actions = fakeTabs([A]);
    const sync = createDocumentEditedSync({ getTabsActions: () => actions, store, report });
    sync.sync();
    actions.add(B);
    report.mockClear();
    store.set(editorDirtyAtom(makeEditorKey(B)), true);
    expect(report).toHaveBeenLastCalledWith(true);
    sync.dispose();
  });

  it('attaches when the tabs actions appear after the first sync, and stops after dispose', () => {
    const report = vi.fn();
    let actions: TabsActionsLike | null = null;
    const sync = createDocumentEditedSync({ getTabsActions: () => actions, store, report });
    sync.sync();
    expect(report).toHaveBeenLastCalledWith(false);
    actions = fakeTabs([A]);
    sync.sync(); // the backstop re-attaches
    report.mockClear();
    store.set(editorDirtyAtom(makeEditorKey(A)), true);
    expect(report).toHaveBeenLastCalledWith(true);
    sync.dispose();
    report.mockClear();
    store.set(editorDirtyAtom(makeEditorKey(A)), false);
    expect(report).not.toHaveBeenCalled();
  });
});
