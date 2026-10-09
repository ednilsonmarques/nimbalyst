// @vitest-environment node
/**
 * run_project_tests runner: real temporary projects, real npm and node, so the
 * Windows behaviour (no shell, tree kill) is what is actually exercised.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn as nodeSpawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  HeadTailCollector,
  readTestScript,
  resolveNpmFromPath,
  runProjectTests,
  validateTestPath,
} from '../projectTestRunner';

let root: string;
let counter = 0;

function project(testScript: string | null, files: Record<string, string> = {}): string {
  const dir = path.join(root, `p${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  if (testScript !== null) {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: testScript } }));
  }
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

const PASSING = "import { test } from 'node:test';\ntest('ok', () => {});\n";
const FAILING = "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('bad', () => { assert.equal(1, 2); });\n";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-run-tests-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('no known test command → unavailable, never invented', () => {
  it('without package.json', async () => {
    const result = await runProjectTests('s', project(null), {});
    expect(result.status).toBe('unavailable');
    expect(result.reason).toContain('package.json');
  });

  it('without a test script', async () => {
    const dir = project(null);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { build: 'tsc' } }));
    expect((await runProjectTests('s', dir, {})).status).toBe('unavailable');
  });

  it('with the npm init placeholder', async () => {
    const dir = project('echo "Error: no test specified" && exit 1');
    const result = await runProjectTests('s', dir, {});
    expect(result.status).toBe('unavailable');
    expect(result.reason).toContain('placeholder');
    expect(readTestScript(dir).ok).toBe(false);
  });

  it('when node and npm cannot be found', async () => {
    const result = await runProjectTests('s', project('node --test'), {}, { resolveNpm: () => null });
    expect(result.status).toBe('unavailable');
  });

  it('resolveNpmFromPath finds nothing on an empty PATH and finds npm on the real one', () => {
    expect(resolveNpmFromPath('')).toBeNull();
    const found = resolveNpmFromPath(process.env.PATH ?? '');
    expect(found?.npmCli.endsWith(path.join('npm', 'bin', 'npm-cli.js'))).toBe(true);
  });
});

describe('testPath validation', () => {
  it('accepts an existing relative file and normalizes it', () => {
    const dir = project('node --test', { 'test/a.test.mjs': PASSING });
    expect(validateTestPath('test/a.test.mjs', dir)).toEqual({ ok: true, relative: 'test/a.test.mjs' });
  });

  it.each([
    ['-x', 'cannot start with "-"'],
    ['--test-only', 'cannot start with "-"'],
    ['../outside.js', '".."'],
    ['test/../../x.js', '".."'],
    ['/etc/passwd', 'relative'],
    ['C:/Windows/win.ini', 'may only contain'],
    ['a;b.js', 'may only contain'],
    ['a&b.js', 'may only contain'],
    ['a|b.js', 'may only contain'],
    ['a b.js', 'may only contain'],
    ['$(x).js', 'may only contain'],
    ['test\\a.js', 'may only contain'],
    ['test//a.js', 'empty segments'],
    ['missing.test.js', 'does not exist'],
  ])('rejects %s', (testPath, reason) => {
    const dir = project('node --test');
    const checked = validateTestPath(testPath, dir);
    expect(checked.ok).toBe(false);
    expect(checked.ok ? '' : checked.reason).toContain(reason);
  });

  it('rejects a link whose real path leaves the workspace', (ctx) => {
    const dir = project('node --test');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    try {
      fs.symlinkSync(outside, path.join(dir, 'escape'), 'junction');
    } catch {
      ctx.skip();
    }
    const checked = validateTestPath('escape', dir);
    expect(checked.ok).toBe(false);
    expect(checked.ok ? '' : checked.reason).toContain('inside the workspace');
  });

  it('a rejected testPath never runs anything', async () => {
    let spawned = false;
    const result = await runProjectTests('s', project('node --test'), { testPath: '../x' }, {
      spawn: () => { spawned = true; throw new Error('must not spawn'); },
    });
    expect(result.status).toBe('rejected');
    expect(spawned).toBe(false);
  });
});

describe('execution', () => {
  it('runs npm test without a shell, with CI and no colour, and nothing the agent chose', async () => {
    const dir = project('node --test', { 'a.test.mjs': PASSING });
    const calls: Array<{ command: string; args: readonly string[]; shell: unknown; env: NodeJS.ProcessEnv | undefined; cwd: unknown }> = [];
    const result = await runProjectTests(
      's',
      dir,
      // Fields outside the contract are ignored, whatever they say.
      { command: 'rm -rf /', args: ['--evil'], cwd: 'C:/', shell: true } as never,
      {
        spawn: (command, args, options) => {
          calls.push({ command, args, shell: options.shell, env: options.env, cwd: options.cwd });
          return nodeSpawn(command, args, options);
        },
      },
    );
    expect(result.status).toBe('passed');
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.shell).toBe(false);
    expect(path.basename(call.command).toLowerCase()).toMatch(/^node(\.exe)?$/);
    expect(call.args[0].endsWith(path.join('npm', 'bin', 'npm-cli.js'))).toBe(true);
    expect(call.args.slice(1)).toEqual(['test']);
    expect(call.cwd).toBe(dir);
    expect(call.env?.CI).toBe('1');
    expect(call.env?.FORCE_COLOR).toBe('0');
  });

  it('passed: exit code 0, command, duration and output', async () => {
    const result = await runProjectTests('s', project('node --test', { 'a.test.mjs': PASSING }), {});
    expect(result).toMatchObject({ status: 'passed', exitCode: 0, command: 'npm test', truncated: false });
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.stdout).toContain('pass 1');
  });

  it('failed: a failing suite keeps its non-zero exit code', async () => {
    const result = await runProjectTests('s', project('node --test', { 'a.test.mjs': FAILING }), {});
    expect(result.status).toBe('failed');
    expect(result.exitCode).not.toBe(0);
  });

  it('preserves the exact exit code of the test script', async () => {
    const result = await runProjectTests('s', project('node exit3.js', { 'exit3.js': 'process.exit(3);\n' }), {});
    expect(result).toMatchObject({ status: 'failed', exitCode: 3 });
  });

  it('testPath narrows the run to that file', async () => {
    const dir = project('node --test', { 'test/ok.test.mjs': PASSING, 'test/bad.test.mjs': FAILING });
    expect((await runProjectTests('s', dir, {})).status).toBe('failed');
    const narrowed = await runProjectTests('s', dir, { testPath: 'test/ok.test.mjs' });
    expect(narrowed).toMatchObject({ status: 'passed', command: 'npm test -- test/ok.test.mjs' });
  });

  it('truncates a huge output but keeps its beginning and its end', async () => {
    const big = "process.stdout.write('START-' + 'x'.repeat(200000) + '-END');\n";
    const result = await runProjectTests('s', project('node big.js', { 'big.js': big }), {});
    expect(result.status).toBe('passed');
    expect(result.truncated).toBe(true);
    expect(result.stdout).toContain('START-');
    expect(result.stdout).toContain('-END');
    expect(result.stdout).toContain('characters omitted');
    expect(result.stdout!.length).toBeLessThan(60_000);
  });
});

describe('limits', () => {
  // The test script starts a grandchild that records its pid and never exits.
  const SLEEPER = {
    'parent.js': [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['grandchild.js'], { stdio: 'ignore' });",
      "require('node:fs').writeFileSync('grandchild.pid', String(child.pid));",
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'),
    'grandchild.js': 'setInterval(() => {}, 1000);\n',
  };

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (check()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return check();
  }

  it('times out and terminates the whole process tree', async () => {
    const dir = project('node parent.js', SLEEPER);
    const result = await runProjectTests('s', dir, { timeoutSeconds: 3 });
    expect(result.status).toBe('timed_out');
    const pid = Number(fs.readFileSync(path.join(dir, 'grandchild.pid'), 'utf8'));
    expect(pid).toBeGreaterThan(0);
    expect(await waitFor(() => !isAlive(pid), 8000)).toBe(true);
  }, 30_000);

  it('a second concurrent run for the same session is busy; another session is not blocked', async () => {
    const dir = project('node parent.js', SLEEPER);
    const first = runProjectTests('same', dir, { timeoutSeconds: 3 });
    const second = await runProjectTests('same', dir, {});
    expect(second.status).toBe('busy');
    const other = await runProjectTests('other', project('node --test', { 'a.test.mjs': PASSING }), {});
    expect(other.status).toBe('passed');
    expect((await first).status).toBe('timed_out');
    const pid = Number(fs.readFileSync(path.join(dir, 'grandchild.pid'), 'utf8'));
    await waitFor(() => !isAlive(pid), 8000);
    // The lock is released afterwards.
    expect((await runProjectTests('same', project('node --test', { 'a.test.mjs': PASSING }), {})).status).toBe('passed');
  }, 40_000);

  it('caps the timeout at 300 seconds and ignores nonsense values', async () => {
    let timeoutSeen = 0;
    const realSetTimeout = global.setTimeout;
    const spy = ((fn: () => void, ms?: number) => {
      if (typeof ms === 'number' && ms >= 1000) timeoutSeen = Math.max(timeoutSeen, ms);
      return realSetTimeout(fn, ms);
    }) as typeof setTimeout;
    global.setTimeout = spy;
    try {
      await runProjectTests('s', project('node --test', { 'a.test.mjs': PASSING }), { timeoutSeconds: 99999 });
      expect(timeoutSeen).toBe(300_000);
      timeoutSeen = 0;
      await runProjectTests('s', project('node --test', { 'a.test.mjs': PASSING }), { timeoutSeconds: 'x' });
      expect(timeoutSeen).toBe(120_000);
    } finally {
      global.setTimeout = realSetTimeout;
    }
  }, 30_000);
});

describe('HeadTailCollector', () => {
  it('returns short streams untouched', () => {
    const collector = new HeadTailCollector(10);
    collector.push('abc');
    collector.push('def');
    expect(collector.result()).toEqual({ text: 'abcdef', truncated: false });
  });

  it('keeps the head and the tail across chunks and counts what it dropped', () => {
    const collector = new HeadTailCollector(10);
    for (const chunk of ['01234', '56789', 'ABCDE', 'FGHIJ']) collector.push(chunk);
    const { text, truncated } = collector.result();
    expect(truncated).toBe(true);
    expect(text.startsWith('01234')).toBe(true);
    expect(text.endsWith('FGHIJ')).toBe(true);
    expect(text).toContain('[10 characters omitted]');
  });
});
