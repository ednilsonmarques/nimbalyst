import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { debugSwitchesToRemove, DEBUG_SWITCHES } from '../remoteDebugging';

/**
 * NIB.85 stage d2 / decision U8: a packaged app strips debugging switches that
 * arrive on its command line (remote debugging, node inspector) and starts
 * normally. Unpackaged (development) builds are left alone.
 */
describe('debugSwitchesToRemove', () => {
  const exe = 'C:\\Program Files\\Nimbalyst\\Nimbalyst.exe';

  it('does nothing in an unpackaged build', () => {
    expect(debugSwitchesToRemove({ isPackaged: false, argv: [exe, '--remote-debugging-port=9222', '--inspect=9229'] })).toEqual([]);
  });

  it('lists the debugging switches present on a packaged command line, with or without a value', () => {
    const argv = [exe, '--remote-debugging-port=9222', '--remote-debugging-pipe', '--inspect', '--inspect-brk=9230', '--inspect-port=9231', '--workspace', 'C:\\w'];
    expect(debugSwitchesToRemove({ isPackaged: true, argv }).sort()).toEqual(
      ['inspect', 'inspect-brk', 'inspect-port', 'remote-debugging-pipe', 'remote-debugging-port'].sort(),
    );
  });

  it('also catches the companion switches that make a debug port reachable', () => {
    const argv = [exe, '--remote-debugging-address=0.0.0.0', '--remote-allow-origins=*'];
    expect(debugSwitchesToRemove({ isPackaged: true, argv }).sort()).toEqual(['remote-allow-origins', 'remote-debugging-address']);
  });

  it('returns each switch once even when repeated', () => {
    expect(debugSwitchesToRemove({ isPackaged: true, argv: [exe, '--inspect=1', '--inspect=2'] })).toEqual(['inspect']);
  });

  it('ignores unrelated switches, values that look like switches and lookalike names', () => {
    const argv = [exe, '--workspace', '--inspect', '--inspector-theme=dark', '--remote-debugging-portal', '--user-data-dir=C:\\x\\--inspect'];
    // "--workspace" consumed nothing; only the exact "--inspect" counts.
    expect(debugSwitchesToRemove({ isPackaged: true, argv })).toEqual(['inspect']);
  });

  describe('Windows command-line forms (Chromium accepts - and / as well as --)', () => {
    it('recognises -name, -name=value, /name and /name=value, case-insensitively', () => {
      expect(debugSwitchesToRemove({ isPackaged: true, platform: 'win32', argv: [exe, '-remote-debugging-port=9222', '/inspect'] }).sort()).toEqual(['inspect', 'remote-debugging-port']);
      expect(debugSwitchesToRemove({ isPackaged: true, platform: 'win32', argv: [exe, '/remote-debugging-pipe', '-inspect-brk=9230'] }).sort()).toEqual(['inspect-brk', 'remote-debugging-pipe']);
      expect(debugSwitchesToRemove({ isPackaged: true, platform: 'win32', argv: [exe, '/Remote-Debugging-Port=9222', '-INSPECT-PORT=1'] }).sort()).toEqual(['inspect-port', 'remote-debugging-port']);
      expect(debugSwitchesToRemove({ isPackaged: true, platform: 'win32', argv: [exe, '/remote-allow-origins=*', '-remote-debugging-address=0.0.0.0'] }).sort()).toEqual(['remote-allow-origins', 'remote-debugging-address']);
    });

    it('finds each switch once across all four spellings', () => {
      expect(debugSwitchesToRemove({ isPackaged: true, platform: 'win32', argv: [exe, '--inspect', '-inspect=1', '/inspect', '/inspect=2'] })).toEqual(['inspect']);
    });

    it('still stops at "--" and ignores lookalikes, values and file paths', () => {
      expect(debugSwitchesToRemove({ isPackaged: true, platform: 'win32', argv: [exe, '--', '/inspect', '-remote-debugging-port=1'] })).toEqual([]);
      expect(debugSwitchesToRemove({ isPackaged: true, platform: 'win32', argv: [exe, '-inspector', '/inspect-foo', '/remote-debugging-portal=1', 'C:\work\inspect', '/tmp/inspect'] })).toEqual([]);
      expect(debugSwitchesToRemove({ isPackaged: true, platform: 'win32', argv: [exe, '/inspect/extra'] })).toEqual([]);
    });

    it('on other platforms "-name" still counts but "/name" is a path, not a switch', () => {
      expect(debugSwitchesToRemove({ isPackaged: true, platform: 'linux', argv: ['/usr/bin/app', '-inspect=1', '/inspect', '/remote-debugging-port=9'] })).toEqual(['inspect']);
    });

    it('does nothing when unpackaged, in any spelling', () => {
      expect(debugSwitchesToRemove({ isPackaged: false, platform: 'win32', argv: [exe, '-remote-debugging-port=9222', '/inspect'] })).toEqual([]);
    });
  });

  it('stops reading at the "--" terminator', () => {
    expect(debugSwitchesToRemove({ isPackaged: true, argv: [exe, '--', '--inspect'] })).toEqual([]);
  });

  it('is case-insensitive about the switch name (Windows launchers vary)', () => {
    expect(debugSwitchesToRemove({ isPackaged: true, argv: [exe, '--Remote-Debugging-Port=9222'] })).toEqual(['remote-debugging-port']);
  });

  it('exposes the list it removes', () => {
    expect(DEBUG_SWITCHES).toContain('remote-debugging-port');
    expect(DEBUG_SWITCHES).toContain('inspect');
  });
});

describe('bootstrap wiring', () => {
  const bootstrap = fs.readFileSync(path.resolve(__dirname, '..', 'bootstrap.ts'), 'utf8');

  it('removes the switches (with app.isPackaged) before the main process module is imported', () => {
    const call = bootstrap.search(/debugSwitchesToRemove\(\s*\{\s*isPackaged:\s*app\.isPackaged/);
    const remove = bootstrap.search(/app\.commandLine\.removeSwitch\(/);
    const importIndex = bootstrap.search(/import\s+['"]\.\/index\.js['"]/);
    expect(call).toBeGreaterThan(-1);
    expect(remove).toBeGreaterThan(call);
    expect(importIndex).toBeGreaterThan(remove);
  });

  it('does not report --inspect* as removed: it logs that a packaged build ignores them because of the fuse', () => {
    expect(bootstrap).toMatch(/filter\(\(name\) => !name\.startsWith\('inspect'\)\)/);
    expect(bootstrap).toMatch(/EnableNodeCliInspectArguments/);
    expect(bootstrap).toMatch(/packaged build ignores them because the EnableNodeCliInspectArguments fuse is disabled/);
    expect(bootstrap).toMatch(/does not remove them or enforce that/);
    expect(bootstrap).not.toMatch(/does not close the inspector/);
  });
});
