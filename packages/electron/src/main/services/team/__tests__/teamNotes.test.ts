// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import {
  TEAM_NOTE_BODY_MAX_CHARS,
  checkTeamNoteBody,
  checkTeamNoteKind,
  decideTeamNoteWriter,
  formatTeamNoteSummary,
  resolveTeamNoteWriter,
  stripTeamNoteProvenance,
} from '../teamNotes';

const ROOT = { agentRole: 'standard', metadata: { teamMode: true }, worktreeId: null, worktreePath: null };
const member = (role: string) => ({
  agentRole: 'standard',
  metadata: { teamChild: { role, rootSessionId: 'root', depth: 1 } },
});

describe('decideTeamNoteWriter', () => {
  it('a coordinator writes, with provenance taken from its session and worktree', () => {
    const decision = decideTeamNoteWriter('root', { ...ROOT, worktreeId: 'wt', worktreePath: '/p_worktrees/x' }, { branch: 'worktree/x', path: '/p_worktrees/x' });
    expect(decision).toEqual({
      allowed: true,
      provenance: { sourceSession: 'root', teamRootSession: 'root', agentRole: 'coordinator', branch: 'worktree/x', worktree: '/p_worktrees/x', front: null },
    });
  });

  it('a session outside any team writes as standalone, as plain tracker use', () => {
    const decision = decideTeamNoteWriter('plain', { agentRole: 'standard', metadata: {} }, null);
    expect(decision).toEqual({
      allowed: true,
      provenance: { sourceSession: 'plain', teamRootSession: null, agentRole: 'standalone', branch: null, worktree: null, front: null },
    });
  });

  it.each(['explorer', 'reviewer', 'implementer', 'other'])('a %s member never writes and is told to suggest', (role) => {
    const decision = decideTeamNoteWriter('child', member(role), null);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toMatch(/Suggested notes/);
  });

  it('the refusal teaches the same suggestion format the members\' prompt does, next action included', () => {
    const decision = decideTeamNoteWriter('child', member('reviewer'), null);
    expect(decision.allowed === false && decision.reason).toContain('("- [KIND] title — short summary (a pending item also names its next action)")');
  });
});

describe('the front of a note (F1 S2): copied by the host from the mission root', () => {
  const rootWith = (metadata: Record<string, unknown>) => ({ agentRole: 'standard', metadata: { teamMode: true, ...metadata }, worktreeId: null, worktreePath: null });
  // A mission root as the host creates it (S4): the front comes with the host provenance marker.
  const hostRootWith = (metadata: Record<string, unknown>) => rootWith({ teamMissionVersion: 1, ...metadata });

  it('a coordinator whose root carries a teamFront writes notes with that front', () => {
    const decision = decideTeamNoteWriter('root', hostRootWith({ teamFront: 'team-front_1' }), null);
    expect(decision.allowed && decision.provenance.front).toBe('team-front_1');
    expect(decision.allowed && decision.provenance).toEqual({
      sourceSession: 'root', teamRootSession: 'root', agentRole: 'coordinator', branch: null, worktree: null, front: 'team-front_1',
    });
  });

  it('a root with no teamFront (an older mission, one started without a front) leaves front empty', () => {
    expect((decideTeamNoteWriter('root', rootWith({}), null) as any).provenance.front).toBeNull();
    for (const bad of ['', '   ', 42, null, { itemId: 'x' }, ['x']]) {
      expect((decideTeamNoteWriter('root', hostRootWith({ teamFront: bad }), null) as any).provenance.front, JSON.stringify(bad)).toBeNull();
    }
  });

  it('a root with a stored teamFront but no host marker (written before S3) is a legacy root: front stays empty', () => {
    const preS3 = decideTeamNoteWriter('root', rootWith({ teamFront: 'team-front_forged', teamGoal: 'g', teamMissionStatus: 'active' }), null);
    expect(preS3).toMatchObject({ allowed: true, provenance: { front: null, teamRootSession: 'root', agentRole: 'coordinator' } });
  });

  it('a session outside any team never gets a front, even if its metadata names one', () => {
    const decision = decideTeamNoteWriter('plain', { agentRole: 'standard', metadata: { teamFront: 'team-front_1' } }, null);
    expect((decision as any).provenance.front).toBeNull();
  });

  it('a member never writes, front or no front', () => {
    const decision = decideTeamNoteWriter('child', { ...member('implementer'), metadata: { ...member('implementer').metadata, teamFront: 'team-front_1' } }, null);
    expect(decision.allowed).toBe(false);
  });

  it('is read from the calling session stored in the repository', async () => {
    try {
      AISessionsRepository.setStore({ get: async (id: string) => (id === 'root-front' ? hostRootWith({ teamFront: 'team-front_7' }) : id === 'root-plain' ? rootWith({}) : null) } as never);
      const withFront = await resolveTeamNoteWriter('root-front', async () => null);
      const without = await resolveTeamNoteWriter('root-plain', async () => null);
      expect(withFront.allowed && withFront.provenance.front).toBe('team-front_7');
      expect(without.allowed && without.provenance.front).toBeNull();
    } finally {
      AISessionsRepository.clearStore();
    }
  });
});

