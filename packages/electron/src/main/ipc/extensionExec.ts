/**
 * Hygiene guards for `extension:exec` and `extension:file-storage:*`.
 *
 * What this is: a set of checks that keep ordinary mistakes, stale ids and
 * stray callers out of the shell channel and the extension data folder.
 *
 * What this is NOT: a security boundary against script running in the
 * renderer. Any JS that runs in a workspace window (an extension, or injected
 * markup) can call `extension:exec` as any installed extension, with a cwd
 * inside the workspace, from the top frame -- every check below passes for it.
 * The real fix is typed, main-side operations instead of a shell (tracked as
 * E4 under NIB.85); until then the command itself is not restricted.
 */

import { exec } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface ExtensionExecParams {
  extensionId: string;
  command: string;
  cwd: string;
  timeout?: number;
  env?: Record<string, string>;
  maxBuffer?: number;
}

export interface ExtensionExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExtensionExecDeps {
  /** Manifest of an installed extension, or null when no such extension exists. */
  readManifest(extensionId: string): Promise<{
    id?: string;
    defaultEnabled?: boolean;
    permissions?: { filesystem?: boolean };
  } | null>;
  isEnabled(extensionId: string, manifestDefaultEnabled?: boolean): boolean;
  /** Roots of the calling window's workspace, or null when it is not a workspace window. */
  getWorkspaceRoots(): string[] | null;
}

export interface ExtensionExecSender {
  /** True when the IPC came from the window's top frame, not a child iframe. */
  isTopFrame: boolean;
}

/** Variables that make a spawned process load code the caller chose. */
const BLOCKED_ENV_EXACT = new Set(['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'LD_PRELOAD']);
const BLOCKED_ENV_PREFIX = 'DYLD_';

function isBlockedEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return BLOCKED_ENV_EXACT.has(upper) || upper.startsWith(BLOCKED_ENV_PREFIX);
}

/** Drop loader/runtime-injection variables from the caller-supplied env. */
export function sanitizeExecEnv(
  env: Record<string, string> | undefined,
): { env: Record<string, string> | undefined; dropped: string[] } {
  if (!env || typeof env !== 'object') return { env: undefined, dropped: [] };
  const kept: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (isBlockedEnvKey(key)) dropped.push(key);
    else kept[key] = value;
  }
  return { env: kept, dropped };
}

function fail(stderr: string): ExtensionExecResult {
  return { success: false, stdout: '', stderr, exitCode: -1 };
}

async function realOrResolved(p: string): Promise<string> {
  const resolved = path.resolve(p);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

function isInside(child: string, root: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const c = norm(child);
  const r = norm(root);
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

export async function runExtensionExec(
  deps: ExtensionExecDeps,
  sender: ExtensionExecSender,
  params: ExtensionExecParams,
): Promise<ExtensionExecResult> {
  const { extensionId, command, cwd, timeout = 60000, env, maxBuffer = 10 * 1024 * 1024 } = params ?? ({} as ExtensionExecParams);

  if (!sender.isTopFrame) {
    return fail('extension:exec is only available from the top frame of a workspace window');
  }
  if (typeof extensionId !== 'string' || extensionId.length === 0 || typeof command !== 'string') {
    return fail('extension:exec requires extensionId and command');
  }

  const manifest = await deps.readManifest(extensionId);
  if (!manifest?.permissions?.filesystem) {
    return fail(`Extension ${extensionId} not found or lacks filesystem permission`);
  }
  if (!deps.isEnabled(extensionId, manifest.defaultEnabled)) {
    return fail(`Extension ${extensionId} is disabled`);
  }

  const roots = deps.getWorkspaceRoots();
  if (!roots || roots.length === 0) {
    return fail('extension:exec is only available from a workspace window');
  }
  if (typeof cwd !== 'string' || cwd.length === 0 || !path.isAbsolute(cwd)) {
    return fail('extension:exec requires an absolute cwd inside the workspace');
  }
  const realCwd = await realOrResolved(cwd);
  const realRoots = await Promise.all(roots.map(realOrResolved));
  if (!realRoots.some((root) => isInside(realCwd, root))) {
    return fail(`cwd is outside the workspace of the calling window: ${cwd}`);
  }

  const { env: callerEnv } = sanitizeExecEnv(env);

  return new Promise<ExtensionExecResult>((resolve) => {
    exec(
      command,
      { cwd: path.resolve(cwd), timeout, maxBuffer, env: callerEnv ? { ...process.env, ...callerEnv } : process.env },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ success: true, stdout: String(stdout), stderr: String(stderr), exitCode: 0 });
          return;
        }
        const err = error as { code?: number | string; message?: string };
        resolve({
          success: false,
          stdout: String(stdout || ''),
          stderr: String(stderr || err.message || ''),
          exitCode: typeof err.code === 'number' && err.code ? err.code : 1,
        });
      },
    );
  });
}

/**
 * Reject an extensionId that could name a path outside the extension data
 * root: `..`, separators, drive letters, NUL, or anything that resolves
 * elsewhere. Returns the id unchanged so call sites can wrap it inline.
 */
export function assertSafeExtensionId(extensionId: string, dataRoot: string): string {
  if (
    typeof extensionId !== 'string' ||
    extensionId.length === 0 ||
    /^\.+$/.test(extensionId) ||
    // Windows drops a trailing dot or space, so "ext." and "ext " name "ext".
    /[. ]$/.test(extensionId) ||
    /[\\/:\0]/.test(extensionId) ||
    path.isAbsolute(extensionId)
  ) {
    throw new Error(`Invalid extensionId: ${JSON.stringify(extensionId)}`);
  }
  const root = path.resolve(dataRoot);
  const resolved = path.resolve(root, extensionId);
  if (path.dirname(resolved) !== root) {
    throw new Error(`Invalid extensionId: ${JSON.stringify(extensionId)} resolves outside the extension data root`);
  }
  return extensionId;
}
