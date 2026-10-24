// @vitest-environment node
/**
 * Portal F1.2 (B1) -- the preview-URL builder trusts the registered workspace
 * roots, which are process-wide. With `confineToRoot` a file must also lie under
 * the caller's own project root, so one project's session cannot open another
 * registered project's files.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } },
}));
const { registered, removed, worktrees, links, realPaths } = vi.hoisted(() => ({
  registered: [] as string[],
  // roots taken out of the allowlist (removeNimPreviewWorkspaceRoot)
  removed: new Set<string>(),
  // paths that are symlinks / junctions (lstat), and what realpath resolves a path to
  links: new Set<string>(),
  realPaths: new Map<string, string>(),
  // worktree path -> the project it belongs to, as WorktreeStore knows it
  worktrees: new Map<string, string>(),
}));
vi.mock('fs/promises', async () => {
  const { resolve } = await import('path');
  return {
  lstat: async (p: string) => ({ isSymbolicLink: () => links.has(resolve(p)) }),
  realpath: async (p: string) => realPaths.get(resolve(p)) ?? p,
  mkdir: async () => undefined,
  writeFile: async () => undefined,
  };
});
vi.mock('../../database/initialize', () => ({ getDatabase: () => ({}) }));
vi.mock('../WorktreeStore', async () => {
  const { resolve } = await import('path');
  return {
    createWorktreeStore: () => ({
      getByPath: async (p: string) => {
        const project = worktrees.get(resolve(p));
        return project ? { projectPath: project } : null;
      },
    }),
  };
});
vi.mock('../../protocols/nimPreviewProtocol', async () => {
  const { resolve, relative, isAbsolute } = await import('path');
  const inside = (root: string, p: string) => {
    const r = relative(resolve(root), resolve(p));
    return r === '' || (!r.startsWith('..') && !isAbsolute(r));
  };
  return {
    getNimPreviewWorkspaceRoots: () => [resolve('/proj'), resolve('/other'), ...registered].filter((r) => !removed.has(r)),
    addNimPreviewWorkspaceRoot: (root: string) => {
      removed.delete(resolve(root));
      if (!registered.includes(resolve(root))) registered.push(resolve(root));
    },
    removeNimPreviewWorkspaceRoot: (root: string) => {
      removed.add(resolve(root));
    },
    previewPathInsideRoot: inside,
    // Case-insensitive on Windows, like the real helper.
    previewPathsEqual: (a: string, b: string) =>
      process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b),
    encodeNimPreviewUrl: (root: string, rel: string) => `nim-preview://${Buffer.from(root).toString('hex')}/${rel.split(String.fromCharCode(92)).join('/')}`,
  };
});

import { beforeEach } from 'vitest';
import { buildPreviewUrlForFile, registerWorktreeRoot, releaseWorkspacePreviewRoots } from '../BrowserAgentFiles';

import { resolve } from 'path';
const hex = (s: string) => Buffer.from(resolve(s)).toString('hex');

describe('buildPreviewUrlForFile', () => {
  it('without confinement serves a file of any registered root (today\'s behaviour for the user\'s own tools)', () => {
    expect(buildPreviewUrlForFile('/other/index.html', '/proj')).toBe(`nim-preview://${hex('/other')}/index.html`);
  });

  it('with confineToRoot serves a file of the caller\'s root', () => {
    expect(buildPreviewUrlForFile('/proj/a/b.html', '/proj', { confineToRoot: true })).toBe(`nim-preview://${hex('/proj')}/a/b.html`);
  });

  it('with confineToRoot refuses a file of another registered root', () => {
    expect(() => buildPreviewUrlForFile('/other/index.html', '/proj', { confineToRoot: true })).toThrow(/outside the project/i);
  });

  it('with confineToRoot refuses a ".." escape and a sibling with the same prefix', () => {
    expect(() => buildPreviewUrlForFile('/proj/../other/index.html', '/proj', { confineToRoot: true })).toThrow(/outside the project/i);
    expect(() => buildPreviewUrlForFile('/project-two/index.html', '/proj', { confineToRoot: true })).toThrow();
  });

  it('with confineToRoot and no root, refuses', () => {
    expect(() => buildPreviewUrlForFile('/proj/index.html', undefined, { confineToRoot: true })).toThrow(/project/i);
  });

  it('still refuses a file that is under no registered root', () => {
    expect(() => buildPreviewUrlForFile('/etc/passwd', '/proj', { confineToRoot: true })).toThrow();
    expect(() => buildPreviewUrlForFile('/etc/passwd', '/proj')).toThrow(/active workspace root/);
  });
});

describe('registerWorktreeRoot (a member in a worktree can open its own files)', () => {
  beforeEach(() => {
    registered.length = 0;
    worktrees.clear();
    links.clear();
    realPaths.clear();
    worktrees.set(resolve('/wt/feat'), '/proj');
    worktrees.set(resolve('/wt/orphan'), '/not-open');
  });

  it('without registering, a worktree file cannot be served (the bug)', () => {
    expect(() => buildPreviewUrlForFile('/wt/feat/index.html', '/wt/feat', { confineToRoot: true })).toThrow(/active workspace root/);
  });

  it('registers a worktree that WorktreeStore ties to a registered project, then serves its files', async () => {
    await registerWorktreeRoot('/wt/feat');
    expect(registered).toEqual([resolve('/wt/feat')]);
    expect(buildPreviewUrlForFile('/wt/feat/index.html', '/wt/feat', { confineToRoot: true })).toBe(`nim-preview://${hex('/wt/feat')}/index.html`);
  });

  it('is idempotent in effect: a path already served is not registered again', async () => {
    await registerWorktreeRoot('/proj');
    await registerWorktreeRoot('/proj/sub/dir');
    expect(registered).toEqual([]);
  });

  it('never registers an arbitrary path', async () => {
    for (const p of ['/random/dir', '/etc', '/wt', '/wt/unknown']) await registerWorktreeRoot(p);
    expect(registered).toEqual([]);
  });

  it('never registers a worktree whose project is not a registered project', async () => {
    await registerWorktreeRoot('/wt/orphan');
    expect(registered).toEqual([]);
    expect(() => buildPreviewUrlForFile('/wt/orphan/index.html', '/wt/orphan', { confineToRoot: true })).toThrow();
  });

  it('registering a worktree does not let it serve a sibling worktree or the parent of itself', async () => {
    await registerWorktreeRoot('/wt/feat');
    expect(() => buildPreviewUrlForFile('/wt/other/index.html', '/wt/feat', { confineToRoot: true })).toThrow();
    expect(() => buildPreviewUrlForFile('/wt/index.html', '/wt/feat', { confineToRoot: true })).toThrow();
  });

  it('a known worktree that is a symlink or junction pointing outside registers nothing', async () => {
    links.add(resolve('/wt/feat'));
    realPaths.set(resolve('/wt/feat'), resolve('/outside/secret'));
    await registerWorktreeRoot('/wt/feat');
    expect(registered).toEqual([]);
    expect(() => buildPreviewUrlForFile('/wt/feat/index.html', '/wt/feat', { confineToRoot: true })).toThrow();
  });

  it('a symlink is refused even when it resolves to the same path', async () => {
    links.add(resolve('/wt/feat'));
    await registerWorktreeRoot('/wt/feat');
    expect(registered).toEqual([]);
  });

  it('a worktree reached through a linked parent directory (realpath differs) registers nothing', async () => {
    realPaths.set(resolve('/wt/feat'), resolve('/elsewhere/feat'));
    await registerWorktreeRoot('/wt/feat');
    expect(registered).toEqual([]);
  });

  it('a path that cannot be inspected registers nothing', async () => {
    worktrees.set(resolve('/wt/gone'), '/proj');
    realPaths.set(resolve('/wt/gone'), '\0');
    await registerWorktreeRoot('/wt/gone');
    expect(registered).toEqual([]);
  });

  it.runIf(process.platform === 'win32')('on Windows a case-only difference is the same path and still registers', async () => {
    realPaths.set(resolve('/wt/feat'), resolve('/wt/feat').toUpperCase());
    await registerWorktreeRoot('/wt/feat');
    expect(registered).toEqual([resolve('/wt/feat')]);
  });
});

describe('releaseWorkspacePreviewRoots (a closed workspace is no longer served)', () => {
  const served = () => [resolve('/proj'), resolve('/other'), ...registered].filter((r) => !removed.has(r));

  beforeEach(() => {
    // Forget the worktree owners earlier tests recorded, then start from /proj and /other open.
    releaseWorkspacePreviewRoots('/proj', []);
    releaseWorkspacePreviewRoots('/other', []);
    registered.length = 0;
    removed.clear();
    worktrees.clear();
    links.clear();
    realPaths.clear();
    worktrees.set(resolve('/wt/feat'), '/proj');
    worktrees.set(resolve('/wt/beta'), '/other');
  });

  it('stops serving the released workspace and nothing else', () => {
    releaseWorkspacePreviewRoots('/proj', ['/other']);
    expect(served()).toEqual([resolve('/other')]);
    expect(() => buildPreviewUrlForFile('/proj/index.html', '/proj', { confineToRoot: true })).toThrow(/active workspace root/);
  });

  it('also stops serving the worktree roots registered for it', async () => {
    await registerWorktreeRoot('/wt/feat');
    releaseWorkspacePreviewRoots('/proj', ['/other']);
    expect(served()).toEqual([resolve('/other')]);
    expect(() => buildPreviewUrlForFile('/wt/feat/index.html', '/wt/feat', { confineToRoot: true })).toThrow(/active workspace root/);
  });

  it('keeps the worktree roots of another project', async () => {
    await registerWorktreeRoot('/wt/feat');
    await registerWorktreeRoot('/wt/beta');
    releaseWorkspacePreviewRoots('/proj', ['/other']);
    expect(served()).toEqual([resolve('/other'), resolve('/wt/beta')]);
  });

  it('keeps a worktree root that is open as a workspace of its own, until that one is released', async () => {
    await registerWorktreeRoot('/wt/feat');
    releaseWorkspacePreviewRoots('/proj', ['/other', '/wt/feat']);
    expect(served()).toEqual([resolve('/other'), resolve('/wt/feat')]);

    releaseWorkspacePreviewRoots('/wt/feat', ['/other']);
    expect(served()).toEqual([resolve('/other')]);
  });

  it('keeps a released worktree root while its project is still served, and drops it with the project', async () => {
    await registerWorktreeRoot('/wt/feat');
    releaseWorkspacePreviewRoots('/wt/feat', ['/proj', '/other']);
    expect(served()).toContain(resolve('/wt/feat'));

    releaseWorkspacePreviewRoots('/proj', ['/other']);
    expect(served()).toEqual([resolve('/other')]);
  });

  it('is idempotent and order-independent', async () => {
    await registerWorktreeRoot('/wt/feat');
    await registerWorktreeRoot('/wt/beta');
    releaseWorkspacePreviewRoots('/other', ['/proj']);
    releaseWorkspacePreviewRoots('/proj', []);
    releaseWorkspacePreviewRoots('/proj', []);
    releaseWorkspacePreviewRoots('/wt/feat', []);
    expect(served()).toEqual([]);
  });

  it('a worktree of a released project cannot be registered again', async () => {
    releaseWorkspacePreviewRoots('/proj', ['/other']);
    await registerWorktreeRoot('/wt/feat');
    expect(registered).toEqual([]);
  });

  it.runIf(process.platform === 'win32')('on Windows a case-only difference in the released path still releases', async () => {
    await registerWorktreeRoot('/wt/feat');
    releaseWorkspacePreviewRoots(resolve('/proj').toUpperCase(), ['/other']);
    expect(served()).toEqual([resolve('/other')]);
  });

  it.runIf(process.platform === 'win32')('on Windows a root another window still holds under another spelling stays', () => {
    releaseWorkspacePreviewRoots('/proj', [resolve('/proj').toUpperCase(), '/other']);
    expect(served()).toEqual([resolve('/proj'), resolve('/other')]);
  });
});