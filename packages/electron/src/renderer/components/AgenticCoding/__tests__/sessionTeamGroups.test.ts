// @vitest-environment node
/**
 * Sidebar grouping of Team mode sessions and the membership rules it shares
 * with the Team view.
 */
import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '@nimbalyst/runtime';
import { buildDelegationGroups } from '../sessionTeamGroups';
import {
  collectTeamMembers,
  findTeamRootId,
  summarizeTeam,
  teamMemberRole,
  teamRootsToKeep,
} from '../../AgentTeam/teamMembership';
import { buildTeamForest, teamTreeMembers } from '../../AgentTeam/agentTeamGraph';

function session(id: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: id,
    provider: 'claude-code',
    model: 'claude-code:sonnet',
    sessionType: 'session',
    workspaceId: '/project',
    worktreeId: null,
    parentSessionId: null,
    childCount: 0,
    uncommittedCount: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    messageCount: 0,
    isArchived: false,
    isPinned: false,
    ...overrides,
  };
}

const root = (id: string, overrides: Partial<SessionMeta> = {}) =>
  session(id, { teamMode: true, model: 'claude-code:opus', effortLevel: 'high', ...overrides });
const member = (id: string, creator: string, role: string, createdAt: number, overrides: Partial<SessionMeta> = {}) =>
  session(id, { createdBySessionId: creator, teamRole: role, createdAt, ...overrides });

const TEAM_A = [
  root('a'),
  member('a-exp', 'a', 'explorer', 10),
  member('a-impl', 'a', 'implementer', 20),
  member('a-rev', 'a', 'reviewer', 30),
];

function group(groups: ReturnType<typeof buildDelegationGroups<SessionMeta>>, rootId: string) {
  return groups.groups.find((g) => g.root.id === rootId)!;
}

describe('buildDelegationGroups', () => {
  it('leaves normal sessions alone', () => {
    const result = buildDelegationGroups([session('plain-1'), session('plain-2')], { metaAgentEnabled: false });
    expect(result.groups).toEqual([]);
    expect(result.groupedIds.size).toBe(0);
  });

  it('a Team mode root without members is a group of its own (solo)', () => {
    const result = buildDelegationGroups([root('solo'), session('plain')], { metaAgentEnabled: false });
    expect(result.groups).toHaveLength(1);
    expect(group(result, 'solo')).toMatchObject({ kind: 'team', members: [] });
    expect(result.groupedIds.has('plain')).toBe(false);
  });

  it('nests the members under their root, in creation order, each kept as a real session', () => {
    const result = buildDelegationGroups([...TEAM_A].reverse(), { metaAgentEnabled: false });
    expect(result.groups).toHaveLength(1);
    const team = group(result, 'a');
    expect(team.kind).toBe('team');
    expect(team.members.map((m) => m.id)).toEqual(['a-exp', 'a-impl', 'a-rev']);
    expect(team.members.every((m) => TEAM_A.includes(m))).toBe(true);
    expect([...result.groupedIds].sort()).toEqual(['a', 'a-exp', 'a-impl', 'a-rev']);
  });

  it('keeps several teams apart and does not swallow a normal session', () => {
    const sessions = [
      ...TEAM_A,
      root('b'),
      member('b-exp', 'b', 'explorer', 40),
      session('plain'),
      // Created by a normal session: delegation, but not a team.
      session('plain-child', { createdBySessionId: 'plain' }),
    ];
    const result = buildDelegationGroups(sessions, { metaAgentEnabled: false });
    expect(result.groups.map((g) => g.root.id).sort()).toEqual(['a', 'b']);
    expect(group(result, 'b').members.map((m) => m.id)).toEqual(['b-exp']);
    expect(result.groupedIds.has('plain')).toBe(false);
    expect(result.groupedIds.has('plain-child')).toBe(false);
  });

  it('includes members of members (depth 2) under the same root', () => {
    const sessions = [...TEAM_A, member('a-impl-helper', 'a-impl', 'other', 25)];
    const team = group(buildDelegationGroups(sessions, { metaAgentEnabled: false }), 'a');
    expect(team.members.map((m) => m.id)).toEqual(['a-exp', 'a-impl', 'a-impl-helper', 'a-rev']);
  });

  it('old sessions without the new metadata keep working as plain sessions', () => {
    const legacy = session('legacy');
    delete (legacy as Partial<SessionMeta>).teamMode;
    const legacyChild = session('legacy-child', { createdBySessionId: 'legacy' });
    const result = buildDelegationGroups([legacy, legacyChild], { metaAgentEnabled: false });
    expect(result.groups).toEqual([]);
  });

  it('meta-agent groups still depend on their flag and keep direct children only', () => {
    const sessions = [
      session('meta', { agentRole: 'meta-agent' }),
      session('meta-child', { createdBySessionId: 'meta' }),
      session('meta-grandchild', { createdBySessionId: 'meta-child' }),
    ];
    expect(buildDelegationGroups(sessions, { metaAgentEnabled: false }).groups).toEqual([]);
    const enabled = buildDelegationGroups(sessions, { metaAgentEnabled: true });
    expect(group(enabled, 'meta')).toMatchObject({ kind: 'metaAgent' });
    expect(group(enabled, 'meta').members.map((m) => m.id)).toEqual(['meta-child']);
  });
});

