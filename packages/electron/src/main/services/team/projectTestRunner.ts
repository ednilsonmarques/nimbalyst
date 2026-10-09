/**
 * `run_project_tests`: run the workspace's own test command and nothing else.
 *
 * This is the only execution a `review` child (Team mode reviewer) may perform.
 * The agent never supplies a command, arguments, a working directory or a
 * shell: the command is `npm test` as the workspace's package.json defines it,
 * run in the caller's workspace, optionally narrowed to one existing test file.
 *
 * What the project's tests themselves do (temp files, snapshots, caches) is the
 * project's code, not a capability granted to the agent. There is no OS
 * sandbox on Windows; this tool does not pretend otherwise.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { terminateOwnedProcessTree } from '@nimbalyst/runtime/ai/server/protocols/processTreeTermination';

export const PROJECT_TESTS_DEFAULT_TIMEOUT_SECONDS = 120;
export const PROJECT_TESTS_MAX_TIMEOUT_SECONDS = 300;
/** Per stream; the head and the tail are kept, the middle is dropped. */
export const PROJECT_TESTS_MAX_OUTPUT_CHARS = 48_000;

const TEST_PATH_MAX_LENGTH = 300;
const TEST_PATH_CHARS = /^[A-Za-z0-9._\-/]+$/;
const NPM_INIT_PLACEHOLDER = /no test specified/i;

export type ProjectTestsStatus = 'passed' | 'failed' | 'timed_out' | 'unavailable' | 'busy' | 'rejected';

export interface ProjectTestsResult {
  status: ProjectTestsStatus;
  /** What ran, for the report; never something the agent could choose. */
  command?: string;
  exitCode?: number | null;
  signal?: string | null;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
  /** Why the run did not happen (unavailable / busy / rejected). */
  reason?: string;
}

export interface ProjectTestsArgs {
  testPath?: unknown;
  timeoutSeconds?: unknown;
}

type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface ProjectTestRunnerDeps {
  spawn?: SpawnFn;
  /** Locates `node` and npm's CLI entry; null when either cannot be found. */
  resolveNpm?: () => { node: string; npmCli: string } | null;
  /** PATH the tests run with (the app's enhanced PATH in production). */
  pathEnv?: () => string;
  terminateTree?: (child: ChildProcess) => void;
  now?: () => number;
}

const running = new Set<string>();

/**
 * Validate an agent-supplied test path: structural checks first, then the real
 * path must exist inside the workspace. Returns the normalized relative path
 * (forward slashes) or an error.
 */
export function validateTestPath(
  raw: unknown,
  workspaceRoot: string,
): { ok: true; relative: string } | { ok: false; reason: string } {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'testPath must be a non-empty string.' };
  if (raw.length > TEST_PATH_MAX_LENGTH) return { ok: false, reason: 'testPath is too long.' };
  if (!TEST_PATH_CHARS.test(raw)) {
    return { ok: false, reason: 'testPath may only contain letters, digits, ".", "_", "-" and "/".' };
  }
  if (raw.startsWith('-')) return { ok: false, reason: 'testPath cannot start with "-".' };
  if (raw.startsWith('/') || path.isAbsolute(raw)) return { ok: false, reason: 'testPath must be relative to the workspace.' };
  const segments = raw.split('/');
  if (segments.some((segment) => segment === '' || segment === '..')) {
    return { ok: false, reason: 'testPath cannot contain ".." or empty segments.' };
  }

  let rootReal: string;
  let targetReal: string;
  try {
    rootReal = fs.realpathSync(workspaceRoot);
    targetReal = fs.realpathSync(path.resolve(rootReal, raw));
  } catch {
    return { ok: false, reason: `testPath does not exist in the workspace: ${raw}` };
  }
  const relative = path.relative(rootReal, targetReal);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, reason: 'testPath must stay inside the workspace.' };
  }
  return { ok: true, relative: relative.split(path.sep).join('/') };
}

/** The workspace's test script, or why there is none. Never invents one. */
export function readTestScript(workspaceRoot: string): { ok: true } | { ok: false; reason: string } {
  let pkg: unknown;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8'));
  } catch {
    return { ok: false, reason: 'No readable package.json at the workspace root, so there is no known test command.' };
  }
  const script = (pkg as { scripts?: Record<string, unknown> } | null)?.scripts?.test;
  if (typeof script !== 'string' || script.trim() === '') {
    return { ok: false, reason: 'package.json has no "test" script.' };
  }
  if (NPM_INIT_PLACEHOLDER.test(script)) {
    return { ok: false, reason: 'package.json "test" script is the npm init placeholder; the project has no tests configured.' };
  }
  return { ok: true };
}

/** Find `node` on PATH and npm's JS entry next to it (Windows and Unix layouts). */
export function resolveNpmFromPath(pathEnv: string, platform: NodeJS.Platform = process.platform): { node: string; npmCli: string } | null {
  const nodeName = platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, nodeName);
    if (!fs.existsSync(candidate)) continue;
    let nodeDir: string;
    try {
      nodeDir = path.dirname(fs.realpathSync(candidate));
    } catch {
      continue;
    }
    const npmCli = [
      path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ].find((file) => fs.existsSync(file));
    if (npmCli) return { node: candidate, npmCli };
  }
  return null;
}

