/**
 * Which processes the Portal fixture may kill. Pure functions over a process
 * table, so the rules are unit-tested (processes.test.ts) without touching a
 * real process.
 *
 * Why this is strict: Windows reuses PIDs, and a process's ParentProcessId is
 * never updated when the parent exits. A PID the run recorded can later belong
 * to anything, and an older, unrelated process (for example a developer's own
 * running dev app) can carry a stale ParentProcessId that equals a recorded
 * PID. So nothing is killed on a PID alone:
 *
 *  - a recorded root counts only if its CreationDate still equals the recorded one;
 *  - a child counts only if it was created AFTER its parent;
 *  - every candidate must also pass `vetProcess`: the repo's electron.exe (or a
 *    process in its folder) whose command line names out2 or the run's temp root;
 *  - a candidate that fails is never killed and is reported as a refusal
 *    (a leftover, which fails the run); its subtree is not walked.
 *
 * What actually separates the fixture's app from a developer's dev app:
 * both run the SAME electron.exe binary, so the executable cannot tell them
 * apart. The protection is (1) the creation-time ordering above and (2) the
 * out2 / run-temp-root marker in the command line. That makes `out2` (and the
 * run's temp root) exclusive to the fixture: if anything else were ever run from
 * `out2`, it would pass the marker check.
 *
 * The `--remote-debugging-port=9222` deny in `vetProcess` is DEFENSE IN DEPTH
 * ONLY. The dev app adds that port through `app.commandLine.appendSwitch`
 * (bootstrap.ts), so the flag is normally NOT on the OS command line and this
 * check will not see it. Do not rely on it.
 */

export interface ProcInfo {
  pid: number;
  ppid: number;
  /** CreationDate as epoch milliseconds. */
  created: number;
  exe: string | null;
  cmd: string | null;
}

export interface RecordedProc {
  pid: number;
  created: number;
  exe: string | null;
}

export interface Allow {
  /** The repo's electron.exe (the only executable the run launches). */
  electronExe: string;
  /** Folders whose executables are part of that Electron (crashpad handler, ...). */
  exeDirs: string[];
  /**
   * Helper programs the app itself starts and ends (the Codex app-server under node_modules/@openai). Their command line
   * has no out2 / temp root, so the marker rule does not apply to them. What makes one killable is how it got into the
   * selection, not the executable: either it is a recorded root whose PID, CreationDate and executable all still match
   * the record, or it is a younger child of a process that already passed `vetProcess`. A helper that is neither (an
   * unrelated codex.exe, for example a developer's own app-server) is never reached. The 9222 deny still applies.
   */
  helperDirs?: string[];
  /** The command line of anything we kill contains at least one of these (the out2 entry, the run's temp root). */
  markers: string[];
}

export interface Refusal {
  proc: ProcInfo;
  reason: string;
}

export interface Selection {
  /** Safe to kill (root first, then descendants, breadth-first). */
  kill: ProcInfo[];
  /** Candidates that failed a check: never killed, reported as leftovers. */
  refused: Refusal[];
  /** Recorded PIDs now owned by a different process (creation time differs): not ours, not touched. */
  reused: RecordedProc[];
}

export const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();

const DEBUG_PORT_9222 = /remote-debugging-port[=\s"']*9222(?!\d)/i;

/** null when the process may be killed, otherwise the reason it may not. */
export function vetProcess(p: ProcInfo, allow: Allow): string | null {
  if (p.cmd && DEBUG_PORT_9222.test(p.cmd)) {
    // defense in depth only: a dev app normally sets this port with appendSwitch, so it is not on the OS command line
    return 'its command line has --remote-debugging-port=9222 (a developer\'s dev app)';
  }
  if (!p.exe) return 'its executable path cannot be read';
  const exe = norm(p.exe);
  const exeOk = exe === norm(allow.electronExe) || allow.exeDirs.some((d) => exe.startsWith(norm(d).replace(/\/?$/, '/')));
  const helperOk = (allow.helperDirs ?? []).some((d) => exe.startsWith(norm(d).replace(/\/?$/, '/')));
  if (!exeOk && !helperOk) return `its executable is not the repo's electron.exe (${p.exe})`;
  if (helperOk && !exeOk) return null; // no marker for helpers: safety comes from the recorded identity or vetted parentage (Allow.helperDirs)
  if (!p.cmd) return 'its command line cannot be read';
  const cmd = norm(p.cmd);
  if (!allow.markers.some((m) => cmd.includes(norm(m)))) return 'its command line names neither out2 nor the run\'s temp root';
  return null;
}

export function selectKillable(table: ProcInfo[], recorded: RecordedProc[], allow: Allow): Selection {
  const byPid = new Map<number, ProcInfo>();
  for (const p of table) byPid.set(p.pid, p);

  const reused: RecordedProc[] = [];
  const roots: ProcInfo[] = [];
  const refused: Refusal[] = [];
  for (const r of recorded) {
    const p = byPid.get(r.pid);
    if (!p) continue; // gone: nothing to do
    if (p.created !== r.created) {
      reused.push(r); // the PID was reused by another process
      continue;
    }
    if (r.exe && p.exe && norm(r.exe) !== norm(p.exe)) {
      refused.push({ proc: p, reason: 'its executable differs from the recorded one' });
      continue;
    }
    roots.push(p);
  }

  const kill: ProcInfo[] = [];
  const seen = new Set<number>();
  const queue = [...roots];
  while (queue.length) {
    const node = queue.shift()!;
    if (seen.has(node.pid)) continue;
    seen.add(node.pid);
    const reason = vetProcess(node, allow);
    if (reason) {
      refused.push({ proc: node, reason });
      continue; // never walk below a process we are not sure about
    }
    kill.push(node);
    for (const child of table) {
      // PIDs are reused and ParentProcessId is never updated: a real child is younger than its parent.
      if (child.ppid === node.pid && child.pid !== node.pid && child.created > node.created) queue.push(child);
    }
  }
  return { kill, refused, reused };
}

/** The processes of `selection.kill` still running in `table` (same PID AND same creation time). */
export function stillRunning(table: ProcInfo[], procs: ProcInfo[]): ProcInfo[] {
  const byPid = new Map(table.map((p) => [p.pid, p] as const));
  return procs.filter((p) => byPid.get(p.pid)?.created === p.created);
}
