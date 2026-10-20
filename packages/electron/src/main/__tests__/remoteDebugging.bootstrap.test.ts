import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Ties bootstrap.ts to shouldEnableRemoteDebugging. The helper is only a
 * policy if the one place that opens the CDP port actually asks it, and nobody
 * adds a second place that does not.
 */

const MAIN_DIR = path.resolve(__dirname, '..');
const SWITCH = /appendSwitch\(\s*['"`]remote-debugging-port['"`]/g;
const GUARD = /if\s*\(\s*shouldEnableRemoteDebugging\(\s*\{\s*isPackaged:\s*app\.isPackaged\b/g;

/** Index just past the bracket that closes the one opening at `open`, or -1. */
function matchClose(src: string, open: number, o: string, c: string): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === o) depth++;
    else if (src[i] === c && --depth === 0) return i + 1;
  }
  return -1;
}

/** [start, end) of every `if (shouldEnableRemoteDebugging({ isPackaged: app.isPackaged ...)) { ... }` block. */
function guardedBlocks(src: string): Array<[number, number]> {
  const blocks: Array<[number, number]> = [];
  for (const m of src.matchAll(GUARD)) {
    const condEnd = matchClose(src, src.indexOf('(', m.index!), '(', ')');
    const open = src.indexOf('{', condEnd);
    if (condEnd < 0 || open < 0) continue;
    const end = matchClose(src, open, '{', '}');
    if (end > 0) blocks.push([open, end]);
  }
  return blocks;
}

/** Offsets of remote-debugging-port switches that are not inside a guarded block. */
function unguardedSwitches(src: string): number[] {
  const blocks = guardedBlocks(src);
  return [...src.matchAll(SWITCH)]
    .map((m) => m.index!)
    .filter((at) => !blocks.some(([s, e]) => at > s && at < e));
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) ? [full] : [];
  });
}

describe('bootstrap.ts uses shouldEnableRemoteDebugging', () => {
  const bootstrap = fs.readFileSync(path.join(MAIN_DIR, 'bootstrap.ts'), 'utf8');

  it('opens the CDP port in exactly one place, inside the guarded block', () => {
    expect([...bootstrap.matchAll(SWITCH)]).toHaveLength(1);
    expect(unguardedSwitches(bootstrap)).toEqual([]);
  });

  it('no other main-process file appends remote-debugging-port', () => {
    const offenders = sourceFiles(MAIN_DIR)
      .filter((f) => path.basename(f) !== 'bootstrap.ts')
      .filter((f) => /appendSwitch\(\s*['"`]remote-debugging-port/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('the bootstrap check itself (broken in-memory inputs)', () => {
  const guard = "if (shouldEnableRemoteDebugging({ isPackaged: app.isPackaged, env: process.env })) {";

  it('accepts the guarded form with any quote style', () => {
    for (const q of ["'", '"', '`']) {
      expect(unguardedSwitches(`${guard}\n  app.commandLine.appendSwitch(${q}remote-debugging-port${q}, p);\n}`)).toEqual([]);
    }
  });

  it('flags an unguarded switch', () => {
    expect(unguardedSwitches("app.commandLine.appendSwitch('remote-debugging-port', p);")).toHaveLength(1);
  });

  it('flags the old NODE_ENV-only condition', () => {
    const old = "if (process.env.NODE_ENV !== 'production') {\n  app.commandLine.appendSwitch(\"remote-debugging-port\", p);\n}";
    expect(unguardedSwitches(old)).toHaveLength(1);
  });

  it('flags a guard that does not pass app.isPackaged', () => {
    const wrong = "if (shouldEnableRemoteDebugging({ isPackaged: false, env: process.env })) {\n  app.commandLine.appendSwitch('remote-debugging-port', p);\n}";
    expect(unguardedSwitches(wrong)).toHaveLength(1);
  });

  it('flags a switch that sits after the guarded block closed', () => {
    const after = `${guard}\n  log();\n}\napp.commandLine.appendSwitch(\`remote-debugging-port\`, p);`;
    expect(unguardedSwitches(after)).toHaveLength(1);
  });
});
