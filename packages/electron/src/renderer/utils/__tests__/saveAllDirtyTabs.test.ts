import { describe, expect, it, vi } from 'vitest';
import { store, editorDirtyAtom, makeEditorKey } from '@nimbalyst/runtime/store';
import { createDocumentEditedSync } from '../../hooks/documentEditedSync';
import { saveAllDirtyTabs, type SaveAllDeps, type SaveAllTab } from '../saveAllDirtyTabs';

function setup(tabs: SaveAllTab[], dirty: Set<string>, opts: { collab?: Set<string>; save?: (id: string) => Promise<void> } & Partial<SaveAllDeps> = {}) {
  let clock = 0;
  const saved: string[] = [];
  const { collab, save, ...rest } = opts;
  const deps: SaveAllDeps = {
    listTabs: () => tabs,
    isDirty: (p: string) => dirty.has(p),
    isCollabUnsynced: (p: string) => !!collab?.has(p),
    saveTabById: vi.fn(async (id: string) => {
      saved.push(id);
      if (save) return save(id);
      const tab = tabs.find((t) => t.id === id)!;
      dirty.delete(tab.filePath as string); // a successful save clears the flag
    }),
    settleTimeoutMs: 200,
    pollMs: 50,
    sleep: async (ms: number) => { clock += ms; },
    now: () => clock,
    ...rest,
  };
  return { deps, saved };
}

const TABS: SaveAllTab[] = [
  { id: 't1', filePath: '/ws/a.md', fileName: 'a.md' },
  { id: 't2', filePath: '/ws/b.md', fileName: 'b.md' },
  { id: 't3', filePath: '/ws/c.md', fileName: 'c.md' },
];

describe('saveAllDirtyTabs (B2)', () => {
  it('saves every dirty tab, not only the active one, and skips clean tabs', async () => {
    const { deps, saved } = setup(TABS, new Set(['/ws/a.md', '/ws/c.md']));
    const result = await saveAllDirtyTabs(deps);
    expect(saved).toEqual(['t1', 't3']);
    expect(result).toEqual({ ok: true, failed: [], timedOut: [], maxCheckCostMs: expect.any(Number) });
  });

  it('is ok with nothing dirty', async () => {
    const { deps, saved } = setup(TABS, new Set());
    expect(await saveAllDirtyTabs(deps)).toEqual({ ok: true, failed: [], timedOut: [], maxCheckCostMs: expect.any(Number) });
    expect(saved).toEqual([]);
  });

  it('reports failure when a save throws, and still tries the other tabs', async () => {
    const dirty = new Set(['/ws/a.md', '/ws/b.md']);
    const { deps, saved } = setup(TABS, dirty, {
      save: async (id) => {
        if (id === 't1') throw new Error('disk full');
        dirty.delete('/ws/b.md');
      },
    });
    const result = await saveAllDirtyTabs(deps);
    expect(saved).toEqual(['t1', 't2']);
    expect(result).toEqual({ ok: false, failed: ['a.md'], timedOut: [], maxCheckCostMs: expect.any(Number) });
  });

  it('reports failure when a save resolves but the tab stays dirty (held or refused saves)', async () => {
    const dirty = new Set(['/ws/a.md', '/ws/b.md']);
    const { deps } = setup(TABS, dirty, {
      save: async (id) => { if (id === 't2') dirty.delete('/ws/b.md'); }, // t1 "held": flag never clears
    });
    const result = await saveAllDirtyTabs(deps);
    expect(result).toEqual({ ok: false, failed: ['a.md'], timedOut: [], maxCheckCostMs: expect.any(Number) });
  });

  it('waits for a flag that clears shortly after the save resolves', async () => {
    const dirty = new Set(['/ws/a.md']);
    let clock = 0;
    let polls = 0;
    const result = await saveAllDirtyTabs({
      listTabs: () => TABS,
      isDirty: (p) => dirty.has(p),
      isCollabUnsynced: () => false,
      saveTabById: async () => undefined,
      settleTimeoutMs: 1000,
      pollMs: 50,
      sleep: async (ms) => { clock += ms; if (++polls === 3) dirty.clear(); },
      now: () => clock,
    });
    expect(result.ok).toBe(true);
  });

  it('counts collab tabs with unconfirmed changes as failed without trying to save them', async () => {
    const { deps, saved } = setup(TABS, new Set(['/ws/a.md']), { collab: new Set(['/ws/b.md']) });
    const result = await saveAllDirtyTabs(deps);
    expect(saved).toEqual(['t1']);
    expect(result).toEqual({ ok: false, failed: ['b.md'], timedOut: [], maxCheckCostMs: expect.any(Number) });
  });
});

