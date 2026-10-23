import { describe, expect, it } from 'vitest';
import { selectKillable, stillRunning, vetProcess, type Allow, type ProcInfo, type RecordedProc } from './processSelect';
import { pointsAtTestBuild } from './runGuard';

const ELECTRON = 'C:\\repo\\node_modules\\electron\\dist\\electron.exe';
const RUN_ROOT = 'C:\\Temp\\nib-portal-run-AbC123';
const OUT2 = 'C:\\repo\\packages\\electron\\out2\\main\\index.js';
const allow: Allow = { electronExe: ELECTRON, exeDirs: ['C:\\repo\\node_modules\\electron\\dist'], markers: [OUT2, RUN_ROOT] };

const t = 1_000_000;
const proc = (pid: number, ppid: number, created: number, over: Partial<ProcInfo> = {}): ProcInfo => ({
  pid,
  ppid,
  created,
  exe: ELECTRON,
  cmd: `"${ELECTRON}" --type=renderer --user-data-dir="${RUN_ROOT}\\nib-portal-X\\userdata"`,
  ...over,
});
const rec = (p: ProcInfo): RecordedProc => ({ pid: p.pid, created: p.created, exe: p.exe });

// The app main (100) and its children, as the run records them.
const main = proc(100, 50, t, { cmd: `"${ELECTRON}" "${OUT2}" --workspace "${RUN_ROOT}\\ws"` });
const childA = proc(101, 100, t + 500);
const childB = proc(102, 100, t + 600);
const grandchild = proc(103, 101, t + 900);
// The developer's own dev app: much older, port 9222, never ours.
const devApp = proc(4242, 40, t - 500_000, { cmd: `"${ELECTRON}" .  --remote-debugging-port=9222` });

