/**
 * Whether the main process may open a Chromium remote-debugging (CDP) port.
 *
 * The port gives any local process full control of the renderer, so it is a
 * development aid only: never in a packaged build, and never when
 * NODE_ENV=production. NIMBALYST_CDP_PORT picks the port, not whether it opens.
 */
export function shouldEnableRemoteDebugging(opts: {
  isPackaged: boolean;
  env: Record<string, string | undefined>;
}): boolean {
  return !opts.isPackaged && opts.env.NODE_ENV !== 'production';
}

/**
 * Switches that open a debugging channel (Chromium DevTools protocol or the
 * Node inspector) or loosen who may reach it.
 */
export const DEBUG_SWITCHES = [
  'remote-debugging-port',
  'remote-debugging-pipe',
  'remote-debugging-address',
  'remote-allow-origins',
  'inspect',
  'inspect-brk',
  'inspect-port',
] as const;

/**
 * Debugging switches found on the command line that a packaged build should
 * drop before Chromium reads them (decision U8: remove, log, start normally).
 * Development builds keep theirs. Returns each switch name once, lower-case.
 *
 * Chromium reads `--name`, `-name` and, on Windows, `/name`, each optionally
 * with `=value`, so all of them are recognised (`/name` only on win32, where
 * it is a switch; elsewhere it is a path). Reading stops at `--`.
 */
export function debugSwitchesToRemove(opts: {
  isPackaged: boolean;
  argv: string[];
  platform?: NodeJS.Platform;
}): string[] {
  if (!opts.isPackaged) return [];
  const platform = opts.platform ?? process.platform;
  const prefixes = platform === 'win32' ? ['--', '-', '/'] : ['--', '-'];
  const found = new Set<string>();
  for (const arg of opts.argv.slice(1)) {
    if (arg === '--') break;
    const prefix = prefixes.find((p) => arg.startsWith(p));
    if (!prefix) continue;
    const name = arg.slice(prefix.length).split('=')[0].toLowerCase();
    if ((DEBUG_SWITCHES as readonly string[]).includes(name)) found.add(name);
  }
  return [...found];
}
