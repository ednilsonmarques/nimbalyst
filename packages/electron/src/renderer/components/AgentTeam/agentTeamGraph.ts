/**
 * Pure projection of the session registry into delegation trees for the
 * Agent mode Team view.
 *
 * The only edge is `createdBySessionId` (ai_sessions.created_by_session_id),
 * written when one session spawns another (spawn_session / create_session /
 * Actions launch). `parentSessionId` is deliberately ignored: it is workstream
 * containment, and spawn_session can re-parent the spawner itself under a new
 * workstream row, so it does not mean "delegated by".
 *
 * Every session has at most one creator, so the result is always a forest.
 */

import type { SessionMeta } from '@nimbalyst/runtime';
import { isTeamRoot } from './teamMembership';

export interface TeamTreeNode {
  session: SessionMeta;
  children: TeamTreeNode[];
  /** The session names a creator that is not in the view (archived, deleted, other workspace). */
  creatorOutsideView: boolean;
}

export interface TeamForest {
  /** Roots of the delegation trees, most recently active team first. */
  teams: TeamTreeNode[];
  /** Sessions with no delegation relation at all and not Team mode roots, most recently updated first. */
  standalone: SessionMeta[];
}

// Container rows group other sessions; they never run a model themselves.
const CONTAINER_SESSION_TYPES = new Set<string>(['workstream', 'blitz']);

export function isTeamCandidate(session: SessionMeta): boolean {
  return !session.isArchived && !CONTAINER_SESSION_TYPES.has(session.sessionType);
}

export function countTeamNodes(node: TeamTreeNode): number {
  return node.children.reduce((total, child) => total + countTeamNodes(child), 1);
}

/** Every session below the root of a tree, in tree order. The root is not included. */
export function teamTreeMembers(node: TeamTreeNode): SessionMeta[] {
  return node.children.flatMap((child) => [child.session, ...teamTreeMembers(child)]);
}

function latestActivity(node: TeamTreeNode): number {
  return node.children.reduce(
    (latest, child) => Math.max(latest, latestActivity(child)),
    node.session.updatedAt,
  );
}

export function buildTeamForest(sessions: Iterable<SessionMeta>): TeamForest {
  const byId = new Map<string, SessionMeta>();
  for (const session of sessions) {
    if (isTeamCandidate(session)) byId.set(session.id, session);
  }

  const childrenByCreator = new Map<string, SessionMeta[]>();
  for (const session of byId.values()) {
    const creatorId = session.createdBySessionId;
    if (!creatorId || creatorId === session.id || !byId.has(creatorId)) continue;
    const siblings = childrenByCreator.get(creatorId);
    if (siblings) siblings.push(session);
    else childrenByCreator.set(creatorId, [session]);
  }

  const visited = new Set<string>();
  const buildNode = (session: SessionMeta, creatorOutsideView: boolean): TeamTreeNode => {
    visited.add(session.id);
    const children = (childrenByCreator.get(session.id) ?? [])
      .filter((child) => !visited.has(child.id))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((child) => buildNode(child, false));
    return { session, children, creatorOutsideView };
  };

  const teams: TeamTreeNode[] = [];
  const standalone: SessionMeta[] = [];

  for (const session of byId.values()) {
    const creatorId = session.createdBySessionId;
    const creatorInView = !!creatorId && creatorId !== session.id && byId.has(creatorId);
    if (creatorInView) continue;

    const hasChildren = childrenByCreator.has(session.id);
    const creatorOutsideView = !!creatorId && creatorId !== session.id;
    // A Team mode root is a team even before it creates a member (solo): it
    // must not be filed with the sessions that have nothing to do with teams.
    if (hasChildren || creatorOutsideView || isTeamRoot(session)) {
      teams.push(buildNode(session, creatorOutsideView));
    } else {
      standalone.push(session);
    }
  }

  // A creator cycle has no root above; the database should never produce one,
  // but if it does, break it at an arbitrary member instead of dropping it.
  for (const session of byId.values()) {
    if (!visited.has(session.id) && childrenByCreator.has(session.id) && session.createdBySessionId && byId.has(session.createdBySessionId)) {
      teams.push(buildNode(session, false));
    }
  }

  const activity = new Map(teams.map((team) => [team, latestActivity(team)]));
  teams.sort((a, b) => activity.get(b)! - activity.get(a)!);
  standalone.sort((a, b) => b.updatedAt - a.updatedAt);
  return { teams, standalone };
}