describe('selectKillable', () => {
  it('(d) selects a genuine child tree, root first', () => {
    const explorer = proc(7, 1, t - 9999, { exe: 'C:\\Windows\\explorer.exe', cmd: 'explorer' });
    const sel = selectKillable([main, childA, childB, grandchild, devApp, explorer], [rec(main)], allow);
    expect(sel.kill.map((p) => p.pid)).toEqual([100, 101, 102, 103]);
    expect(sel.refused).toEqual([]);
    expect(sel.reused).toEqual([]);
  });

  it('(a) excludes a "child" that is older than its parent (stale ParentProcessId)', () => {
    // 4242 keeps ppid 100 from a long-dead process that had that number; it was created BEFORE `main`.
    const stale = { ...devApp, ppid: 100 };
    const sel = selectKillable([main, childA, stale], [rec(main)], allow);
    expect(sel.kill.map((p) => p.pid)).toEqual([100, 101]);
    expect(sel.refused).toEqual([]); // not even considered
    // an innocent-looking command line does not help: age alone excludes it
    const stale2 = proc(555, 100, t - 10, { cmd: `"${ELECTRON}" "${OUT2}"` });
    expect(selectKillable([main, stale2], [rec(main)], allow).kill.map((p) => p.pid)).toEqual([100]);
  });

  it('(b) does not kill a recorded PID that was reused by a process with another creation time', () => {
    const reused = proc(100, 50, t + 7_000_000, { cmd: `"${ELECTRON}" "${OUT2}"` }); // same number, later creation
    const sel = selectKillable([reused, childA], [rec(main)], allow);
    expect(sel.kill).toEqual([]);
    expect(sel.reused.map((r) => r.pid)).toEqual([100]);
    expect(sel.refused).toEqual([]); // not ours: neither killed nor a leftover
  });

  it('(c) never selects a process whose command line has --remote-debugging-port=9222', () => {
    const hostile = proc(104, 100, t + 800, { cmd: `"${ELECTRON}" "${OUT2}" --remote-debugging-port=9222` });
    const sel = selectKillable([main, hostile], [rec(main)], allow);
    expect(sel.kill.map((p) => p.pid)).toEqual([100]);
    expect(sel.refused.map((r) => r.proc.pid)).toEqual([104]);
    expect(sel.refused[0].reason).toMatch(/9222/);
    // even as a recorded root that carries our markers
    expect(selectKillable([hostile], [rec(hostile)], allow).kill).toEqual([]);
    // and the spaced / quoted spellings
    for (const flag of ['--remote-debugging-port 9222', '--remote-debugging-port="9222"', '--remote-debugging-port=9222']) {
      expect(vetProcess(proc(1, 1, t, { cmd: `"${ELECTRON}" "${OUT2}" ${flag}` }), allow)).toMatch(/9222/);
    }
    // a different port is not the dev app's port (an ephemeral Playwright port stays killable)
    expect(vetProcess(proc(1, 1, t, { cmd: `"${ELECTRON}" "${OUT2}" --remote-debugging-port=0` }), allow)).toBeNull();
    expect(vetProcess(proc(1, 1, t, { cmd: `"${ELECTRON}" "${OUT2}" --remote-debugging-port=92220` }), allow)).toBeNull();
  });

  it('(c) never selects a process with no out2 / run-temp-root path, or a foreign executable', () => {
    const noMarker = proc(105, 100, t + 800, { cmd: `"${ELECTRON}" --type=utility --user-data-dir="D:\\other-profile\\@nimbalyst\\electron"` });
    const foreign = proc(106, 100, t + 800, { exe: 'C:\\Windows\\System32\\cmd.exe', cmd: `cmd /c "${OUT2}"` });
    const noCmd = proc(107, 100, t + 800, { cmd: null });
    const noExe = proc(108, 100, t + 800, { exe: null });
    const belowRefused = proc(109, 105, t + 900);
    const sel = selectKillable([main, noMarker, foreign, noCmd, noExe, belowRefused], [rec(main)], allow);
    expect(sel.kill.map((p) => p.pid)).toEqual([100]);
    expect(sel.refused.map((r) => r.proc.pid).sort()).toEqual([105, 106, 107, 108]);
    // 109 is a child of a refused process: its subtree is never walked
    expect(sel.kill.map((p) => p.pid)).not.toContain(109);
  });

  it('(d) a helper the app started (repo codex.exe) is selected only as a younger child of a vetted process', () => {
    const CODEX = 'C:\\repo\\node_modules\\@openai\\codex-win32-x64\\vendor\\bin\\codex.exe';
    const withHelpers: Allow = { ...allow, helperDirs: ['C:\\repo\\node_modules\\@openai'] };
    const codexChild = proc(120, 100, t + 700, { exe: CODEX, cmd: `${CODEX} app-server --listen stdio://` });
    expect(selectKillable([main, codexChild], [rec(main)], withHelpers).kill.map((p) => p.pid)).toEqual([100, 120]);
    // the developer's own Codex app-server: same executable, but its parent is the dev app, not ours -> never in the tree
    const devCodex = proc(4343, 4242, t - 400_000, { exe: CODEX, cmd: `${CODEX} app-server --listen stdio://` });
    expect(selectKillable([main, devApp, devCodex], [rec(main)], withHelpers).kill.map((p) => p.pid)).toEqual([100]);
    // even a stale ppid that matches our main does not make it ours (older than the parent)
    expect(selectKillable([main, { ...devCodex, ppid: 100 }], [rec(main)], withHelpers).kill.map((p) => p.pid)).toEqual([100]);
    // without the allowance the helper is refused
    expect(selectKillable([main, codexChild], [rec(main)], allow).refused.map((r) => r.proc.pid)).toEqual([120]);
    // the 9222 deny applies to helpers too
    expect(vetProcess({ ...codexChild, cmd: `${CODEX} --remote-debugging-port=9222` }, withHelpers)).toMatch(/9222/);
  });

  it('a recorded root whose executable differs from the recorded one is refused', () => {
    const swapped = { ...main, exe: 'C:\\repo\\node_modules\\electron\\dist\\other.exe' };
    const sel = selectKillable([swapped], [rec(main)], allow);
    expect(sel.kill).toEqual([]);
    expect(sel.refused[0].reason).toMatch(/differs/);
  });

  it('a recorded root with exe: null (matching PID and creation time) is refused and never killed', () => {
    const noExe = proc(100, 50, t, { exe: null, cmd: `"${ELECTRON}" "${OUT2}"` });
    const sel = selectKillable([noExe, childA], [{ pid: 100, created: t, exe: null }], allow);
    expect(sel.kill).toEqual([]);
    expect(sel.refused.map((r) => r.proc.pid)).toEqual([100]);
    expect(sel.refused[0].reason).toMatch(/executable path cannot be read/);
    // its children are not walked either
    expect(sel.kill.map((p) => p.pid)).not.toContain(101);
  });

  it('a recorded process that is gone is simply absent (nothing to kill, nothing refused)', () => {
    expect(selectKillable([devApp], [rec(main)], allow)).toEqual({ kill: [], refused: [], reused: [] });
  });

  it('matches the temp root regardless of slash style and case', () => {
    const lower = proc(110, 100, t + 100, { cmd: `"${ELECTRON.toLowerCase()}" --user-data-dir="${RUN_ROOT.toLowerCase().replace(/\\/g, '/')}/x"` });
    expect(vetProcess(lower, allow)).toBeNull();
  });
});

describe('stillRunning', () => {
  it('counts a process only when the same PID still has the same creation time', () => {
    expect(stillRunning([main, childA], [main, childB]).map((p) => p.pid)).toEqual([100]);
    expect(stillRunning([{ ...main, created: main.created + 1 }], [main])).toEqual([]);
  });
});

describe('pointsAtTestBuild (registry value)', () => {
  const cmd = (entry: string) => `    (padrao)    REG_SZ    "C:\\repo\\node_modules\\electron\\dist\\electron.exe" "${entry}" "%1"`;
  it('matches the out2 build the app registers, with either slash', () => {
    expect(pointsAtTestBuild(cmd('C:\\repo\\packages\\electron\\out2\\main\\index.js'))).toBe(true);
    expect(pointsAtTestBuild(cmd('C:/repo/packages/electron/out2/main/index.js'))).toBe(true);
    expect(pointsAtTestBuild(cmd('C:\\Users\\x\\Temp\\nib-portal-run-Ab1\\y'))).toBe(true);
  });
  it('does not match unrelated paths that merely contain "out2"', () => {
    expect(pointsAtTestBuild(cmd('C:\\repo\\packages\\electron'))).toBe(false);
    expect(pointsAtTestBuild(cmd('C:\\projects\\layout2\\main\\index.js'))).toBe(false);
    expect(pointsAtTestBuild(cmd('C:\\projects\\about2\\app'))).toBe(false);
    expect(pointsAtTestBuild(cmd('C:\\repo\\packages\\electron\\out\\main\\index.js'))).toBe(false);
  });
});