describe('a save that never resolves (A3)', () => {
  it('fails safe after the per-tab bound and names the file; the other tabs are still saved', async () => {
    vi.useFakeTimers();
    try {
      const dirty = new Set(['/ws/a.md', '/ws/b.md']);
      const { deps, saved } = setup(TABS, dirty, {
        perTabTimeoutMs: 15_000,
        save: (id) => {
          if (id === 't1') return new Promise<void>(() => { /* never resolves */ });
          dirty.delete('/ws/b.md');
          return Promise.resolve();
        },
      });
      const run = saveAllDirtyTabs(deps);
      await vi.advanceTimersByTimeAsync(15_001);
      const result = await run;
      expect(saved).toEqual(['t1', 't2']);
      expect(result).toEqual({ ok: false, failed: ['a.md'], timedOut: ['a.md'], maxCheckCostMs: expect.any(Number) });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not time out a save that finishes in time', async () => {
    vi.useFakeTimers();
    try {
      const dirty = new Set(['/ws/a.md']);
      const { deps } = setup(TABS, dirty, {
        perTabTimeoutMs: 15_000,
        save: () => new Promise<void>((resolve) => setTimeout(() => { dirty.clear(); resolve(); }, 10_000)),
      });
      const run = saveAllDirtyTabs(deps);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await run).toEqual({ ok: true, failed: [], timedOut: [], maxCheckCostMs: expect.any(Number) });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the saved revision is the current one (A4)', () => {
  const content = (map: Record<string, string>) => (id: string) => map[id];
  const persisted = (map: Record<string, string>) => (filePath: string) => map[filePath];

  it('text typed while the write was in flight: the flag cleared but the revision differs, so it is saved again', async () => {
    const dirty = new Set(['/ws/a.md']);
    const current: Record<string, string> = { t1: 'v1' };
    const onDisk: Record<string, string> = { '/ws/a.md': 'v0' };
    let writes = 0;
    const { deps, saved } = setup(TABS, dirty, {
      getContent: content(current),
      getPersistedContent: persisted(onDisk),
      save: async () => {
        writes++;
        const written = current.t1;
        if (writes === 1) current.t1 = 'v2'; // the user keeps typing while this write is in flight
        onDisk['/ws/a.md'] = written;
        dirty.delete('/ws/a.md'); // TabEditor clears the flag after the write regardless of newer typing
      },
    });
    const result = await saveAllDirtyTabs(deps);
    expect(saved).toEqual(['t1', 't1']);
    expect(onDisk['/ws/a.md']).toBe('v2');
    expect(result.ok).toBe(true);
  });

  it('fails when the persisted revision never catches up with the buffer', async () => {
    const dirty = new Set(['/ws/a.md']);
    const { deps, saved } = setup(TABS, dirty, {
      getContent: content({ t1: 'newer' }),
      getPersistedContent: persisted({ '/ws/a.md': 'older' }),
      maxResaves: 1,
      save: async () => { dirty.clear(); },
    });
    const result = await saveAllDirtyTabs(deps);
    expect(saved).toEqual(['t1', 't1']);
    expect(result).toEqual({ ok: false, failed: ['a.md'], timedOut: [], maxCheckCostMs: expect.any(Number) });
  });

  it('when the content cannot be read as text, the dirty flag is all there is', async () => {
    const dirty = new Set(['/ws/a.md']);
    const { deps, saved } = setup(TABS, dirty, {
      getContent: () => null,
      getPersistedContent: () => null,
    });
    expect(await saveAllDirtyTabs(deps)).toEqual({ ok: true, failed: [], timedOut: [], maxCheckCostMs: expect.any(Number) });
    expect(saved).toEqual(['t1']);
  });
});

describe('the revision check backs off with its own cost (large documents)', () => {
  it('sleeps at least 4x the measured cost of one check between polls', async () => {
    let clock = 0;
    const dirty = new Set<string>(['/ws/a.md']);
    const sleeps: number[] = [];
    const result = await saveAllDirtyTabs({
      listTabs: () => [{ id: 't1', filePath: '/ws/a.md', fileName: 'a.md' }],
      isDirty: (p) => dirty.has(p),
      isCollabUnsynced: () => false,
      saveTabById: async () => { dirty.clear(); },
      // serializing a big document costs 100 ms of the (fake) clock per call, and never matches
      getContent: () => { clock += 100; return 'newer'; },
      getPersistedContent: () => 'older',
      settleTimeoutMs: 1500,
      maxResaves: 0,
      pollMs: 50,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
      now: () => clock,
    });
    expect(result.ok).toBe(false);
    expect(sleeps.length).toBeGreaterThan(0);
    expect(Math.min(...sleeps)).toBeGreaterThanOrEqual(400);
    // far fewer reads than the 30 a fixed 50 ms poll would do in 1.5 s
    expect(sleeps.length).toBeLessThan(8);
  });
});

describe('a failed revision check restores the blocking state (blocker, advisor 44ee9298)', () => {
  it('marks the tab dirty again when the save cleared the flag but the persisted revision never matched', async () => {
    const dirty = new Set(['/ws/a.md']);
    const markDirty = vi.fn((filePath: string) => { dirty.add(filePath); });
    const { deps } = setup(TABS, dirty, {
      getContent: () => 'newer',
      getPersistedContent: () => 'older',
      maxResaves: 0,
      markDirty,
      save: async () => { dirty.clear(); }, // TabEditor clears the flag after the write
    });
    const result = await saveAllDirtyTabs(deps);
    expect(result.ok).toBe(false);
    expect(markDirty).toHaveBeenCalledWith('/ws/a.md');
    expect(dirty.has('/ws/a.md')).toBe(true);
  });

  it('leaves tabs that are still dirty, saved tabs and tabs it never tried alone', async () => {
    const dirty = new Set(['/ws/a.md', '/ws/b.md']);
    const markDirty = vi.fn();
    const { deps } = setup(TABS, dirty, {
      markDirty,
      maxResaves: 0,
      save: async (id) => { if (id === 't2') dirty.delete('/ws/b.md'); }, // t1 held: still dirty; t2 saved
    });
    await saveAllDirtyTabs(deps);
    expect(markDirty).not.toHaveBeenCalled();
  });

  it('close requested again with no edit in between: the window still reports unsaved changes, so it prompts', async () => {
    const A = '/ws/a.md';
    const tabs = new Map([['t1', { filePath: A }]]);
    const actions = {
      getSnapshot: () => ({ tabOrder: ['t1'], tabs }),
      subscribe: () => () => undefined,
    };
    store.set(editorDirtyAtom(makeEditorKey(A)), true);
    let mainEdited = false; // what the main process uses to decide whether to prompt on close
    const sync = createDocumentEditedSync({ getTabsActions: () => actions as never, store, report: (v) => { mainEdited = v; } });
    sync.sync();
    expect(mainEdited).toBe(true);

    const result = await saveAllDirtyTabs({
      listTabs: () => [{ id: 't1', filePath: A, fileName: 'a.md' }],
      isDirty: (p) => !!store.get(editorDirtyAtom(makeEditorKey(p))),
      isCollabUnsynced: () => false,
      saveTabById: async () => { store.set(editorDirtyAtom(makeEditorKey(A)), false); }, // flag clears, content is not what was persisted
      getContent: () => 'typed text',
      getPersistedContent: () => 'old text',
      markDirty: (p) => store.set(editorDirtyAtom(makeEditorKey(p)), true),
      maxResaves: 0,
      settleTimeoutMs: 100,
      pollMs: 10,
      sleep: async () => undefined,
      now: (() => { let t = 0; return () => (t += 50); })(),
    });
    expect(result.ok).toBe(false);
    // the error is dismissed and the user presses X again, with no edit in between:
    expect(store.get(editorDirtyAtom(makeEditorKey(A)))).toBe(true);
    expect(mainEdited).toBe(true);
    sync.dispose();
    store.set(editorDirtyAtom(makeEditorKey(A)), false);
  });
});
