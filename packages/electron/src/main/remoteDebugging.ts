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
