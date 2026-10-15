/**
 * "Team • 6 members • 2 active" / "Team • Solo": the one-line identity of a
 * Team mode root, shared by the session sidebar and the Team view so both
 * describe a team with the same words and the same counts.
 */

import React, { memo, useMemo } from 'react';
import { atom, useAtomValue } from 'jotai';
import type { SessionMeta } from '@nimbalyst/runtime';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';
import { sessionProcessingAtom } from '../../store/atoms/sessions';
import { summarizeTeam } from './teamMembership';

/** How many of the given sessions are running right now (live, from the per-session atoms). */
export function useActiveSessionCount(sessionIds: readonly string[]): number {
  const key = sessionIds.join('|');
  const countAtom = useMemo(
    () => atom((get) => sessionIds.reduce((total, id) => total + (get(sessionProcessingAtom(id)) ? 1 : 0), 0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the content of sessionIds
    [key],
  );
  return useAtomValue(countAtom);
}

export interface TeamSummaryLineProps {
  members: readonly Pick<SessionMeta, 'id' | 'teamRole'>[];
  /** Also list the members per role ("2 Explorer • 1 Reviewer"). */
  showRoles?: boolean;
  /** Extra trailing parts, e.g. the root's model and effort. */
  extra?: readonly string[];
  className?: string;
}

export const TeamSummaryLine = memo(function TeamSummaryLine({ members, showRoles, extra, className }: TeamSummaryLineProps) {
  const { t } = useTranslation('agent');
  const summary = useMemo(() => summarizeTeam(members), [members]);
  const activeCount = useActiveSessionCount(useMemo(() => members.map((member) => member.id), [members]));

  const parts: string[] = [t('agentTeam.teamLabel')];
  if (summary.isSolo) {
    parts.push(t('agentTeam.solo'));
  } else {
    parts.push(t('agentTeam.memberCount', { count: summary.memberCount }));
    // Nobody running is the quiet case: say nothing rather than "0 active".
    if (activeCount > 0) parts.push(t('agentTeam.activeCount', { count: activeCount }));
    if (showRoles) {
      for (const { role, count } of summary.roles) {
        // Pluralized per role by i18next (`roleCounts.<role>_one` / `_other`):
        // "2 Consultores Independentes", never a concatenated "s".
        parts.push(t(`agentTeam.roleCounts.${role}`, { count, defaultValue: t('agentTeam.roleCount', { count, role: t(`agentTeam.roles.${role}`) }) }));
      }
    }
  }
  if (extra) parts.push(...extra.filter(Boolean));

  return (
    <span
      className={className}
      data-testid="team-summary-line"
      data-team-kind={summary.isSolo ? 'solo' : 'team'}
      title={summary.isSolo ? t('agentTeam.soloHint') : undefined}
    >
      {parts.join(' • ')}
    </span>
  );
});
