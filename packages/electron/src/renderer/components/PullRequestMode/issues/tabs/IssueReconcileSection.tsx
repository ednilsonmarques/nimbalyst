/**
 * Reconciliation for the adopted state — the one state where a local copy of
 * GitHub content exists and can therefore drift.
 *
 * Nothing here syncs on its own. Re-snapshot is the existing importer path
 * (`tracker:importer:resnapshot`), which pulls title, status and labels and
 * flags a changed body; the body itself is never overwritten without the
 * apply/dismiss choice below, which is the same pair of channels the tracker
 * detail's banner uses. Untouched and overlay-only issues never render this:
 * they hold nothing GitHub also holds.
 */

import type { JSX } from 'react';
import { useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { t as translate } from '@nimbalyst/runtime/i18n';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';
import { getGithubIssueService } from '../../../../services/RendererGithubIssueService';
import type { GithubIssueRow } from '../../../../services/RendererGithubIssueService';
import { PullRequestActionError } from '../../PullRequestActionError';
import { IssueLocalSection } from './IssueLocalSection';
import type { IssueDivergentCopy } from '../issueFilters';

interface IssueReconcileSectionProps {
  workspaceId: string;
  issue: GithubIssueRow;
  /** Local copies that have drifted; the section renders nothing when empty. */
  divergentCopies: ReadonlyArray<IssueDivergentCopy>;
  /** Display key for the tracker item behind each copy, by item id. */
  labelForItem: (itemId: string) => string;
}

/** One human-readable line per axis the reducer reported. */
function divergenceLines(copy: IssueDivergentCopy, issue: GithubIssueRow): string[] {
  const lines: string[] = [];
  const { state, title, upstreamBodyChanged, addedUpstreamLabels } = copy.divergence;
  if (state) {
    lines.push(
      state.upstream === 'closed'
        ? translate('pullRequest:issues.reconcile.closedUpstream')
        : translate('pullRequest:issues.reconcile.reopenedUpstream'),
    );
  }
  if (title) {
    lines.push(
      translate('pullRequest:issues.reconcile.titleChanged', {
        title: issue.title,
        snapshot: title.snapshot,
      }),
    );
  }
  if (upstreamBodyChanged) lines.push(translate('pullRequest:issues.reconcile.bodyChanged'));
  if (addedUpstreamLabels.length > 0) {
    lines.push(
      translate('pullRequest:issues.reconcile.labelsAdded', { labels: addedUpstreamLabels.join(', ') }),
    );
  }
  return lines;
}

function CopyRow({
  workspaceId,
  issue,
  copy,
  label,
}: {
  workspaceId: string;
  issue: GithubIssueRow;
  copy: IssueDivergentCopy;
  label: string;
}): JSX.Element {
  const { t } = useTranslation('pullRequest');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);

  const run = async (action: () => Promise<string>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setApplied(await action());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const resnapshot = () =>
    run(async () => {
      const result = await getGithubIssueService().resnapshot(workspaceId, copy.urn);
      const changed = [
        result.titleUpdated ? t('issues.reconcile.changedTitle') : null,
        result.statusUpdated ? t('issues.reconcile.changedStatus') : null,
        result.bodyChanged ? t('issues.reconcile.changedBody') : null,
      ].filter(Boolean);
      return changed.length > 0
        ? t('issues.reconcile.resnapshotted', { changes: changed.join(', ') })
        : t('issues.reconcile.resnapshottedCurrent');
    });

  const bodyAction = (action: 'applyBody' | 'dismissBody') =>
    run(async () => {
      await window.electronAPI.invoke(`tracker:importer:${action}`, {
        workspacePath: workspaceId,
        urn: copy.urn,
      });
      return action === 'applyBody'
        ? t('issues.reconcile.bodyApplied')
        : t('issues.reconcile.bodyDismissed');
    });

  return (
    <div className="issue-diverged-copy space-y-1.5" data-testid="issue-diverged-copy">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] text-nim-muted truncate">{label}</span>
        <button
          type="button"
          disabled={busy}
          data-testid="issue-resnapshot"
          onClick={() => void resnapshot()}
          className="ml-auto inline-flex items-center gap-1 rounded border border-nim px-2 py-0.5 text-[11px] text-nim-muted hover:text-nim transition-colors disabled:opacity-60"
          title={t('issues.reconcile.resnapshotTitle')}
        >
          <MaterialSymbol icon="sync" size={13} />
          {t('issues.reconcile.resnapshot')}
        </button>
      </div>

      <ul className="space-y-0.5 text-[11.5px] text-nim-muted">
        {divergenceLines(copy, issue).map((line) => (
          <li key={line} className="flex items-start gap-1.5">
            <MaterialSymbol icon="arrow_right" size={13} className="text-nim-faint mt-[1px] shrink-0" />
            <span className="select-text">{line}</span>
          </li>
        ))}
      </ul>

      {copy.divergence.upstreamBodyChanged && (
        <div
          className="flex flex-wrap items-center gap-2 rounded border border-nim px-2 py-1.5 text-[11px] text-nim"
          data-testid="issue-upstream-body-banner"
        >
          <MaterialSymbol icon="sync_problem" size={13} className="text-nim-warning" />
          <span className="flex-1 min-w-[180px]">
            {t('issues.reconcile.bodyBanner')}
          </span>
          <button
            type="button"
            disabled={busy}
            data-testid="issue-apply-upstream-body"
            onClick={() => void bodyAction('applyBody')}
            className="rounded bg-nim-primary px-2 py-0.5 text-nim-on-primary hover:bg-nim-primary-hover disabled:opacity-60"
          >
            {t('issues.reconcile.updateBody')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void bodyAction('dismissBody')}
            className="rounded border border-nim px-2 py-0.5 text-nim-muted hover:text-nim disabled:opacity-60"
          >
            {t('issues.reconcile.discard')}
          </button>
        </div>
      )}

      {applied && !error && <div className="text-[11px] text-nim-faint">{applied}</div>}
      {error && <PullRequestActionError error={error} />}
    </div>
  );
}

export function IssueReconcileSection({
  workspaceId,
  issue,
  divergentCopies,
  labelForItem,
}: IssueReconcileSectionProps): JSX.Element | null {
  const { t } = useTranslation('pullRequest');
  if (divergentCopies.length === 0) return null;

  return (
    <IssueLocalSection
      heading={t('issues.reconcile.heading')}
      note={t('issues.reconcile.authoritative')}
      testId="issue-reconcile"
    >
      <div className="space-y-3">
        {divergentCopies.map((copy) => (
          <CopyRow
            key={copy.itemId}
            workspaceId={workspaceId}
            issue={issue}
            copy={copy}
            label={labelForItem(copy.itemId)}
          />
        ))}
      </div>
    </IssueLocalSection>
  );
}
