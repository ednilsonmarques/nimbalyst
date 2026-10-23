/**
 * Filesystem side of the agent browser tools, shared by the browser IPC handlers
 * and the main-run `portal_*` / `browser.*` tools: turning a workspace file into
 * a `nim-preview://` URL, and saving a screenshot under the workspace. Both only
 * trust a workspace that is a registered open workspace (or a worktree of one).
 */

import { relative, isAbsolute, resolve, join } from 'path';
import { lstat, mkdir, realpath, writeFile } from 'fs/promises';
import type { BrowserSessionService } from './BrowserSessionService';
import {
  addNimPreviewWorkspaceRoot,
  encodeNimPreviewUrl,
  getNimPreviewWorkspaceRoots,
  previewPathsEqual,
  previewPathInsideRoot,
} from '../protocols/nimPreviewProtocol';
import { logger } from '../utils/logger';

export const BROWSER_TRANSCRIPT_IMAGE_DIRNAME = 'transcript-images';

export function getBrowserTranscriptImageDir(workspacePath: string): string {
  return join(resolve(workspacePath), '.nimbalyst', BROWSER_TRANSCRIPT_IMAGE_DIRNAME);
}

/**
 * Resolve a caller-supplied workspace path to a registered open workspace.
 * Accepted: a path equal to or inside a root the app registered for an open
 * workspace window, or the exact path of a known worktree whose project is
 * registered. Returns the normalised path, or null when it is neither (or does
 * not exist, or resolves out of its root through a link).
 */
export async function resolveRegisteredWorkspace(workspacePath: string): Promise<string | null> {
  const candidate = resolve(workspacePath);
  const roots = getNimPreviewWorkspaceRoots();

  const root = roots.find((r) => previewPathInsideRoot(r, candidate));
  if (root) {
    try {
      const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
      return previewPathInsideRoot(realRoot, realCandidate) ? candidate : null;
    } catch {
      return null;
    }
  }

  const projectPath = await lookupWorktreeProjectPath(candidate);
  if (!projectPath) return null;
  const project = resolve(projectPath);
  if (!roots.some((r) => previewPathInsideRoot(r, project))) return null;
  try {
    await realpath(candidate);
  } catch {
    return null;
  }
  return candidate;
}

/**
 * Let a session working in a git worktree open files of that worktree. The
 * nim-preview roots are the open projects' roots, and a worktree lives outside
 * its project's folder, so its files are not served until its root is
 * registered. Registered on demand, and only when the path is a known worktree
 * (WorktreeStore) of a project that is itself a registered root, the same test
 * `resolveRegisteredWorkspace` applies. An arbitrary path is never registered,
 * and neither is a link: a symlink or junction (lstat), or a path whose real
 * location differs from its spelling (a linked parent; compared
 * case-insensitively on Windows), could point the served root outside the
 * project, so it is refused.
 */
export async function registerWorktreeRoot(workspacePath: string): Promise<void> {
  const candidate = resolve(workspacePath);
  if (getNimPreviewWorkspaceRoots().some((root) => previewPathInsideRoot(root, candidate))) return; // already served
  try {
    if ((await lstat(candidate)).isSymbolicLink()) return; // junctions report as symbolic links too
    const real = resolve(await realpath(candidate));
    const same = process.platform === 'win32' ? real.toLowerCase() === candidate.toLowerCase() : real === candidate;
    if (!same) return;
  } catch {
    return; // cannot be inspected: do not serve it
  }
  if (await resolveRegisteredWorkspace(candidate)) {
    addNimPreviewWorkspaceRoot(candidate);
    logger.main.info(`[BrowserAgentFiles] Registered worktree root for previews: ${candidate}`);
  }
}

