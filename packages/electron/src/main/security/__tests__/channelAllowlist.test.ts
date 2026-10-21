/**
 * NIB.85 stage d3 (LOG-ONLY, decision U6): the channel list is derived from the
 * source by scripts/ipc-channel-allowlist.mjs and checked in. These tests keep
 * the checked-in file honest and pin the run-time observer to "log, never block".
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// @ts-expect-error plain ESM script, no type declarations
import { deriveAllowlist, serialize, comparableList, REPO_ROOT, OUTPUT_FILE } from '../../../../../../scripts/ipc-channel-allowlist.mjs';
import { isAllowlistedChannel, type IpcChannelAllowlist } from '../../../shared/ipcChannelAllowlist';
import { createChannelAllowlistObserver } from '../channelAllowlistMonitor';
import allowlistJson from '../../../shared/ipcChannelAllowlist.json';

const checkedIn = allowlistJson as unknown as IpcChannelAllowlist;

describe('checked-in channel list', () => {
  it('matches what the script derives from the source today on channels, dynamicPrefixes and listen (a new literal call site fails this)', () => {
    const onDisk = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, OUTPUT_FILE), 'utf8'));
    expect(comparableList(onDisk)).toEqual(comparableList(deriveAllowlist(REPO_ROOT)));
  });

  it('does not depend on stats, registeredNotListed or unresolved file:line (they change with unrelated edits)', () => {
    const derived = deriveAllowlist(REPO_ROOT);
    const noisy = { ...derived, stats: { ...derived.stats, unresolvedCallSites: -1 }, registeredNotListed: ['x:y'], unresolved: ['some/file.ts:1 invoke(channel)'] };
    expect(comparableList(noisy)).toEqual(comparableList(derived));
    expect(comparableList({ ...derived, channels: [...derived.channels, 'brand:new'] })).not.toEqual(comparableList(derived));
    expect(comparableList({ ...derived, dynamicPrefixes: [] })).not.toEqual(comparableList(derived));
    expect(comparableList({ ...derived, listen: [] })).not.toEqual(comparableList(derived));
  });

  it('lists well-known channels, their dynamic prefixes and the preload wrappers', () => {
    expect(checkedIn.channels).toContain('console-log');
    expect(checkedIn.channels).toContain('extension:exec');
    expect(checkedIn.channels).toContain('database:executeQuery');
    expect(checkedIn.channels).toContain('extension:file-storage:write');
    expect(checkedIn.dynamicPrefixes).toEqual(expect.arrayContaining(['git:', 'tracker:importer:', 'tracker-body:apply-markdown-result:']));
    expect(checkedIn.channels.length).toBeGreaterThan(900);
  });
});

describe('deriveAllowlist on a synthetic tree', () => {
  function makeTree(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-allowlist-'));
    for (const [rel, body] of Object.entries(files)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body);
    }
    return root;
  }

  it('finds literals, IDENT.key and IDENT constants, template prefixes and listeners; reports the rest', () => {
    const root = makeTree({
      'packages/electron/src/shared/channels.ts':
        "export const ISLAND_CHANNELS = { open: 'island:open', close: 'island:close' } as const;\nexport const READY_CHANNEL = 'host:ready';\n",
      'packages/electron/src/preload/index.ts': [
        "ipcRenderer.invoke('a:literal');",
        "ipcRenderer.send('b:send-literal', 1);",
        "ipcRenderer.on('main:to-renderer', cb);",
        "window.electronAPI.invoke(`git:${action}`);",
        "window.electronAPI.send(ISLAND_CHANNELS.open);",
        "window.electronAPI.send(READY_CHANNEL);",
        "window.electronAPI.invoke(computed);",
        "someSocket.send('not-a-channel');",
      ].join('\n'),
      'packages/extensions/demo/src/index.ts': "window.electronAPI.invoke('ext:demo');",
      'packages/electron/src/main/reply.ts':
        "const responseChannel = `tracker-body:result:${id}`;\nsafeHandle('a:literal', () => 1);\nsafeHandle('only:in-main', () => 1);\n",
      'packages/electron/src/renderer/__tests__/ignored.test.ts': "window.electronAPI.invoke('tests:ignored');",
    });
    const result = deriveAllowlist(root);
    expect(result.channels).toEqual(['a:literal', 'b:send-literal', 'ext:demo', 'host:ready', 'island:open']);
    expect(result.listen).toEqual(['main:to-renderer']);
    expect(result.dynamicPrefixes).toEqual(expect.arrayContaining(['git:', 'tracker-body:result:']));
    expect(result.channels).not.toContain('tests:ignored');
    expect(result.channels).not.toContain('not-a-channel');
    expect(result.unresolved.some((u: string) => u.includes('invoke(computed)'))).toBe(true);
    expect(result.registeredNotListed).toEqual(['only:in-main']);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('a literal call site that is missing from a stored list is detected by comparison', () => {
    const root = makeTree({ 'packages/electron/src/preload/index.ts': "ipcRenderer.invoke('new:channel');" });
    const derived = serialize(deriveAllowlist(root));
    const stale = derived.replace('"new:channel"', '"other:channel"');
    expect(stale).not.toBe(derived);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('isAllowlistedChannel', () => {
  const list: IpcChannelAllowlist = { channels: ['a:b', 'c'], dynamicPrefixes: ['git:', 'resp-'], listen: [] };

  it('accepts listed channels and channels under a dynamic prefix', () => {
    expect(isAllowlistedChannel('a:b', list)).toBe(true);
    expect(isAllowlistedChannel('c', list)).toBe(true);
    expect(isAllowlistedChannel('git:status', list)).toBe(true);
    expect(isAllowlistedChannel('resp-123', list)).toBe(true);
  });

  it('does not accept anything else, including near misses', () => {
    expect(isAllowlistedChannel('a:b2', list)).toBe(false);
    expect(isAllowlistedChannel('gitx:status', list)).toBe(false);
    expect(isAllowlistedChannel('', list)).toBe(false);
  });
});

describe('createChannelAllowlistObserver (log-only)', () => {
  const list: IpcChannelAllowlist = { channels: ['known:one'], dynamicPrefixes: ['dyn:'], listen: [] };

  it('logs an unlisted channel once and never throws or returns a verdict', () => {
    const log = vi.fn();
    const observe = createChannelAllowlistObserver(list, { log, cap: 10 });
    expect(observe('known:one')).toBeUndefined();
    expect(observe('dyn:anything')).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
    expect(observe('mystery:channel')).toBeUndefined();
    observe('mystery:channel');
    observe('mystery:channel');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('mystery:channel');
    expect(log.mock.calls[0][0]).toMatch(/not on the allowlist/);
  });

  it('is bounded: after the cap it stops logging new channels and says so once', () => {
    const log = vi.fn();
    const observe = createChannelAllowlistObserver(list, { log, cap: 3 });
    for (let i = 0; i < 20; i += 1) observe(`unknown:${i}`);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => /unknown:\d+/.test(l)).length).toBe(3);
    expect(lines.filter((l) => /limit/i.test(l)).length).toBe(1);
  });

  it('does not let listed channels use up the unlisted-channel cap', () => {
    const big: IpcChannelAllowlist = { channels: Array.from({ length: 300 }, (_, i) => `listed:${i}`), dynamicPrefixes: [], listen: [] };
    const log = vi.fn();
    const observe = createChannelAllowlistObserver(big, { log, cap: 5 });
    for (let i = 0; i < 300; i += 1) observe(`listed:${i}`);
    observe('unlisted:first');
    observe('unlisted:second');
    expect(log).toHaveBeenCalledTimes(2);
    expect(String(log.mock.calls[0][0])).toContain('unlisted:first');
  });

  it('does not remember every channel that matches a dynamic prefix (they carry unique ids)', () => {
    const dyn: IpcChannelAllowlist = { channels: ['known:one'], dynamicPrefixes: ['resp-'], listen: [] };
    const log = vi.fn();
    const observe = createChannelAllowlistObserver(dyn, { log, cap: 5 });
    for (let i = 0; i < 5000; i += 1) observe(`resp-${i}`);
    observe('known:one');
    expect(log).not.toHaveBeenCalled();
    expect(observe.trackedChannels()).toBe(0);
    observe('mystery:a');
    expect(observe.trackedChannels()).toBe(1);
  });

  it('survives a logger that throws', () => {
    const observe = createChannelAllowlistObserver(list, { log: () => { throw new Error('boom'); }, cap: 3 });
    expect(() => observe('unknown:x')).not.toThrow();
  });
});
