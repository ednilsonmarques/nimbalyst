/**
 * Team membership, read the same way by the session sidebar and the Team view.
 *
 * A team is a Team mode root (`SessionMeta.teamMode`) plus every session
 * reachable from it through `createdBySessionId`, however deep. Nothing here
 * is stored: it is derived from the session list the renderer already has.
 */

import type { SessionMeta } from '@nimbalyst/runtime';

export const TEAM_MEMBER_ROLES = ['explorer', 'implementer', 'reviewer', 'other'] as const;
export type TeamMemberRole = (typeof TEAM_MEMBER_ROLES)[number];

/** A session created through "New Team mode session", with or without members. */
export function isTeamRoot(session: Pick<SessionMeta, 'teamMode'>): boolean {
  return session.teamMode === true;
}

/** Role of a member; a session spawned without a role (or by an older build) is `other`. */
export function teamMemberRole(session: Pick<SessionMeta, 'teamRole'>): TeamMemberRole {
  return (TEAM_MEMBER_ROLES as readonly string[]).includes(session.teamRole ?? '')
    ? (session.teamRole as TeamMemberRole)
    : 'other';
}

/**
 * Every session below `rootId` through `createdBySessionId`, in creation
 * order (oldest first), each one after its creator. The root is not included.
 */
export function collectTeamMembers<T extends Pick<SessionMeta, 'id' | 'createdBySessionId' | 'createdAt'>>(
  rootId: string,
  sessions: Iterable<T>,
): T[] {
  const byCreator = new Map<string, T[]>();
  for (const session of sessions) {
    const creatorId = session.createdBySessionId;
    if (!creatorId || creatorId === session.id) continue;
    const siblings = byCreator.get(creatorId);
    if (siblings) siblings.push(session);
    else byCreator.set(creatorId, [session]);
  }
  const members: T[] = [];
  const seen = new Set<string>([rootId]);
  const visit = (creatorId: string) => {
    const children = (byCreator.get(creatorId) ?? []).slice().sort((a, b) => a.createdAt - b.createdAt);
    for (const child of children) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      members.push(child);
      visit(child.id);
    }
  };
  visit(rootId);
  return members;
}

/**
 * The Team mode root a session belongs to: itself when it is one, otherwise
 * the nearest Team mode root up its `createdBySessionId` chain. Null for a
 * session outside any team.
 */
export function findTeamRootId(
  session: Pick<SessionMeta, 'id' | 'createdBySessionId' | 'teamMode'>,
  byId: ReadonlyMap<string, Pick<SessionMeta, 'id' | 'createdBySessionId' | 'teamMode'>>,
): string | null {
  const seen = new Set<string>();
  let current: Pick<SessionMeta, 'id' | 'createdBySessionId' | 'teamMode'> | undefined = session;
  while (current && !seen.has(current.id)) {
    if (isTeamRoot(current)) return current.id;
    seen.add(current.id);
    current = current.createdBySessionId ? byId.get(current.createdBySessionId) : undefined;
  }
  return null;
}

export interface TeamSummary {
  /** Members only; the root (coordinator) is not counted. */
  memberCount: number;
  /** A Team mode root that has not created any member. */
  isSolo: boolean;
  /** Member count per role, only roles that occur, in TEAM_MEMBER_ROLES order. */
  roles: Array<{ role: TeamMemberRole; count: number }>;
}

export function summarizeTeam(members: Iterable<Pick<SessionMeta, 'teamRole'>>): TeamSummary {
  const counts = new Map<TeamMemberRole, number>();
  let memberCount = 0;
  for (const member of members) {
    memberCount += 1;
    const role = teamMemberRole(member);
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  return {
    memberCount,
    isSolo: memberCount === 0,
    roles: TEAM_MEMBER_ROLES.filter((role) => counts.has(role)).map((role) => ({ role, count: counts.get(role)! })),
  };
}

/**
 * Sessions a sidebar filter left out but that must stay visible so a matching
 * team member is not orphaned: the Team mode root of every matched member.
 */
export function teamRootsToKeep<T extends Pick<SessionMeta, 'id' | 'createdBySessionId' | 'teamMode'>>(
  matched: readonly T[],
  all: readonly T[],
): T[] {
  const byId = new Map(all.map((session) => [session.id, session] as const));
  const present = new Set(matched.map((session) => session.id));
  const extra: T[] = [];
  for (const session of matched) {
    if (isTeamRoot(session)) continue;
    const rootId = findTeamRootId(session, byId);
    if (!rootId || present.has(rootId)) continue;
    const root = byId.get(rootId);
    if (!root) continue;
    present.add(rootId);
    extra.push(root);
  }
  return extra;
}