/**
 * Streaming collector that keeps the head and the tail of a stream within
 * `max` characters, without ever holding more than that in memory.
 */
export class HeadTailCollector {
  private head = '';
  private tail = '';
  private total = 0;
  private readonly half: number;

  constructor(private readonly max: number = PROJECT_TESTS_MAX_OUTPUT_CHARS) {
    this.half = Math.floor(max / 2);
  }

  push(chunk: string): void {
    this.total += chunk.length;
    if (this.head.length < this.half) {
      const room = this.half - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }
    if (chunk.length > 0) {
      this.tail = (this.tail + chunk).slice(-this.half);
    }
  }

  result(): { text: string; truncated: boolean } {
    if (this.total <= this.max) return { text: this.head + this.tail, truncated: false };
    const dropped = this.total - this.head.length - this.tail.length;
    return { text: `${this.head}\n… [${dropped} characters omitted] …\n${this.tail}`, truncated: true };
  }
}

function resolveTimeoutSeconds(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return PROJECT_TESTS_DEFAULT_TIMEOUT_SECONDS;
  return Math.min(PROJECT_TESTS_MAX_TIMEOUT_SECONDS, Math.max(1, Math.floor(raw)));
}

/**
 * Run the workspace's `npm test` for one calling session. `sessionKey` serializes
 * runs per session: a second concurrent call gets `busy`.
 */
export async function runProjectTests(
  sessionKey: string,
  workspaceRoot: string,
  args: ProjectTestsArgs,
  deps: ProjectTestRunnerDeps = {},
): Promise<ProjectTestsResult> {
  if (running.has(sessionKey)) {
    return { status: 'busy', reason: 'A test run for this session is already in progress; wait for it to finish.' };
  }

  if (!workspaceRoot || !path.isAbsolute(workspaceRoot) || !fs.existsSync(workspaceRoot)) {
    return { status: 'unavailable', reason: 'The calling session has no workspace on disk.' };
  }
  const script = readTestScript(workspaceRoot);
  if (!script.ok) return { status: 'unavailable', reason: script.reason };

  const npmArgs = ['test'];
  if (args.testPath !== undefined && args.testPath !== null && args.testPath !== '') {
    const checked = validateTestPath(args.testPath, workspaceRoot);
    if (!checked.ok) return { status: 'rejected', reason: checked.reason };
    npmArgs.push('--', checked.relative);
  }

  const pathEnv = deps.pathEnv?.() ?? process.env.PATH ?? '';
  const npm = (deps.resolveNpm ?? (() => resolveNpmFromPath(pathEnv)))();
  if (!npm) return { status: 'unavailable', reason: 'Could not find node and npm on PATH.' };

  const spawn: SpawnFn = deps.spawn ?? ((command, spawnArgs, options) => nodeSpawn(command, spawnArgs, options));
  const terminateTree = deps.terminateTree ?? ((child: ChildProcess) => terminateOwnedProcessTree(child));
  const now = deps.now ?? Date.now;
  const timeoutMs = resolveTimeoutSeconds(args.timeoutSeconds) * 1000;
  const command = `npm ${npmArgs.join(' ')}`;

  running.add(sessionKey);
  const started = now();
  try {
    return await new Promise<ProjectTestsResult>((resolve) => {
      const stdout = new HeadTailCollector();
      const stderr = new HeadTailCollector();
      let timedOut = false;
      let settled = false;

      const child = spawn(npm.node, [npm.npmCli, ...npmArgs], {
        cwd: workspaceRoot,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PATH: pathEnv,
          CI: '1',
          FORCE_COLOR: '0',
          NO_COLOR: '1',
          npm_config_update_notifier: 'false',
          npm_config_fund: 'false',
        },
      });

      child.stdout?.on('data', (chunk: Buffer | string) => stdout.push(chunk.toString()));
      child.stderr?.on('data', (chunk: Buffer | string) => stderr.push(chunk.toString()));

      const timer = setTimeout(() => {
        timedOut = true;
        terminateTree(child);
      }, timeoutMs);

      const finish = (exitCode: number | null, signal: string | null, spawnError?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (spawnError) stderr.push(spawnError.message);
        const out = stdout.result();
        const err = stderr.result();
        resolve({
          status: timedOut ? 'timed_out' : exitCode === 0 ? 'passed' : 'failed',
          command,
          exitCode,
          signal,
          durationMs: now() - started,
          stdout: out.text,
          stderr: err.text,
          truncated: out.truncated || err.truncated,
        });
      };
      child.once('error', (error) => finish(null, null, error));
      child.once('close', (code, signal) => finish(code, signal));
    });
  } finally {
    running.delete(sessionKey);
  }
}
