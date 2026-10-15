// @vitest-environment node
/**
 * NIB.54: the app-server child dying mid-turn ends the turn as a failure,
 * once, instead of leaving the generator parked forever (the session stayed
 * 'running' with no settle and the coordinator was never woken). A normal
 * turn/completed still wins, a late exit after the turn changes nothing,
 * exit + close fail once, nothing is retried or polled. Fake child as in
 * CodexAppServerProtocol.restricted.test.ts.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => {
  const spawn = (...args: unknown[]) => (args[0] === 'taskkill.exe' ? Object.assign(new EventEmitter(), { unref: () => {} }) : spawnMock(...args));
  return { spawn, default: { spawn } };
});
vi.mock('../codexAppServer/codexAppServerBinary', () => ({
  resolveCodexBinaryPath: () => '/fake/codex',
  getCodexVendorPathEntries: () => [],
}));

import { CodexAppServerExitedError, CodexAppServerProtocol } from '../CodexAppServerProtocol';

class FakeChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly writtenLines: Array<Record<string, unknown>> = [];
  readonly pid = 4343;
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  constructor() {
    super();
    let buffer = '';
    this.stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try { this.writtenLines.push(JSON.parse(line)); } catch { /* ignore */ }
      }
    });
  }
  emitLine(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
  /** The process dies: 'exit' then 'close', as Node emits them. */
  die(code: number | null = null, signal: string | null = 'SIGKILL'): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
  kill(): boolean {
    if (this.killed) return false;
    this.killed = true;
    this.die(null, 'SIGTERM');
    return true;
  }
}

function nextWritten(child: FakeChildProcess, method: string, timeoutMs = 1500): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const seen = new Set<unknown>();
    const started = Date.now();
    const tick = () => {
      for (const line of child.writtenLines) {
        if (line.method === method && !seen.has(line)) { seen.add(line); resolve(line); return; }
      }
      if (Date.now() - started > timeoutMs) { reject(new Error(`timeout waiting for ${method}`)); return; }
      setTimeout(tick, 5);
    };
    tick();
  });
}

let child: FakeChildProcess;
let protocol: CodexAppServerProtocol;

beforeEach(() => {
  child = new FakeChildProcess();
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => child);
  protocol = new CodexAppServerProtocol({ terminateProcessTreeOverride: (target) => target.kill() });
});

/** An ordinary (unrestricted) session on the fake child. */
async function openSession() {
  const pending = protocol.createSession({ workspacePath: '/tmp/ws', model: 'gpt-6.1-sol', raw: {} } as never);
  const init = await nextWritten(child, 'initialize');
  child.emitLine({ id: init.id, result: { codexHome: '/fake', platformFamily: 'windows', platformOs: 'windows', userAgent: 'fake/0' } });
  const start = await nextWritten(child, 'thread/start');
  child.emitLine({ id: start.id, result: { thread: { id: 'thread-1' }, sandbox: { type: 'workspaceWrite' } } });
  return pending;
}

/** Start a turn and answer turn/start; returns the running generator and a collector. */
async function startTurn(session: unknown) {
  const events: Array<Record<string, unknown>> = [];
  let thrown: unknown = null;
  const done = (async () => {
    try {
      for await (const event of protocol.sendMessage(session as never, { content: 'read the code' } as never)) events.push(event as never);
    } catch (error) {
      thrown = error;
    }
  })();
  const turnStart = await nextWritten(child, 'turn/start');
  child.emitLine({ id: turnStart.id, result: { turn: { id: 'turn-1' } } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { events, done, thrown: () => thrown };
}

const listenerCounts = () => ({ exit: child.listenerCount('exit'), close: child.listenerCount('close') });

describe('a Codex child that dies mid-turn ends the turn as a failure (NIB.54)', () => {
  it('1: a normal turn/completed still completes the turn, and a late exit afterwards changes nothing', async () => {
    const session = await openSession();
    const before = listenerCounts();
    const turn = await startTurn(session);
    child.emitLine({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await turn.done;
    expect(turn.events.map((e) => e.type)).toContain('complete');
    expect(turn.thrown()).toBeNull();
    // The turn's exit/close listeners are gone with the turn (7: a late exit cannot fail it).
    expect(listenerCounts()).toEqual(before);
    child.die(1, null);
    expect(turn.events.filter((e) => e.type === 'error')).toHaveLength(0);
  });

  it('2/3: a child killed while the turn runs ends it as a CodexAppServerExitedError, so the session leaves running', async () => {
    const session = await openSession();
    const turn = await startTurn(session);
    child.die(null, 'SIGKILL');
    await turn.done;
    expect(turn.thrown()).toBeInstanceOf(CodexAppServerExitedError);
    expect(String((turn.thrown() as Error).message)).toMatch(/the Codex process exited during the turn \(signal SIGKILL\); the turn did not complete/);
    // The message never reads as a user cancel (the provider treats /abort|cancel/ as one).
    expect(String((turn.thrown() as Error).message)).not.toMatch(/abort|cancel/i);
  });

  it('6: exit followed by close fails the turn once', async () => {
    const session = await openSession();
    const turn = await startTurn(session);
    const failures: unknown[] = [];
    child.die(137, null); // emits exit, then close
    await turn.done.then(() => failures.push(turn.thrown()));
    expect(failures).toHaveLength(1);
    expect(turn.events.filter((e) => e.type === 'error')).toHaveLength(0); // thrown, not also yielded
    expect(String((turn.thrown() as Error).message)).toContain('exit code 137');
  });

  it('a child that dies while turn/start is pending ends the turn the same way', async () => {
    const session = await openSession();
    let thrown: unknown = null;
    const done = (async () => {
      try {
        for await (const _event of protocol.sendMessage(session as never, { content: 'read' } as never)) { /* none */ }
      } catch (error) {
        thrown = error;
      }
    })();
    await nextWritten(child, 'turn/start');
    child.die(null, 'SIGKILL');
    await done;
    expect(thrown).toBeInstanceOf(CodexAppServerExitedError);
  });

  it('a turn that fails normally (turn/completed status failed) still yields its error, not an exit', async () => {
    const session = await openSession();
    const turn = await startTurn(session);
    child.emitLine({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed', error: { message: 'model refused' } } } });
    await turn.done;
    expect(turn.thrown()).toBeNull();
    expect(turn.events.find((e) => e.type === 'error')?.error).toContain('model refused');
  });

  it('8/9: nothing is retried and nothing polls: one spawn, one turn/start, no further requests after the death', async () => {
    const session = await openSession();
    const turn = await startTurn(session);
    const written = child.writtenLines.length;
    child.die(null, 'SIGKILL');
    await turn.done;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(child.writtenLines.filter((line) => line.method === 'turn/start')).toHaveLength(1);
    expect(child.writtenLines.length).toBe(written);
  });
});
