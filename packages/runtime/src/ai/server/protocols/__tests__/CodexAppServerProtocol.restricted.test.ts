// @vitest-environment node
/**
 * A restricted Team mode thread through the real protocol against a fake
 * codex child (NIB.46 items 7.2, 7.5, 7.8): the child is spawned with the
 * process-level `-c` overrides, its effective configuration is read and
 * verified before any thread exists, the thread/start echo (approval policy,
 * sandbox, model) and the CLI version are verified, and every violation ends
 * the session with the child killed and no thread.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => {
  const spawn = (...args: unknown[]) => (args[0] === 'taskkill.exe' ? Object.assign(new EventEmitter(), { unref: () => {} }) : spawnMock(...args));
  return { spawn, default: { spawn } };
});
vi.mock('../codexAppServer/codexAppServerBinary', () => ({
  resolveCodexBinaryPath: () => '/fake/codex',
  getCodexVendorPathEntries: () => [],
}));

import { CodexAppServerProtocol } from '../CodexAppServerProtocol';
import { verifyRestrictedCodexEffectiveConfig } from '../../providers/codex/codexRestrictedProcess';

class FakeChildProcess extends EventEmitter {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly writtenLines: Array<Record<string, unknown>> = [];
  readonly pid = 4242;
  killed = false;
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    let buffer = '';
    this.stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try { this.writtenLines.push(JSON.parse(line)); } catch { this.writtenLines.push({ __unparseable: line }); }
      }
    });
  }
  emitLine(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
  kill(): boolean {
    if (this.killed) return false;
    this.killed = true;
    this.emit('exit', 0, null);
    return true;
  }
}

function nextWrittenMatching(child: FakeChildProcess, method: string, timeoutMs = 1500): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const seen = new Set<unknown>();
    const started = Date.now();
    const tick = () => {
      for (const line of child.writtenLines) {
        if (line.method === method && !seen.has(line)) { resolve(line); return; }
      }
      if (Date.now() - started > timeoutMs) { reject(new Error(`timeout waiting for ${method}; saw ${JSON.stringify(child.writtenLines)}`)); return; }
      setTimeout(tick, 5);
    };
    tick();
  });
}

const RESTRICTED_EFFECTIVE = {
  notify: [], hooks: {}, web_search: 'disabled', features: { multi_agent: false, shell_tool: false, unified_exec: false },
  mcp_servers: { node_repl: { enabled: false }, nimbalyst: { url: 'http://127.0.0.1:1/mcp/core' } },
  plugins: { 'browser@openai-bundled': { enabled: false } },
};
const GOOD_START = { thread: { id: 'thread-restricted', cliVersion: '0.159.2', model: 'gpt-6.1-sol' }, approvalPolicy: 'untrusted', sandbox: { type: 'readOnly', networkAccess: false }, model: 'gpt-6.1-sol' };

function restrictedOptions(overrides: Record<string, unknown> = {}) {
  return {
    workspacePath: '/tmp/ws',
    model: 'gpt-6.1-sol',
    raw: {
      restrictedToolScope: 'read',
      restrictedExpectedModel: 'gpt-6.1-sol',
      restrictedUserTables: { mcpServerNames: ['node_repl'], pluginIds: ['browser@openai-bundled'] },
      codexProcessOverrides: ['features.shell_tool=false', 'features.unified_exec=false', 'notify=[]', 'hooks={}', 'web_search="disabled"', 'features.multi_agent=false', 'mcp_servers={"node_repl"={enabled=false}}', 'plugins={"browser@openai-bundled"={enabled=false}}'],
      codexConfigOverrides: { web_search: 'disabled' },
      ...overrides,
    },
  };
}

let child: FakeChildProcess;

beforeEach(() => {
  child = new FakeChildProcess();
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => child);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function answerInit(effective: unknown = RESTRICTED_EFFECTIVE, hooks: unknown = { data: [{ cwd: '/tmp/ws', hooks: [], warnings: [], errors: [] }] }, target: FakeChildProcess = child): Promise<void> {
  const init = await nextWrittenMatching(target, 'initialize');
  target.emitLine({ id: init.id, result: { codexHome: '/fake', platformFamily: 'windows', platformOs: 'windows', userAgent: 'nimbalyst/0.159.2 (Windows)' } });
  const read = await nextWrittenMatching(target, 'config/read');
  target.emitLine({ id: read.id, result: { config: effective } });
  if (verifyRestrictedCodexEffectiveConfig(effective).length > 0) return;
  const list = await nextWrittenMatching(target, 'hooks/list');
  target.emitLine({ id: list.id, result: hooks });
}

describe('restricted thread: process overrides and effective configuration', () => {
  it('spawns the child with every -c override, verifies config/read, then starts the thread and accepts a faithful echo', async () => {
    const protocol = new CodexAppServerProtocol({ terminateProcessTreeOverride: (target) => target.kill() });
    const pending = protocol.createSession(restrictedOptions() as never);
    await answerInit();
    const spawnArgs = spawnMock.mock.calls[0]![1] as string[];
    expect(spawnArgs.slice(0, 3)).toEqual(['app-server', '--listen', 'stdio://']);
    expect(spawnArgs.slice(3)).toEqual(['-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false', '-c', 'notify=[]', '-c', 'hooks={}', '-c', 'web_search="disabled"', '-c', 'features.multi_agent=false', '-c', 'mcp_servers={"node_repl"={enabled=false}}', '-c', 'plugins={"browser@openai-bundled"={enabled=false}}']);
    // hooks/list is asked for the workspace before any thread exists.
    expect(child.writtenLines.some((line) => line.method === 'hooks/list' && JSON.stringify(line.params) === JSON.stringify({ cwds: ['/tmp/ws'] }))).toBe(true);
    // config/read comes before thread/start; nothing else was asked of the child in between.
    const methods = child.writtenLines.map((line) => line.method);
    expect(methods.indexOf('config/read')).toBeGreaterThan(methods.indexOf('initialized'));
    expect(methods).not.toContain('thread/start');
    const start = await nextWrittenMatching(child, 'thread/start');
    expect((start.params as Record<string, unknown>).sandbox).toBe('read-only');
    expect((start.params as Record<string, unknown>).approvalPolicy).toBe('untrusted');
    child.emitLine({ id: start.id, result: GOOD_START });
    const session = await pending;
    expect(session.id).toBe('thread-restricted');
    expect(child.killed).toBe(false);
  });

  it('a child whose effective configuration still enables anything is killed before any thread exists', async () => {
    const protocol = new CodexAppServerProtocol({ terminateProcessTreeOverride: (target) => target.kill() });
    const pending = protocol.createSession(restrictedOptions() as never);
    await answerInit({ ...RESTRICTED_EFFECTIVE, notify: ['codex-computer-use.exe', 'turn-ended'], mcp_servers: { node_repl: { enabled: true } } });
    await expect(pending).rejects.toThrow(/the Codex process did not take the restricted configuration \(notify is not empty; mcp_servers\.node_repl is still enabled\)\. No turn was run/);
    expect(child.killed).toBe(true);
    expect(child.writtenLines.some((line) => line.method === 'thread/start')).toBe(false);
    // A violation other than enablement never respawns.
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('a config/read that fails is a refusal too (fail-closed)', async () => {
    const protocol = new CodexAppServerProtocol({ terminateProcessTreeOverride: (target) => target.kill() });
    const pending = protocol.createSession(restrictedOptions() as never);
    const init = await nextWrittenMatching(child, 'initialize');
    child.emitLine({ id: init.id, result: { codexHome: '/fake', platformFamily: 'windows', platformOs: 'windows', userAgent: 'nimbalyst/0.159.2' } });
    const read = await nextWrittenMatching(child, 'config/read');
    child.emitLine({ id: read.id, error: { code: -32601, message: 'method not found' } });
    await expect(pending).rejects.toThrow(/config\/read failed/);
    expect(child.killed).toBe(true);
  });

  it('an unrestricted session is spawned and started exactly as before: no -c, no config/read, no echo check', async () => {
    const protocol = new CodexAppServerProtocol({ terminateProcessTreeOverride: (target) => target.kill() });
    const pending = protocol.createSession({ workspacePath: '/tmp/ws', model: 'gpt-6.1-sol', raw: {} } as never);
    const init = await nextWrittenMatching(child, 'initialize');
    child.emitLine({ id: init.id, result: { codexHome: '/fake', platformFamily: 'windows', platformOs: 'windows', userAgent: 'fake/0' } });
    const start = await nextWrittenMatching(child, 'thread/start');
    child.emitLine({ id: start.id, result: { thread: { id: 'plain' }, sandbox: { type: 'workspaceWrite' } } });
    const session = await pending;
    expect(session.id).toBe('plain');
    expect((spawnMock.mock.calls[0]![1] as string[])).toEqual(['app-server', '--listen', 'stdio://']);
    expect(child.writtenLines.some((line) => line.method === 'config/read')).toBe(false);
  });
});

describe('restricted thread: single respawn for user entries the disabled set missed', () => {
  // A plugin bundled with Codex that no config file names (pilot G, 2026-10-14).
  const MISSED_PLUGIN = { ...RESTRICTED_EFFECTIVE, plugins: { 'browser@openai-bundled': { enabled: false }, 'computer-use@openai-bundled': { enabled: true } } };
  const COMPLETED_PLUGINS = '-c plugins={"browser@openai-bundled"={enabled=false},"computer-use@openai-bundled"={enabled=false}}';

  function queueChildren(...children: FakeChildProcess[]): void {
    spawnMock.mockReset();
    for (const next of children) spawnMock.mockImplementationOnce(() => next);
    // A third spawn would get this child; the tests assert it never happens.
    spawnMock.mockImplementation(() => new FakeChildProcess());
  }

  it('respawns once with the missed entry added to the disabled set, verifies again, and starts the thread on the second child', async () => {
    const first = new FakeChildProcess();
    const second = new FakeChildProcess();
    queueChildren(first, second);
    const protocol = new CodexAppServerProtocol({ terminateProcessTreeOverride: (target) => target.kill() });
    const pending = protocol.createSession(restrictedOptions() as never);
    await answerInit(MISSED_PLUGIN, undefined, first);
    await answerInit(RESTRICTED_EFFECTIVE, undefined, second);
    const start = await nextWrittenMatching(second, 'thread/start');
    second.emitLine({ id: start.id, result: GOOD_START });
    await expect(pending).resolves.toMatchObject({ id: 'thread-restricted' });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(first.killed).toBe(true);
    expect(first.writtenLines.some((line) => line.method === 'hooks/list' || line.method === 'thread/start')).toBe(false);
    const secondArgs = (spawnMock.mock.calls[1]![1] as string[]).join(' ');
    expect(secondArgs).toContain(COMPLETED_PLUGINS);
    expect(secondArgs).toContain('-c mcp_servers={"node_repl"={enabled=false}}');
    expect(second.killed).toBe(false);
  });

  it('a second child that still shows an enabled entry is refused, and there is no third attempt', async () => {
    const first = new FakeChildProcess();
    const second = new FakeChildProcess();
    queueChildren(first, second);
    const protocol = new CodexAppServerProtocol({ terminateProcessTreeOverride: (target) => target.kill() });
    const pending = protocol.createSession(restrictedOptions() as never);
    await answerInit(MISSED_PLUGIN, undefined, first);
    await answerInit(MISSED_PLUGIN, undefined, second);
    await expect(pending).rejects.toThrow(/Restricted Team mode member refused: the Codex process did not take the restricted configuration \(plugins\.computer-use@openai-bundled is still enabled\)\. No turn was run/);

    expect(first.killed).toBe(true);
    expect(second.killed).toBe(true);
    for (const target of [first, second]) {
      expect(target.writtenLines.some((line) => line.method === 'thread/start')).toBe(false);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('thread/resume takes the same single respawn', async () => {
    const first = new FakeChildProcess();
    const second = new FakeChildProcess();
    queueChildren(first, second);
    const protocol = new CodexAppServerProtocol({ terminateProcessTreeOverride: (target) => target.kill() });
    const pending = protocol.resumeSession('thread-restricted', restrictedOptions() as never);
    await answerInit(MISSED_PLUGIN, undefined, first);
    await answerInit(RESTRICTED_EFFECTIVE, undefined, second);
    const resume = await nextWrittenMatching(second, 'thread/resume');
    second.emitLine({ id: resume.id, result: GOOD_START });
    await expect(pending).resolves.toBeDefined();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect((spawnMock.mock.calls[1]![1] as string[]).join(' ')).toContain(COMPLETED_PLUGINS);
  });
});

describe('restricted thread: hooks and the shell switch', () => {
  it('a hook the workspace would still run (a project hook file, a leftover) refuses the child before any thread exists', async () => {
    const protocol = new CodexAppServerProtocol({ terminateProcessTreeOverride: (target) => target.kill() });
    const pending = protocol.createSession(restrictedOptions() as never);
    await answerInit(RESTRICTED_EFFECTIVE, { data: [{ cwd: '/tmp/ws', hooks: [{ eventName: 'preToolUse', command: 'curl evil' }] }] });
    await expect(pending).rejects.toThrow(/1 hook\(s\) would run for \/tmp\/ws/);
    expect(child.killed).toBe(true);
    expect(child.writtenLines.some((line) => line.method === 'thread/start')).toBe(false);
  });

  it('a child whose shell tool is still on is refused (the -c switch did not take)', async () => {
    const protocol = new CodexAppServerProtocol({ terminateProcessTreeOverride: (target) => target.kill() });
    const pending = protocol.createSession(restrictedOptions() as never);
    await answerInit({ ...RESTRICTED_EFFECTIVE, features: { multi_agent: false } });
    await expect(pending).rejects.toThrow(/features\.shell_tool is not false; features\.unified_exec is not false/);
    expect(child.killed).toBe(true);
  });
});

describe('restricted thread: thread/start echo and CLI version', () => {
  it.each([
    ['approval policy', { ...GOOD_START, approvalPolicy: 'never' }, /approvalPolicy is "never", not "untrusted"/],
    // The pre-existing sandbox validation refuses this one first; either refusal ends the session.
    ['sandbox', { ...GOOD_START, sandbox: { type: 'workspaceWrite' } }, /incompatible sandbox policy|sandbox is "workspaceWrite", not readOnly/],
    ['network', { ...GOOD_START, sandbox: { type: 'readOnly', networkAccess: true } }, /sandbox grants network access/],
    ['model', { ...GOOD_START, model: 'gpt-5.5', thread: { ...GOOD_START.thread, model: 'gpt-5.5' } }, /model is "gpt-5\.5", not "gpt-6\.1-sol"/],
    ['old CLI', { ...GOOD_START, thread: { ...GOOD_START.thread, cliVersion: '0.150.0' } }, /Codex CLI 0\.150\.0 is older than the minimum 0\.159\.1/],
  ])('a thread/start echo that does not match the restriction (%s) ends the session with the child killed', async (_label, echo, expected) => {
    const protocol = new CodexAppServerProtocol({ terminateProcessTreeOverride: (target) => target.kill() });
    const pending = protocol.createSession(restrictedOptions() as never);
    await answerInit();
    const start = await nextWrittenMatching(child, 'thread/start');
    child.emitLine({ id: start.id, result: echo });
    await expect(pending).rejects.toThrow(expected);
    expect(child.killed).toBe(true);
    expect(child.writtenLines.some((line) => line.method === 'turn/start')).toBe(false);
  });

  it('without a thread cliVersion the initialize user agent decides; no version anywhere is a refusal', async () => {
    const protocol = new CodexAppServerProtocol({ terminateProcessTreeOverride: (target) => target.kill() });
    const pending = protocol.createSession(restrictedOptions() as never);
    await answerInit();
    const start = await nextWrittenMatching(child, 'thread/start');
    child.emitLine({ id: start.id, result: { ...GOOD_START, thread: { id: 't', model: 'gpt-6.1-sol' } } });
    await expect(pending).resolves.toMatchObject({ id: 't' });

    const second = new FakeChildProcess();
    spawnMock.mockImplementation(() => second);
    const protocol2 = new CodexAppServerProtocol({ terminateProcessTreeOverride: (target) => target.kill() });
    const pending2 = protocol2.createSession(restrictedOptions() as never);
    const init = await nextWrittenMatching(second, 'initialize');
    second.emitLine({ id: init.id, result: { codexHome: '/fake', platformFamily: 'windows', platformOs: 'windows', userAgent: 'fake/0' } });
    const read = await nextWrittenMatching(second, 'config/read');
    second.emitLine({ id: read.id, result: { config: RESTRICTED_EFFECTIVE } });
    const list = await nextWrittenMatching(second, 'hooks/list');
    second.emitLine({ id: list.id, result: { data: [{ cwd: '/tmp/ws', hooks: [] }] } });
    const start2 = await nextWrittenMatching(second, 'thread/start');
    second.emitLine({ id: start2.id, result: { ...GOOD_START, thread: { id: 't2', model: 'gpt-6.1-sol' } } });
    await expect(pending2).rejects.toThrow(/the Codex CLI did not report its version/);
    expect(second.killed).toBe(true);
  });

  it('thread/resume of a restricted thread is verified the same way', async () => {
    const protocol = new CodexAppServerProtocol({ terminateProcessTreeOverride: (target) => target.kill() });
    const pending = protocol.resumeSession('thread-restricted', restrictedOptions() as never);
    await answerInit();
    const resume = await nextWrittenMatching(child, 'thread/resume');
    child.emitLine({ id: resume.id, result: { ...GOOD_START, approvalPolicy: 'on-request' } });
    await expect(pending).rejects.toThrow(/approvalPolicy is "on-request", not "untrusted"/);
    expect(child.killed).toBe(true);
  });
});
