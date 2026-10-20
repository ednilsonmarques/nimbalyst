/**
 * Hygiene guards for `extension:exec` and `extension:file-storage:*`
 * (NIB.85 stage c, decisions U3 = E0 and U4).
 *
 * These guards keep ordinary mistakes and stray callers out. They are NOT a
 * boundary against script running in the renderer: such script can call the
 * channel as any installed extension, from inside a workspace window.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const execMock = vi.fn();
vi.mock('child_process', () => ({
  exec: (...args: unknown[]) => execMock(...args),
  default: { exec: (...args: unknown[]) => execMock(...args) },
}));

import {
  runExtensionExec,
  sanitizeExecEnv,
  assertSafeExtensionId,
  type ExtensionExecDeps,
} from '../extensionExec';

let root: string;
let outside: string;

function makeDeps(over: Partial<ExtensionExecDeps> = {}): ExtensionExecDeps {
  return {
    readManifest: async (id) =>
      id === 'ext.good' ? { id, permissions: { filesystem: true } } : null,
    isEnabled: () => true,
    getWorkspaceRoots: () => [root],
    ...over,
  };
}

const topFrame = { isTopFrame: true };

describe('runExtensionExec', () => {
  beforeEach(() => {
    execMock.mockReset();
    execMock.mockImplementation((_cmd: string, _opts: unknown, cb: (e: unknown, out: string, err: string) => void) =>
      cb(null, 'ok\n', ''),
    );
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-exec-root-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-exec-out-'));
  });

  it('runs for an installed, enabled extension with cwd inside the workspace', async () => {
    const res = await runExtensionExec(makeDeps(), topFrame, {
      extensionId: 'ext.good', command: 'echo nib-c', cwd: root,
    });
    expect(res.success).toBe(true);
    expect(res.stdout).toBe('ok\n');
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock.mock.calls[0][1].cwd).toBe(root);
  });

  it('accepts a cwd in a subdirectory of the workspace', async () => {
    const sub = path.join(root, 'pkg');
    fs.mkdirSync(sub);
    const res = await runExtensionExec(makeDeps(), topFrame, {
      extensionId: 'ext.good', command: 'echo x', cwd: sub,
    });
    expect(res.success).toBe(true);
  });

  it('rejects an unknown or forged extension id', async () => {
    const res = await runExtensionExec(makeDeps(), topFrame, {
      extensionId: 'ext.forged', command: 'echo x', cwd: root,
    });
    expect(res.success).toBe(false);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('rejects an installed extension that lacks the filesystem permission', async () => {
    const res = await runExtensionExec(
      makeDeps({ readManifest: async (id) => ({ id, permissions: {} }) }),
      topFrame,
      { extensionId: 'ext.good', command: 'echo x', cwd: root },
    );
    expect(res.success).toBe(false);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('rejects a disabled extension', async () => {
    const res = await runExtensionExec(makeDeps({ isEnabled: () => false }), topFrame, {
      extensionId: 'ext.good', command: 'echo x', cwd: root,
    });
    expect(res.success).toBe(false);
    expect(res.stderr).toMatch(/disabled/i);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('rejects a cwd outside the workspace roots', async () => {
    const res = await runExtensionExec(makeDeps(), topFrame, {
      extensionId: 'ext.good', command: 'echo x', cwd: outside,
    });
    expect(res.success).toBe(false);
    expect(res.stderr).toMatch(/workspace/i);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('rejects a cwd that escapes through ..', async () => {
    const res = await runExtensionExec(makeDeps(), topFrame, {
      extensionId: 'ext.good', command: 'echo x', cwd: path.join(root, '..', path.basename(outside)),
    });
    expect(res.success).toBe(false);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('rejects a sibling directory that merely shares the root prefix', async () => {
    const sibling = `${root}-evil`;
    fs.mkdirSync(sibling);
    const res = await runExtensionExec(makeDeps(), topFrame, {
      extensionId: 'ext.good', command: 'echo x', cwd: sibling,
    });
    expect(res.success).toBe(false);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('rejects a missing or relative cwd', async () => {
    for (const cwd of ['', 'relative/dir', undefined as unknown as string]) {
      const res = await runExtensionExec(makeDeps(), topFrame, {
        extensionId: 'ext.good', command: 'echo x', cwd,
      });
      expect(res.success).toBe(false);
    }
    expect(execMock).not.toHaveBeenCalled();
  });

  it('rejects a caller that is not a workspace window (no roots)', async () => {
    const res = await runExtensionExec(makeDeps({ getWorkspaceRoots: () => null }), topFrame, {
      extensionId: 'ext.good', command: 'echo x', cwd: root,
    });
    expect(res.success).toBe(false);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('rejects a caller that is not the top frame', async () => {
    const res = await runExtensionExec(makeDeps(), { isTopFrame: false }, {
      extensionId: 'ext.good', command: 'echo x', cwd: root,
    });
    expect(res.success).toBe(false);
    expect(res.stderr).toMatch(/top frame/i);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('rejects a non-string command', async () => {
    const res = await runExtensionExec(makeDeps(), topFrame, {
      extensionId: 'ext.good', command: 42 as unknown as string, cwd: root,
    });
    expect(res.success).toBe(false);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('strips NODE_OPTIONS, ELECTRON_RUN_AS_NODE, LD_PRELOAD and DYLD_* from the env passed to the child', async () => {
    // Remove the app's own copies so absence in the child env can only come
    // from the guard (process.env passes through untouched by design).
    const blocked = (k: string) => /^(NODE_OPTIONS|ELECTRON_RUN_AS_NODE|LD_PRELOAD)$/i.test(k) || /^DYLD_/i.test(k);
    const saved = Object.entries(process.env).filter(([k]) => blocked(k));
    for (const [k] of saved) delete process.env[k];
    try {
      await runExtensionExec(makeDeps(), topFrame, {
        extensionId: 'ext.good', command: 'echo x', cwd: root,
        env: {
          NODE_OPTIONS: '--require /tmp/evil.js',
          ELECTRON_RUN_AS_NODE: '1',
          LD_PRELOAD: '/tmp/evil.so',
          DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
          dyld_library_path: '/tmp',
          node_options: 'x',
          PLAYWRIGHT_JSON_OUTPUT_NAME: 'out.json',
        },
      });
      const env = execMock.mock.calls[0][1].env as Record<string, string>;
      expect(Object.keys(env).filter(blocked)).toEqual([]);
      expect(env).toEqual({ ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: 'out.json' });
    } finally {
      for (const [k, v] of saved) process.env[k] = v as string;
    }
  });
});

describe('sanitizeExecEnv', () => {
  it('drops the dangerous keys case-insensitively and reports them', () => {
    const { env, dropped } = sanitizeExecEnv({
      NODE_OPTIONS: 'a', Electron_Run_As_Node: '1', LD_PRELOAD: 'b', DYLD_FOO: 'c', KEEP: 'd',
    });
    expect(env).toEqual({ KEEP: 'd' });
    expect(dropped.sort()).toEqual(['DYLD_FOO', 'Electron_Run_As_Node', 'LD_PRELOAD', 'NODE_OPTIONS']);
  });

  it('passes undefined through', () => {
    expect(sanitizeExecEnv(undefined)).toEqual({ env: undefined, dropped: [] });
  });
});

describe('assertSafeExtensionId (U4)', () => {
  const dataRoot = path.join(os.tmpdir(), 'nim-ext-data-root');

  it.each(['..', '../x', 'a/../b', 'a/b', 'a\\b', '..\\..\\evil', '.', '', '/abs', 'C:\\abs', 'a\0b',
    '...', '....', ' ', 'ext.', 'ext ', 'ext..', 'ext. '])(
    'rejects %j',
    (id) => {
      expect(() => assertSafeExtensionId(id, dataRoot)).toThrow(/extensionId/);
    },
  );

  it('rejects a non-string', () => {
    expect(() => assertSafeExtensionId(undefined as unknown as string, dataRoot)).toThrow(/extensionId/);
  });

  it.each(['com.nimbalyst.playwright', 'project-graph', 'my_ext.v2', '@scope.name'])(
    'accepts %j and returns it unchanged',
    (id) => {
      expect(assertSafeExtensionId(id, dataRoot)).toBe(id);
    },
  );
});
