/**
 * GithubIssueSidebar — filter chips for the issues list.
 *
 * Three groups: upstream state, the local investigation status of the
 * `github-issue` overlay, and the two needs-attention queues. The local group
 * is derived at runtime from that type's workflow statuses (plus any status
 * carried by an item of another type referencing a listed issue), so a status
 * added to the schema later shows up here with no code change. It is hidden
 * entirely until some listed issue has local state — a workspace that has
 * never triaged an issue sees only the upstream chips.
 *
 * The attention chips carry counts because the diverged count is the number
 * the plan watches: it says how much manual reconciliation is being asked for,
 * and therefore when real sync machinery is due.
 */

import type { JSX } from 'react';
import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';
import { getStatusOptions } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { githubIssueListAtom } from '../../../store/atoms/githubIssues';
import { GithubFilterChips } from '../GithubFilterChips';
import { collectTrackerStatusChips } from '../githubTrackerStatusChips';
import {
  STALE_UNTRIAGED_DAYS,
  type IssueAttentionChip,
  type IssueFilterChip,
} from './issueFilters';
import { ISSUE_OVERLAY_TYPE } from './issueOverlay';
import { useIssueTrackerReferences } from './useIssueTrackerContext';

interface GithubIssueSidebarProps {
  remote: string | null;
  activeFilters: ReadonlyArray<IssueFilterChip>;
  onToggleFilter: (filter: IssueFilterChip) => void;
  activeLocalStatusFilters: ReadonlyArray<string>;
  onToggleLocalStatusFilter: (status: string) => void;
  /** Needs-attention queues per issue number, resolved by the panel. */
  attentionByIssue: ReadonlyMap<number, ReadonlyArray<IssueAttentionChip>>;
  activeAttentionFilters: ReadonlyArray<IssueAttentionChip>;
  onToggleAttentionFilter: (chip: IssueAttentionChip) => void;
}

const FILTER_CHIPS: { id: IssueFilterChip; labelKey: string; icon: string }[] = [
  { id: 'open', labelKey: 'issues.filters.open', icon: 'adjust' },
  { id: 'closed', labelKey: 'issues.filters.closed', icon: 'check_circle' },
  { id: 'assigned-to-me', labelKey: 'issues.filters.assignedToMe', icon: 'assignment_ind' },
  { id: 'authored-by-me', labelKey: 'issues.filters.authoredByMe', icon: 'person' },
  { id: 'unlabeled', labelKey: 'issues.filters.unlabeled', icon: 'label_off' },
  { id: 'has-linked-pr', labelKey: 'issues.filters.hasLinkedPr', icon: 'merge' },
];

const ATTENTION_CHIPS: { id: IssueAttentionChip; labelKey: string; icon: string }[] = [
  { id: 'diverged', labelKey: 'issues.filters.diverged', icon: 'sync_problem' },
  { id: 'stale', labelKey: 'issues.filters.stale', icon: 'hourglass_empty' },
];

export function GithubIssueSidebar({
  remote,
  activeFilters,
  onToggleFilter,
  activeLocalStatusFilters,
  onToggleLocalStatusFilter,
  attentionByIssue,
  activeAttentionFilters,
  onToggleAttentionFilter,
}: GithubIssueSidebarProps): JSX.Element {
  const { t } = useTranslation('pullRequest');
  const filterChips = useMemo(
    () => FILTER_CHIPS.map(({ labelKey, ...chip }) => ({ ...chip, label: t(labelKey) })),
    [t],
  );
  const issues = useAtomValue(githubIssueListAtom);
  const references = useIssueTrackerReferences(remote);

  const localStatusChips = useMemo(
    () =>
      collectTrackerStatusChips({
        numbers: issues.map((issue) => issue.number),
        references,
        seedOptions: getStatusOptions(ISSUE_OVERLAY_TYPE),
        activeValues: activeLocalStatusFilters,
      }),
    [issues, references, activeLocalStatusFilters],
  );

  const hasLocalState =
    activeLocalStatusFilters.length > 0 || localStatusChips.some((chip) => chip.count > 0);

  const attentionChips = useMemo(() => {
    const counts = new Map<IssueAttentionChip, number>();
    for (const chips of attentionByIssue.values()) {
      for (const chip of chips) counts.set(chip, (counts.get(chip) ?? 0) + 1);
    }
    return ATTENTION_CHIPS.map(({ labelKey, ...chip }) => ({
      ...chip,
      label: t(labelKey, { days: STALE_UNTRIAGED_DAYS }),
      count: counts.get(chip.id),
    }));
  }, [attentionByIssue, t]);

  const hasAttention =
    activeAttentionFilters.length > 0 || attentionChips.some((chip) => chip.count);

  return (
    <div
      className="issue-sidebar w-full shrink-0 flex flex-col bg-nim-secondary"
      data-testid="issue-sidebar"
    >
      <div className="px-3 py-2 border-b border-nim">
        <div className="text-[11px] font-semibold text-nim-muted uppercase tracking-wider">
          {t('list.issues')}
        </div>
        {remote && (
          <div className="text-[11px] text-nim-faint truncate mt-0.5" title={remote}>
            {remote}
          </div>
        )}
      </div>

      <GithubFilterChips
        heading={t('issues.filters.upstream')}
        chips={filterChips}
        activeIds={activeFilters}
        onToggle={onToggleFilter}
        testIdPrefix="issue-filter"
      />

      {hasLocalState && (
        <GithubFilterChips
          heading={t('issues.filters.local')}
          chips={localStatusChips.map((chip) => ({
            ...chip,
            id: chip.value,
            count: chip.count || undefined,
          }))}
          activeIds={activeLocalStatusFilters}
          onToggle={onToggleLocalStatusFilter}
          testIdPrefix="issue-local-status"
          groupTestId="issue-local-status-filters"
        />
      )}

      {hasAttention && (
        <GithubFilterChips
          heading={t('issues.filters.needsAttention')}
          chips={attentionChips}
          activeIds={activeAttentionFilters}
          onToggle={onToggleAttentionFilter}
          testIdPrefix="issue-attention"
          groupTestId="issue-attention-filters"
        />
      )}
    </div>
  );
}
