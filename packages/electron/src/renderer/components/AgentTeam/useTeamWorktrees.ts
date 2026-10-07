import { useEffect, useState } from 'react';
import { fetchTeamWorktrees, type TeamWorktreeInfo } from './teamDataSource';

/**
 * Worktree name/branch for the given ids. Fetches only ids it has not seen yet,
 * so registry churn (titles, phases) does not re-query known worktrees.
 */
export function useTeamWorktrees(worktreeIds: string[]): Map<string, TeamWorktreeInfo> {
  const [worktrees, setWorktrees] = useState<Map<string, TeamWorktreeInfo>>(() => new Map());
  const requestKey = [...new Set(worktreeIds)].sort().join('|');

  useEffect(() => {
    const missing = requestKey ? requestKey.split('|').filter((id) => !worktrees.has(id)) : [];
    if (missing.length === 0) return;
    let cancelled = false;
    void fetchTeamWorktrees(missing).then((fetched) => {
      if (cancelled || fetched.size === 0) return;
      setWorktrees((previous) => {
        const next = new Map(previous);
        for (const [id, info] of fetched) next.set(id, info);
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
    // `worktrees` is read for the missing-id diff only; re-running on its change would refetch nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey]);

  return worktrees;
}
