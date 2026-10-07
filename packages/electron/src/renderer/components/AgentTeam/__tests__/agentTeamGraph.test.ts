// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '@nimbalyst/runtime';
import { buildTeamForest, countTeamNodes, type TeamTreeNode } from '../agentTeamGraph';

function session(id: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: id,
    provider: 'claude-code',
    model: 'claude-code:opus',
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

function ids(nodes: TeamTreeNode[]): string[] {
  return nodes.map((node) => node.session.id);
}

describe('buildTeamForest', () => {
  it('builds a tree from createdBySessionId and keeps unrelated sessions standalone', () => {
    const forest = buildTeamForest([
      session('architect', { agentRole: 'meta-agent' }),
      session('explorer-sql', { createdBySessionId: 'architect', createdAt: 2_000 }),
      session('explorer-ui', { createdBySessionId: 'architect', createdAt: 3_000 }),
      session('reviewer', { createdBySessionId: 'explorer-ui', createdAt: 4_000 }),
      session('lonely'),
    ]);

    expect(ids(forest.teams)).toEqual(['architect']);
    const [root] = forest.teams;
    expect(ids(root.children)).toEqual(['explorer-sql', 'explorer-ui']);
    expect(ids(root.children[1].children)).toEqual(['reviewer']);
    expect(countTeamNodes(root)).toBe(4);
    expect(forest.standalone.map((s) => s.id)).toEqual(['lonely']);
  });

  it('ignores parentSessionId: workstream containment is not delegation', () => {
    const forest = buildTeamForest([
      session('a'),
      session('b', { parentSessionId: 'a' }),
    ]);
    expect(forest.teams).toEqual([]);
    expect(forest.standalone.map((s) => s.id).sort()).toEqual(['a', 'b']);
  });

  it('marks a delegated session whose creator is outside the view and keeps it out of Standalone', () => {
    const forest = buildTeamForest([
      session('archived-creator', { isArchived: true }),
      session('child', { createdBySessionId: 'archived-creator' }),
    ]);
    expect(ids(forest.teams)).toEqual(['child']);
    expect(forest.teams[0].creatorOutsideView).toBe(true);
    expect(forest.standalone).toEqual([]);
  });

  it('skips archived sessions and workstream/blitz container rows', () => {
    const forest = buildTeamForest([
      session('ws', { sessionType: 'workstream' }),
      session('blitz', { sessionType: 'blitz' }),
      session('old', { isArchived: true }),
      session('live'),
    ]);
    expect(forest.teams).toEqual([]);
    expect(forest.standalone.map((s) => s.id)).toEqual(['live']);
  });

  it('does not hang on a creator cycle and still shows every member once', () => {
    const forest = buildTeamForest([
      session('x', { createdBySessionId: 'y' }),
      session('y', { createdBySessionId: 'x' }),
    ]);
    expect(forest.teams).toHaveLength(1);
    expect(countTeamNodes(forest.teams[0])).toBe(2);
  });

  it('orders teams by most recent activity anywhere in the tree and standalone by updatedAt', () => {
    const forest = buildTeamForest([
      session('old-root', { updatedAt: 100 }),
      session('old-child', { createdBySessionId: 'old-root', updatedAt: 9_000 }),
      session('new-root', { updatedAt: 5_000 }),
      session('new-child', { createdBySessionId: 'new-root', updatedAt: 5_000 }),
      session('s1', { updatedAt: 10 }),
      session('s2', { updatedAt: 20 }),
    ]);
    expect(ids(forest.teams)).toEqual(['old-root', 'new-root']);
    expect(forest.standalone.map((s) => s.id)).toEqual(['s2', 's1']);
  });
});
