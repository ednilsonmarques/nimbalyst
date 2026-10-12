/**
 * Sidebar grouping of sessions that delegate work: a parent row with the
 * sessions it created nested under it.
 *
 * Two kinds share one shape and one renderer (MetaAgentGroup):
 * - a meta-agent session and the sessions it created (alpha flag `meta-agent`);
 * - a Team mode root and its members, read through the same membership rules
 *   as the Team view (AgentTeam/teamMembership).
 *
 * Pure: it only reorganizes the sessions it is given. A session that belongs
 * to no group is left for the caller to render as before.
 */

import type { SessionMeta } from '@nimbalyst/runtime';
import { collectTeamMembers, isTeamRoot } from '../AgentTeam/teamMembership';

export type DelegationGroupKind = 'metaAgent' | 'team';

export interface DelegationGroup<T> {
  kind: DelegationGroupKind;
  root: T;
  /** Meta-agent: direct children. Team: every member, oldest first, each after its creator. */
  members: T[];
}

export interface DelegationGroups<T> {
  groups: DelegationGroup<T>[];
  /** Ids of every session rendered inside a group (roots and members). */
  groupedIds: Set<string>;
  /** Ids of members only. */
  memberIds: Set<string>;
}

type GroupableSession = Pick<SessionMeta, 'id' | 'createdBySessionId' | 'createdAt' | 'agentRole' | 'teamMode'>;

export function buildDelegationGroups<T extends GroupableSession>(
  sessions: readonly T[],
  options: { metaAgentEnabled: boolean },
): DelegationGroups<T> {
  const isMetaRoot = (session: T) => options.metaAgentEnabled && session.agentRole === 'meta-agent';
  const rootIds = new Set<string>();
  for (const session of sessions) {
    if (isMetaRoot(session) || isTeamRoot(session)) rootIds.add(session.id);
  }

  const groups: DelegationGroup<T>[] = [];
  const groupedIds = new Set<string>(rootIds);
  const memberIds = new Set<string>();

  for (const root of sessions) {
    if (!rootIds.has(root.id)) continue;
    const kind: DelegationGroupKind = isMetaRoot(root) ? 'metaAgent' : 'team';
    const candidates = kind === 'metaAgent'
      ? sessions.filter((session) => session.createdBySessionId === root.id)
      : collectTeamMembers(root.id, sessions);
    // A session is listed once: another group's root keeps its own row, and a
    // session already claimed by an earlier group is not claimed again.
    const members = candidates.filter((session) => !rootIds.has(session.id) && !memberIds.has(session.id));
    for (const member of members) {
      memberIds.add(member.id);
      groupedIds.add(member.id);
    }
    groups.push({ kind, root, members });
  }

  return { groups, groupedIds, memberIds };
}
