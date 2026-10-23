/** Windows process helpers for the Portal fixture. Kills go through processSelect.ts, never by PID alone. */
import { execFileSync } from 'child_process';
import {
  norm,
  selectKillable,
  stillRunning,
  vetProcess,
  type Allow,
  type ProcInfo,
  type RecordedProc,
  type Refusal,
} from './processSelect';

export type { Allow, ProcInfo, RecordedProc, Refusal };

function ps(command: string): string {
  // `; exit 0`: Get-Process / Get-NetTCPConnection exit 1 when nothing matches.
  return execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}; exit 0`],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 128 * 1024 * 1024 },
  );
}

/** Every process: pid, parent pid, creation time (epoch ms), executable path, command line. */
export function snapshotTable(): ProcInfo[] {
  const out = ps(
    `$r = @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; ` +
      `created = $(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }); exe = $_.ExecutablePath; cmd = $_.CommandLine } }); ` +
      `ConvertTo-Json -InputObject $r -Compress`,
  );
  const parsed = JSON.parse(out.trim() || '[]');
  return (Array.isArray(parsed) ? parsed : [parsed]) as ProcInfo[];
}

export function makeAllow(opts: { electronExe: string; markers: string[] }): Allow {
  const dir = opts.electronExe.replace(/[\\/][^\\/]*$/, '');
  // .../node_modules/electron/dist -> .../node_modules/@openai (the Codex app-server the app starts)
  const nodeModules = dir.replace(/[\\/]electron[\\/]dist$/, '');
  return { electronExe: opts.electronExe, exeDirs: [dir], helperDirs: [`${nodeModules}\\@openai`], markers: opts.markers };
}

/**
 * The tree the launch started, vetted: what the run may later kill. Roots are Playwright's own pid AND the app's
 * main process found by identity (the repo's electron.exe whose command line names the out2 entry, created after the
 * launch began), because Playwright's pid can be a launcher that exits while the app keeps running.
 */
export function launchTree(
  rootPid: number,
  allow: Allow,
  startedAt: number,
): { recorded: RecordedProc[]; procs: ProcInfo[]; refused: Refusal[] } {
  const table = snapshotTable();
  const entry = norm(allow.markers[0] ?? '');
  const roots = table.filter(
    (p) =>
      p.pid === rootPid ||
      (p.created >= startedAt && p.exe && norm(p.exe) === norm(allow.electronExe) && p.cmd && entry && norm(p.cmd).includes(entry)),
  );
  const sel = selectKillable(
    table,
    roots.map((p) => ({ pid: p.pid, created: p.created, exe: p.exe })),
    allow,
  );
  return {
    recorded: sel.kill.map((p) => ({ pid: p.pid, created: p.created, exe: p.exe })),
    procs: sel.kill,
    refused: sel.refused,
  };
}

export interface Termination {
  killed: ProcInfo[];
  /** Failed identity checks: NOT killed. A leftover. */
  refused: Refusal[];
  /** Recorded PIDs that a different process owns now: not ours, left alone. */
  reused: RecordedProc[];
  /** Processes we selected and killed that are still there afterwards. */
  survivors: ProcInfo[];
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Kill what the run started, and only that: select from a first snapshot, re-query,
 * and kill a process only if the fresh entry has the SAME creation time and passes
 * the identity checks again. Synchronous, so exit/signal handlers can use it.
 */
export function terminateRecorded(recorded: RecordedProc[], allow: Allow): Termination {
  const first = selectKillable(snapshotTable(), recorded, allow);
  if (first.kill.length === 0) return { killed: [], refused: first.refused, reused: first.reused, survivors: [] };

  const fresh = new Map(snapshotTable().map((p) => [p.pid, p] as const));
  const killed: ProcInfo[] = [];
  const refused = [...first.refused];
  for (const p of first.kill) {
    const q = fresh.get(p.pid);
    if (!q || q.created !== p.created) continue; // gone, or the number was reused in between
    const reason = vetProcess(q, allow);
    if (reason) {
      refused.push({ proc: q, reason });
      continue;
    }
    try {
      process.kill(p.pid);
      killed.push(q);
    } catch {
      // exited meanwhile
    }
  }
  if (killed.length) sleepSync(2500);
  const after = snapshotTable();
  // A refused process (never killed) is a leftover only if it is STILL running once its parents are gone: a console
  // host or helper that exits with the tree is not one.
  const refusedStill = refused.filter((r) => stillRunning(after, [r.proc]).length > 0);
  return { killed, refused: refusedStill, reused: first.reused, survivors: stillRunning(after, killed) };
}

/** Those of `procs` still running (same PID and creation time). */
export function stillAlive(procs: ProcInfo[]): ProcInfo[] {
  return procs.length ? stillRunning(snapshotTable(), procs) : [];
}

export function listeningPorts(pids: number[]): Array<{ pid: number; address: string; port: number }> {
  if (pids.length === 0) return [];
  const out = ps(
    `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { @(${pids.join(',')}) -contains $_.OwningProcess } | ` +
      `ForEach-Object { "$($_.OwningProcess)|$($_.LocalAddress)|$($_.LocalPort)" }`,
  );
  return out.split(/\r?\n/).filter(Boolean).map((line) => {
    const [pid, address, port] = line.split('|');
    return { pid: Number(pid), address, port: Number(port) };
  });
}
