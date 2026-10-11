/**
 * `run_project_tests`: run the workspace's own test command and nothing else.
 *
 * This is the only execution a `review` child (Team mode reviewer) may perform.
 * The agent never supplies a command, arguments, a working directory or a
 * shell: the command is `npm test` as a package.json of the workspace defines
 * it, run in the caller's workspace or in one existing folder inside it
 * (`projectPath`, for projects whose package.json is not at the root),
 * optionally narrowed to one existing test file of that project.
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
  /** Folder of the project inside the workspace; omitted means the root. */
  projectPath?: unknown;
  /** Test file or folder, relative to the project folder. */
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

type PathCheck = { ok: true; relative: string; absolute: string } | { ok: false; reason: string };

/**
 * Validate an agent-supplied relative path: structural checks first, then the
 * real path must exist strictly inside `root` (a link pointing outside fails).
 */
function validateInsidePath(raw: unknown, root: string, label: string, container: string): PathCheck {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: `${label} must be a non-empty string.` };
  if (raw.length > TEST_PATH_MAX_LENGTH) return { ok: false, reason: `${label} is too long.` };
  if (!TEST_PATH_CHARS.test(raw)) {
    return { ok: false, reason: `${label} may only contain letters, digits, ".", "_", "-" and "/".` };
  }
  if (raw.startsWith('-')) return { ok: false, reason: `${label} cannot start with "-".` };
  if (raw.startsWith('/') || path.isAbsolute(raw)) return { ok: false, reason: `${label} must be relative to ${container}.` };
  const segments = raw.split('/');
  if (segments.some((segment) => segment === '' || segment === '..')) {
    return { ok: false, reason: `${label} cannot contain ".." or empty segments.` };
  }

  let rootReal: string;
  let targetReal: string;
  try {
    rootReal = fs.realpathSync(root);
    targetReal = fs.realpathSync(path.resolve(rootReal, raw));
  } catch {
    return { ok: false, reason: `${label} does not exist in ${container}: ${raw}` };
  }
  const relative = path.relative(rootReal, targetReal);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, reason: `${label} must stay inside ${container}.` };
  }
  return { ok: true, relative: relative.split(path.sep).join('/'), absolute: targetReal };
}

/**
 * Validate an agent-supplied test path against the folder the tests run in
 * (the workspace, or the project folder when `projectPath` was given). Returns
 * the normalized relative path (forward slashes) or an error.
 */
export function validateTestPath(
  raw: unknown,
  projectRoot: string,
  container: string = 'the workspace',
): { ok: true; relative: string } | { ok: false; reason: string } {
  const checked = validateInsidePath(raw, projectRoot, 'testPath', container);
  return checked.ok ? { ok: true, relative: checked.relative } : checked;
}

/**
 * Validate an agent-supplied project folder: an existing directory strictly
 * inside the workspace. It only chooses WHERE `npm test` runs; the command
 * still comes from that folder's own package.json.
 */
export function validateProjectPath(raw: unknown, workspaceRoot: string): PathCheck {
  const checked = validateInsidePath(raw, workspaceRoot, 'projectPath', 'the workspace');
  if (!checked.ok) return checked;
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(checked.absolute).isDirectory();
  } catch {
    isDirectory = false;
  }
  return isDirectory ? checked : { ok: false, reason: `projectPath must be a folder: ${checked.relative}` };
}

/** The project's test script, or why there is none. Never invents one. */
export function readTestScript(
  projectRoot: string,
  where: string = 'the workspace root',
): { ok: true } | { ok: false; reason: string } {
  let pkg: unknown;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  } catch {
    const hint = where === 'the workspace root'
      ? ' If the project lives in a subfolder, pass projectPath (for example "web").'
      : '';
    return { ok: false, reason: `No readable package.json at ${where}, so there is no known test command.${hint}` };
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
 * Run `npm test` of the workspace (or of one project folder inside it) for one
 * calling session. `sessionKey` serializes runs per session: a second
 * concurrent call gets `busy`.
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

  let projectRoot = workspaceRoot;
  let projectRelative: string | null = null;
  if (args.projectPath !== undefined && args.projectPath !== null && args.projectPath !== '') {
    const project = validateProjectPath(args.projectPath, workspaceRoot);
    if (!project.ok) return { status: 'rejected', reason: project.reason };
    projectRoot = project.absolute;
    projectRelative = project.relative;
  }
  const where = projectRelative === null ? 'the workspace root' : `projectPath "${projectRelative}"`;
  const script = readTestScript(projectRoot, where);
  if (!script.ok) return { status: 'unavailable', reason: script.reason };

  const npmArgs = ['test'];
  if (args.testPath !== undefined && args.testPath !== null && args.testPath !== '') {
    const container = projectRelative === null ? 'the workspace' : 'the project folder';
    const checked = validateTestPath(args.testPath, projectRoot, container);
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
  const command = `npm ${npmArgs.join(' ')}${projectRelative === null ? '' : ` (in ${projectRelative})`}`;

  running.add(sessionKey);
  const started = now();
  try {
    return await new Promise<ProjectTestsResult>((resolve) => {
      const stdout = new HeadTailCollector();
      const stderr = new HeadTailCollector();
      let timedOut = false;
      let settled = false;

      const child = spawn(npm.node, [npm.npmCli, ...npmArgs], {
        cwd: projectRoot,
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