async function lookupWorktreeProjectPath(workspacePath: string): Promise<string | null> {
  try {
    const { getDatabase } = await import('../database/initialize');
    const { createWorktreeStore } = await import('./WorktreeStore');
    const worktree = await createWorktreeStore(getDatabase()).getByPath(workspacePath);
    return worktree?.projectPath ?? null;
  } catch (err) {
    logger.main.warn(
      `[BrowserAgentFiles] worktree lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Encode a workspace-relative or absolute filesystem path into a
 * `nim-preview://` URL a browser session can navigate to. Throws for a path
 * outside any registered workspace root, so a caller cannot make us build a URL
 * we would refuse to serve at request time.
 *
 * The registered roots are process-wide (every open project). With
 * `confineToRoot` the file must additionally lie under `workspacePath`, the
 * caller's own project root; an agent portal is built this way, so one project's
 * session cannot open another registered project's files.
 */
export function buildPreviewUrlForFile(
  filePath: string,
  workspacePath?: string,
  options: { confineToRoot?: boolean } = {},
): string {
  if (!filePath) throw new Error('filePath is required');
  if (!isAbsolute(filePath)) throw new Error('filePath must be absolute');
  const resolvedFile = resolve(filePath);
  if (options.confineToRoot) {
    if (!workspacePath) throw new Error('This session has no project to open a preview from');
    if (!previewPathInsideRoot(resolve(workspacePath), resolvedFile)) {
      throw new Error('File is outside the project of this session');
    }
  }
  const roots = getNimPreviewWorkspaceRoots();
  let matchedRoot: string | null = null;
  if (workspacePath) {
    const candidate = resolve(workspacePath);
    // Match against the registered root (not the caller's spelling) so the
    // encoded root always equals an allowlisted entry, even when drive
    // letter or path casing differs on Windows (issue #612).
    const registered = roots.find((r) => previewPathsEqual(r, candidate));
    if (registered && previewPathInsideRoot(registered, resolvedFile)) {
      matchedRoot = registered;
    }
  }
  if (!matchedRoot) {
    for (const root of roots) {
      if (previewPathInsideRoot(root, resolvedFile)) {
        matchedRoot = root;
        break;
      }
    }
  }
  if (!matchedRoot) {
    throw new Error('File is not under any active workspace root');
  }
  return encodeNimPreviewUrl(matchedRoot, relative(matchedRoot, resolvedFile));
}

/**
 * Capture `sessionId` and write the PNG under the workspace's
 * `.nimbalyst/transcript-images`, returning its absolute path. Nothing is
 * captured or written unless `workspacePath` is a registered open workspace.
 * Throws with the reason otherwise.
 */
export async function captureScreenshotToFile(
  service: BrowserSessionService,
  sessionId: string,
  workspacePath: string,
  label?: string,
): Promise<string> {
  if (!isAbsolute(workspacePath)) throw new Error('workspacePath must be absolute');
  // The caller names the workspace, so it is only trusted once it is a
  // registered open workspace (or a worktree of one).
  const workspace = await resolveRegisteredWorkspace(workspacePath);
  if (!workspace) throw new Error('workspacePath is not a registered open workspace');
  const buffer = await service.captureScreenshot(sessionId);
  // Persist transcript-linked screenshots in a durable .nimbalyst
  // subdirectory instead of the transient browser-shots path.
  const dir = getBrowserTranscriptImageDir(workspace);
  const realWorkspace = await realpath(workspace);
  // A `.nimbalyst` that is a link leaving the workspace must not become
  // the write target (checked before mkdir, which would follow it).
  const realNimbalyst = await realpath(join(workspace, '.nimbalyst')).catch(() => null);
  if (realNimbalyst && !previewPathInsideRoot(realWorkspace, realNimbalyst)) {
    throw new Error('.nimbalyst resolves outside the workspace');
  }
  await mkdir(dir, { recursive: true });
  if (!previewPathInsideRoot(realWorkspace, await realpath(dir))) {
    throw new Error('Screenshot directory resolves outside the workspace');
  }
  const safeLabel = (label || sessionId).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 60);
  const filePath = join(dir, `${safeLabel}-${Date.now()}.png`);
  await writeFile(filePath, buffer);
  return filePath;
}