describe('team membership', () => {
  it('counts members per role and recognizes a solo team', () => {
    expect(summarizeTeam(TEAM_A.slice(1))).toEqual({
      memberCount: 3,
      isSolo: false,
      roles: [
        { role: 'explorer', count: 1 },
        { role: 'implementer', count: 1 },
        { role: 'reviewer', count: 1 },
      ],
    });
    expect(summarizeTeam([])).toEqual({ memberCount: 0, isSolo: true, roles: [] });
  });

  it('a member without a known role counts as other', () => {
    expect(teamMemberRole(session('x'))).toBe('other');
    expect(teamMemberRole(session('x', { teamRole: 'wizard' }))).toBe('other');
    expect(teamMemberRole(session('x', { teamRole: 'reviewer' }))).toBe('reviewer');
  });

  it('finds the team of a member at any depth, and none for a normal session', () => {
    const sessions = [...TEAM_A, member('deep', 'a-impl', 'other', 25), session('plain')];
    const byId = new Map(sessions.map((s) => [s.id, s]));
    expect(findTeamRootId(byId.get('a')!, byId)).toBe('a');
    expect(findTeamRootId(byId.get('a-rev')!, byId)).toBe('a');
    expect(findTeamRootId(byId.get('deep')!, byId)).toBe('a');
    expect(findTeamRootId(byId.get('plain')!, byId)).toBeNull();
  });

  it('the sidebar and the Team view agree on who belongs to a team', () => {
    const sessions = [...TEAM_A, member('deep', 'a-impl', 'other', 25), root('solo'), session('plain')];
    const sidebar = buildDelegationGroups(sessions, { metaAgentEnabled: false });
    const forest = buildTeamForest(sessions);
    for (const tree of forest.teams) {
      const sidebarMembers = group(sidebar, tree.session.id).members.map((m) => m.id);
      expect(teamTreeMembers(tree).map((m) => m.id).sort()).toEqual([...sidebarMembers].sort());
      expect(collectTeamMembers(tree.session.id, sessions).map((m) => m.id)).toEqual(sidebarMembers);
    }
    // A solo Team mode root is a team in both places, never a standalone session.
    expect(forest.teams.map((t) => t.session.id).sort()).toEqual(['a', 'solo']);
    expect(forest.standalone.map((s) => s.id)).toEqual(['plain']);
  });
});

describe('search keeps a team together', () => {
  const all = [...TEAM_A, root('b'), member('b-exp', 'b', 'explorer', 40), session('plain')];
  const matching = (query: string) => all.filter((s) => s.title.includes(query));

  it('a match on the root alone needs nothing extra', () => {
    expect(teamRootsToKeep(matching('b'), all)).toEqual([]);
    expect(teamRootsToKeep([all[0]], all)).toEqual([]);
  });

  it('a match on a member brings its root back, once, so the member stays inside its team', () => {
    const matched = matching('a-rev');
    expect(matched.map((s) => s.id)).toEqual(['a-rev']);
    const kept = teamRootsToKeep(matched, all);
    expect(kept.map((s) => s.id)).toEqual(['a']);

    const visible = [...matched, ...kept];
    const result = buildDelegationGroups(visible, { metaAgentEnabled: false });
    expect(group(result, 'a').members.map((m) => m.id)).toEqual(['a-rev']);

    const twoMembers = all.filter((s) => s.id === 'a-exp' || s.id === 'a-rev');
    expect(teamRootsToKeep(twoMembers, all).map((s) => s.id)).toEqual(['a']);
  });

  it('does not pull in a root for a normal session', () => {
    expect(teamRootsToKeep(matching('plain'), all)).toEqual([]);
  });
});
