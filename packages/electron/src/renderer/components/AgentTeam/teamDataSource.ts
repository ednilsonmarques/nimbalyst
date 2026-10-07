/**
 * The Team view's only IPC seam. Everything the view needs beyond the session
 * registry and the per-session state atoms is fetched here, so a change to the
 * main-process API touches one file.
 *
 * V1a reads worktree metadata only (`worktree:get-batch`: a single DB query,
 * no git processes).
 */

export interface TeamWorktreeInfo {
  id: string;
  name: string;
  displayName?: string | null;
  branch: string;
}

interface WorktreeBatchResponse {
  success?: boolean;
  worktrees?: Record<string, { id: string; name: string; displayName?: string | null; branch: string }>;
}

/** Resolve worktree ids to name/branch. Failures resolve to an empty map; the view shows what it has. */
export async function fetchTeamWorktrees(worktreeIds: string[]): Promise<Map<string, TeamWorktreeInfo>> {
  const result = new Map<string, TeamWorktreeInfo>();
  if (worktreeIds.length === 0) return result;
  try {
    const response = (await window.electronAPI.invoke('worktree:get-batch', worktreeIds)) as WorktreeBatchResponse | undefined;
    if (!response?.success || !response.worktrees) return result;
    for (const [id, worktree] of Object.entries(response.worktrees)) {
      result.set(id, {
        id,
        name: worktree.name,
        displayName: worktree.displayName ?? null,
        branch: worktree.branch,
      });
    }
  } catch (error) {
    console.error('[AgentTeamView] Failed to load worktrees:', error);
  }
  return result;
}
