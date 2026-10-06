/**
 * ChecksTab — CI check runs grouped by outcome.
 *
 * Read-only. Each row links to the provider's run page in the system browser.
 */

import type { JSX } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';
import { t as translate } from '@nimbalyst/runtime/i18n';
import {
  getPullRequestService,
  type PullRequestRow,
  type PullRequestCheckRow,
} from '../../../services/RendererPullRequestService';

interface ChecksTabProps {
  workspaceId: string;
  remote: string;
  pr: PullRequestRow;
  refreshToken: number;
}

type CheckGroup = 'failure' | 'pending' | 'success' | 'other';

function groupOf(check: PullRequestCheckRow): CheckGroup {
  if (check.status !== 'completed') return 'pending';
  switch (check.conclusion) {
    case 'failure':
    case 'timed_out':
    case 'action_required':
      return 'failure';
    case 'success':
      return 'success';
    case null:
      return 'pending';
    default:
      return 'other';
  }
}

const GROUP_META: Record<CheckGroup, { labelKey: string; icon: string; className: string }> = {
  failure: { labelKey: 'checks.group.failure', icon: 'error', className: 'text-nim-error' },
  pending: { labelKey: 'checks.group.pending', icon: 'pending', className: 'text-nim-warning' },
  success: { labelKey: 'checks.group.success', icon: 'check_circle', className: 'text-nim-success' },
  other: { labelKey: 'checks.group.other', icon: 'remove_circle', className: 'text-nim-muted' },
};

const GROUP_ORDER: CheckGroup[] = ['failure', 'pending', 'success', 'other'];

export function ChecksTab({ workspaceId, remote, pr, refreshToken }: ChecksTabProps): JSX.Element {
  const { t } = useTranslation('pullRequest');
  const [checks, setChecks] = useState<PullRequestCheckRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getPullRequestService()
      .checks(workspaceId, remote, pr.number)
      .then((rows) => {
        if (!cancelled) setChecks(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : translate('pullRequest:checks.failedToLoad'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, remote, pr.number, refreshToken]);

  const grouped = useMemo(() => {
    const map: Record<CheckGroup, PullRequestCheckRow[]> = {
      failure: [],
      pending: [],
      success: [],
      other: [],
    };
    for (const check of checks) {
      map[groupOf(check)].push(check);
    }
    return map;
  }, [checks]);

  const openExternal = (url: string | null) => {
    if (url) window.electronAPI?.openExternal(url);
  };

  return (
    <div className="pr-checks-tab flex flex-col flex-1 min-h-0 overflow-y-auto" data-testid="pr-checks-tab">
      {loading && checks.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-6 text-nim-muted text-sm">
          <div className="spinner w-4 h-4 border-[2px] border-nim-secondary border-t-nim-primary rounded-full animate-spin" />
          {t('checks.loading')}
        </div>
      ) : error ? (
        <div className="text-nim-error text-sm p-4">{error}</div>
      ) : checks.length === 0 ? (
        <div className="text-nim-faint text-sm text-center py-6">{t('checks.empty')}</div>
      ) : (
        GROUP_ORDER.filter((g) => grouped[g].length > 0).map((group) => {
          const meta = GROUP_META[group];
          return (
            <div key={group}>
              <div className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-nim-faint bg-nim-secondary border-b border-nim">
                {t(meta.labelKey)} ({grouped[group].length})
              </div>
              {grouped[group].map((check) => (
                <div
                  key={check.checkName}
                  className="flex items-center gap-2 px-4 py-2 border-b border-nim"
                  data-testid="pr-check-row"
                >
                  <MaterialSymbol icon={meta.icon} size={16} className={`${meta.className} shrink-0`} />
                  <span className="flex-1 min-w-0 truncate text-sm text-nim">{check.checkName}</span>
                  {check.detailsUrl && (
                    <button
                      className="text-xs text-nim-link hover:text-nim-link-hover hover:underline shrink-0"
                      onClick={() => openExternal(check.detailsUrl)}
                    >
                      {t('checks.details')}
                    </button>
                  )}
                </div>
              ))}
            </div>
          );
        })
      )}
    </div>
  );
}