describe('resolveTeamNoteWriter', () => {
  afterEach(() => {
    AISessionsRepository.clearStore();
  });

  it('reads the session and its worktree branch', async () => {
    AISessionsRepository.setStore({ get: async () => ({ ...ROOT, worktreeId: 'wt' }) } as never);
    const loadWorktree = vi.fn(async () => ({ branch: 'worktree/a', path: '/wt/a' }));
    const decision = await resolveTeamNoteWriter('root', loadWorktree);
    expect(loadWorktree).toHaveBeenCalledWith('wt');
    expect(decision.allowed && decision.provenance).toMatchObject({ branch: 'worktree/a', worktree: '/wt/a', agentRole: 'coordinator' });
  });

  it('fails closed when the session cannot be read', async () => {
    AISessionsRepository.setStore({ get: async () => { throw new Error('db down'); } } as never);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const decision = await resolveTeamNoteWriter('root', async () => null);
    expect(decision.allowed).toBe(false);
    error.mockRestore();
  });
});

describe('note content rules', () => {
  it('caps the body at the approved size', () => {
    expect(checkTeamNoteBody('x'.repeat(TEAM_NOTE_BODY_MAX_CHARS))).toBeNull();
    expect(checkTeamNoteBody('x'.repeat(TEAM_NOTE_BODY_MAX_CHARS + 1))).toMatch(/limit is 600/);
    expect(checkTeamNoteBody(undefined)).toBeNull();
  });

  it('a handoff may carry 2,500 characters, any other kind 600, and no kind means the strict cap', () => {
    expect(checkTeamNoteBody('x'.repeat(2500), 'handoff')).toBeNull();
    expect(checkTeamNoteBody('x'.repeat(2501), 'handoff')).toMatch(/limit is 2500/);
    expect(checkTeamNoteBody('x'.repeat(601), 'decision')).toMatch(/limit is 600/);
    expect(checkTeamNoteBody('x'.repeat(601))).toMatch(/limit is 600/);
  });

  it('requires one of the seven kinds', () => {
    for (const kind of ['decision', 'discovery', 'risk', 'pending', 'test', 'context', 'handoff']) expect(checkTeamNoteKind(kind)).toBeNull();
    expect(checkTeamNoteKind('idea')).toMatch(/noteKind/);
    expect(checkTeamNoteKind(undefined)).toMatch(/noteKind/);
  });

  it('drops agent-supplied provenance and keeps everything else', () => {
    expect(stripTeamNoteProvenance({ noteKind: 'risk', sourceSession: 'forged', agentRole: 'coordinator', branch: 'x', worktree: 'y', teamRootSession: 'z', files: ['a'] }))
      .toEqual({ noteKind: 'risk', files: ['a'] });
  });

  it('drops an agent-supplied front too, in every shape, and keeps the new handoff fields', () => {
    for (const front of ['team-front_9', { itemId: 'team-front_9' }, ['team-front_9']]) {
      expect(stripTeamNoteProvenance({ noteKind: 'handoff', front, nextAction: 'n', result: 'completed', commits: ['a'], pendings: ['p'], relatedNotes: ['r'] }), JSON.stringify(front))
        .toEqual({ noteKind: 'handoff', nextAction: 'n', result: 'completed', commits: ['a'], pendings: ['p'], relatedNotes: ['r'] });
    }
  });

  it('lists a note in one compact line with kind, status, ref and short origin', () => {
    expect(formatTeamNoteSummary({
      title: 'Two consecutive imports are not covered',
      status: 'active',
      customFields: { noteKind: 'risk', agentRole: 'coordinator', sourceSession: '1234567890abcdef' },
    }, 'NIM-12')).toBe('- [RISK] Two consecutive imports are not covered (active) [ref: NIM-12] · coordinator, session 12345678');
  });
});
