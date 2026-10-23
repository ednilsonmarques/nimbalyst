// @vitest-environment node
/**
 * Portal F0 -- ownership and screenshot confinement enforced at the IPC
 * boundary in main. The real handlers and the real BrowserSessionService run
 * against a fake Electron; the "agent" is whoever sends `actorSessionId`
 * (the AI session id main hands to the tool path), the user's UI sends none.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, roots, worktrees } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: any) => Promise<any>>(),
  roots: [] as string[],
  worktrees: new Map<string, { projectPath: string }>(),
}));

vi.mock('electron', async () => (await import('../../services/__tests__/helpers/fakeElectronBrowser')).createElectronMock());
vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } },
}));
vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: (channel: string, fn: (event: unknown, payload: any) => Promise<any>) => {
    handlers.set(channel, fn);
  },
}));
vi.mock('../../protocols/nimPreviewProtocol', async () => {
  const pathMod = await import('path');
  const ci = process.platform === 'win32';
  const norm = (s: string) => (ci ? s.toLowerCase() : s);
  return {
    ensureNimPreviewProtocolForSession: vi.fn(),
    getNimPreviewWorkspaceRoots: () => [...roots],
    encodeNimPreviewUrl: (root: string, rel: string) => `nim-preview://${Buffer.from(root).toString('hex')}/${rel}`,
    previewPathsEqual: (a: string, b: string) => norm(a) === norm(b),
    previewPathInsideRoot: (root: string, candidate: string) =>
      norm(candidate) === norm(root) || norm(candidate).startsWith(norm(root + pathMod.sep)),
  };
});
vi.mock('../../database/initialize', () => ({ getDatabase: () => ({}) }));
// These tests are about identity and ownership; the test-data mark (click/type/evaluate
// for an agent actor) has its own suite, BrowserSessionHandlers.testDataMark.test.ts.
vi.mock('../../services/portalTestData', () => ({ assertAgentMayExercise: async () => undefined, assertAgentMayExerciseOn: async () => undefined }));
vi.mock('../../services/WorktreeStore', () => ({
  createWorktreeStore: () => ({ getByPath: async (p: string) => worktrees.get(p) ?? null }),
}));

import { BrowserSessionService } from '../../services/BrowserSessionService';
import { fakeState } from '../../services/__tests__/helpers/fakeElectronBrowser';
import { registerBrowserSessionHandlers } from '../BrowserSessionHandlers';
import { issueActorToken } from '../../services/BrowserAuthority';

const A = 'ai-session-A';
const B = 'ai-session-B';
const EDITOR_ID = 'browser:doc.html:1111';
const AGENT_ID = 'agent-browser:a1';

// F1.1: an agent is whoever holds a main-issued token. These F0 cases still name
// their agents A/B; the shim mints a token for each name, as main would per call.
// (Bare ids and forged tokens are covered in BrowserSessionHandlers.authority.test.ts.)
function call(channel: string, payload: Record<string, unknown>): Promise<any> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  const actor = payload.actorSessionId;
  const withToken =
    typeof actor === 'string' && actor.length > 0 ? { ...payload, actorSessionId: issueActorToken(actor) } : payload;
  return handler({ sender: {} }, withToken);
}

async function openAs(actor: string | undefined, sessionId: string, extra: Record<string, unknown> = {}) {
  return call('browser-session:create', {
    sessionId,
    url: 'https://example.com',
    headless: actor !== undefined,
    actorSessionId: actor,
    ...extra,
  });
}

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-f0-'));
});
afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  BrowserSessionService.__resetForTests();
  fakeState.reset();
  handlers.clear();
  roots.length = 0;
  worktrees.clear();
  registerBrowserSessionHandlers();
});

// Every channel that takes a session id, with a payload that would succeed for the owner.
const SESSION_CHANNELS: Array<[string, Record<string, unknown>]> = [
  ['browser-session:navigate', { url: 'https://example.org' }],
  ['browser-session:reload', {}],
  ['browser-session:go-back', {}],
  ['browser-session:go-forward', {}],
  ['browser-session:screenshot', {}],
  ['browser-session:get-state', {}],
  ['browser-session:evaluate', { script: 'document.title' }],
  ['browser-session:get-page-info', {}],
  ['browser-session:click', { selector: '#go' }],
  ['browser-session:type', { selector: '#q', text: 'x' }],
  ['browser-session:scroll', { dy: 100 }],
  ['browser-session:set-bounds', { bounds: { x: 0, y: 0, width: 10, height: 10 } }],
  ['browser-session:detach', {}],
  ['browser-session:destroy', {}],
];

describe("agent B against agent A's session", () => {
  it.each(SESSION_CHANNELS)('%s is refused and has no effect', async (channel, extra) => {
    await openAs(A, AGENT_ID);
    const view = fakeState.views[0];
    const loadsBefore = view.webContents.loaded.length;

    const res = await call(channel, { sessionId: AGENT_ID, actorSessionId: B, ...extra });

    if (channel === 'browser-session:get-state') {
      expect(res.state ?? null).toBeNull();
    } else {
      expect(res.success).toBe(false);
    }
    expect(view.webContents.loaded.length).toBe(loadsBefore);
    expect(view.webContents.scripts).toEqual([]);
    expect(view.webContents.inputs).toEqual([]);
    expect(view.webContents.reloads).toBe(0);
    expect(view.webContents.closed).toBe(false);
    expect(BrowserSessionService.getInstance().hasSession(AGENT_ID)).toBe(true);
  });

  it('attach is refused', async () => {
    await openAs(A, AGENT_ID);
    const res = await call('browser-session:attach', {
      sessionId: AGENT_ID,
      actorSessionId: B,
      bounds: { x: 0, y: 0, width: 10, height: 10 },
    });
    expect(res.success).toBe(false);
  });

  it('cannot list it', async () => {
    await openAs(A, AGENT_ID);
    const res = await call('browser-session:list-sessions', { actorSessionId: B });
    expect(res.sessionIds).toEqual([]);
  });

  it('cannot screenshot it to a file', async () => {
    roots.push(tmpRoot);
    await openAs(A, AGENT_ID);
    const res = await call('browser-session:screenshot-to-file', {
      sessionId: AGENT_ID,
      actorSessionId: B,
      workspacePath: tmpRoot,
    });
    expect(res.success).toBe(false);
    expect(fs.existsSync(path.join(tmpRoot, '.nimbalyst'))).toBe(false);
  });

  it('cannot adopt the id by re-opening it', async () => {
    await openAs(A, AGENT_ID);
    const res = await openAs(B, AGENT_ID);
    expect(res.success).toBe(false);
    expect(BrowserSessionService.getInstance().getOwner(AGENT_ID)).toBe(A);
  });
});

describe("an agent against the user's editor session", () => {
  beforeEach(async () => {
    await openAs(undefined, EDITOR_ID, { url: 'about:blank' });
  });

  it.each(SESSION_CHANNELS)('%s is refused and has no effect', async (channel, extra) => {
    const view = fakeState.views[0];
    const res = await call(channel, { sessionId: EDITOR_ID, actorSessionId: A, ...extra });
    if (channel === 'browser-session:get-state') {
      expect(res.state ?? null).toBeNull();
    } else {
      expect(res.success).toBe(false);
    }
    expect(view.webContents.scripts).toEqual([]);
    expect(view.webContents.inputs).toEqual([]);
    expect(view.webContents.closed).toBe(false);
    expect(BrowserSessionService.getInstance().hasSession(EDITOR_ID)).toBe(true);
  });

  it('does not appear in the agent listing', async () => {
    await openAs(A, AGENT_ID);
    const res = await call('browser-session:list-sessions', { actorSessionId: A });
    expect(res.sessionIds).toEqual([AGENT_ID]);
  });

  it('cannot be taken over by creating the same id', async () => {
    const res = await openAs(A, EDITOR_ID, { url: 'about:blank', headless: false });
    expect(res.success).toBe(false);
  });

  it('an agent cannot create outside the agent id namespace', async () => {
    const res = await openAs(A, 'browser-virtual:future-tab');
    expect(res.success).toBe(false);
    expect(BrowserSessionService.getInstance().hasSession('browser-virtual:future-tab')).toBe(false);
  });
});

describe('the owner and the user', () => {
  it('the owning agent can list, drive and close its own session', async () => {
    const created = await openAs(A, AGENT_ID);
    expect(created.success).toBe(true);
    expect((await call('browser-session:list-sessions', { actorSessionId: A })).sessionIds).toEqual([AGENT_ID]);
    expect((await call('browser-session:navigate', { sessionId: AGENT_ID, actorSessionId: A, url: 'https://example.org' })).success).toBe(true);
    expect((await call('browser-session:click', { sessionId: AGENT_ID, actorSessionId: A, selector: '#go' })).success).toBe(true);
    expect((await call('browser-session:evaluate', { sessionId: AGENT_ID, actorSessionId: A, script: '1' })).success).toBe(true);
    expect((await call('browser-session:destroy', { sessionId: AGENT_ID, actorSessionId: A })).success).toBe(true);
    expect(BrowserSessionService.getInstance().hasSession(AGENT_ID)).toBe(false);
  });

  it("the user's UI (no actor) keeps full control, including over an agent's session", async () => {
    await openAs(undefined, EDITOR_ID, { url: 'about:blank' });
    await openAs(A, AGENT_ID);
    const listing = await call('browser-session:list-sessions', {});
    expect([...listing.sessionIds].sort()).toEqual([AGENT_ID, EDITOR_ID].sort());
    expect((await call('browser-session:navigate', { sessionId: EDITOR_ID, url: 'https://example.org' })).success).toBe(true);
    expect((await call('browser-session:reload', { sessionId: AGENT_ID })).success).toBe(true);
    expect((await call('browser-session:destroy', { sessionId: AGENT_ID })).success).toBe(true);
    expect((await call('browser-session:destroy', { sessionId: EDITOR_ID })).success).toBe(true);
  });

  it('treats an empty or non-string actor from the tool path as an agent, never as the user', async () => {
    await openAs(undefined, EDITOR_ID, { url: 'about:blank' });
    // Absent/null mean the user's UI; an explicit empty or garbage actor must not be a bypass.
    for (const actor of ['', 0, false, {}, []] as unknown[]) {
      const res = await call('browser-session:destroy', { sessionId: EDITOR_ID, actorSessionId: actor });
      expect(res.success, JSON.stringify(actor)).toBe(false);
    }
    expect(BrowserSessionService.getInstance().hasSession(EDITOR_ID)).toBe(true);
  });
});

describe('screenshot-to-file is confined to a registered workspace', () => {
  function freshDir(name: string): string {
    const dir = path.join(tmpRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  it('rejects a workspacePath that is not a registered workspace and writes nothing', async () => {
    const registered = freshDir('registered');
    const outsider = freshDir('outsider');
    roots.push(registered);
    await openAs(A, AGENT_ID);

    const res = await call('browser-session:screenshot-to-file', {
      sessionId: AGENT_ID,
      actorSessionId: A,
      workspacePath: outsider,
    });

    expect(res.success).toBe(false);
    expect(fs.existsSync(path.join(outsider, '.nimbalyst'))).toBe(false);
  });

  it('rejects when no workspace is registered at all', async () => {
    const outsider = freshDir('nowhere');
    await openAs(A, AGENT_ID);
    const res = await call('browser-session:screenshot-to-file', {
      sessionId: AGENT_ID, actorSessionId: A, workspacePath: outsider,
    });
    expect(res.success).toBe(false);
    expect(fs.existsSync(path.join(outsider, '.nimbalyst'))).toBe(false);
  });

  it('rejects a path that only shares a prefix with a registered root', async () => {
    const registered = freshDir('proj');
    const sibling = freshDir('proj-evil');
    roots.push(registered);
    await openAs(A, AGENT_ID);
    const res = await call('browser-session:screenshot-to-file', {
      sessionId: AGENT_ID, actorSessionId: A, workspacePath: sibling,
    });
    expect(res.success).toBe(false);
    expect(fs.existsSync(path.join(sibling, '.nimbalyst'))).toBe(false);
  });

  it('rejects a ".." path that climbs out of the registered root', async () => {
    const registered = freshDir('proj2');
    const outsider = freshDir('outsider2');
    roots.push(registered);
    await openAs(A, AGENT_ID);
    const res = await call('browser-session:screenshot-to-file', {
      sessionId: AGENT_ID, actorSessionId: A, workspacePath: path.join(registered, '..', 'outsider2'),
    });
    expect(res.success).toBe(false);
    expect(fs.existsSync(path.join(outsider, '.nimbalyst'))).toBe(false);
  });

  it('rejects a relative workspacePath', async () => {
    roots.push(freshDir('proj3'));
    await openAs(A, AGENT_ID);
    const res = await call('browser-session:screenshot-to-file', {
      sessionId: AGENT_ID, actorSessionId: A, workspacePath: 'proj3',
    });
    expect(res.success).toBe(false);
  });

  it('writes inside a registered workspace, under .nimbalyst/transcript-images', async () => {
    const registered = freshDir('proj4');
    roots.push(registered);
    await openAs(A, AGENT_ID);
    const res = await call('browser-session:screenshot-to-file', {
      sessionId: AGENT_ID, actorSessionId: A, workspacePath: registered, label: '../../escape',
    });
    expect(res.success).toBe(true);
    const expectedDir = path.join(registered, '.nimbalyst', 'transcript-images');
    expect(path.dirname(res.path)).toBe(expectedDir);
    expect(fs.existsSync(res.path)).toBe(true);
  });

  it('accepts a worktree of a registered project', async () => {
    const project = freshDir('proj5');
    const worktree = freshDir('proj5-worktree');
    roots.push(project);
    worktrees.set(worktree, { projectPath: project });
    await openAs(A, AGENT_ID);
    const res = await call('browser-session:screenshot-to-file', {
      sessionId: AGENT_ID, actorSessionId: A, workspacePath: worktree,
    });
    expect(res.success).toBe(true);
    expect(path.dirname(res.path)).toBe(path.join(worktree, '.nimbalyst', 'transcript-images'));
  });

  it('rejects a worktree whose project is not registered', async () => {
    const project = freshDir('proj6');
    const worktree = freshDir('proj6-worktree');
    worktrees.set(worktree, { projectPath: project });
    await openAs(A, AGENT_ID);
    const res = await call('browser-session:screenshot-to-file', {
      sessionId: AGENT_ID, actorSessionId: A, workspacePath: worktree,
    });
    expect(res.success).toBe(false);
  });

  it('refuses to write through a .nimbalyst symlink that leaves the workspace', async () => {
    const registered = freshDir('proj7');
    const outside = freshDir('outside7');
    roots.push(registered);
    try {
      fs.symlinkSync(outside, path.join(registered, '.nimbalyst'), 'junction');
    } catch {
      return; // symlink creation not permitted on this machine; nothing to prove here
    }
    await openAs(A, AGENT_ID);
    const res = await call('browser-session:screenshot-to-file', {
      sessionId: AGENT_ID, actorSessionId: A, workspacePath: registered,
    });
    expect(res.success).toBe(false);
    expect(fs.existsSync(path.join(outside, 'transcript-images'))).toBe(false);
  });
});
