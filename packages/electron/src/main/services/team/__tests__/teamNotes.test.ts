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
      provenance: { sourceSession: 'root', teamRootSession: 'root', agentRole: 'coordinator', branch: 'worktree/x', worktree: '/p_worktrees/x' },
    });
  });

  it('a session outside any team writes as standalone, as plain tracker use', () => {
    const decision = decideTeamNoteWriter('plain', { agentRole: 'standard', metadata: {} }, null);
    expect(decision).toEqual({
      allowed: true,
      provenance: { sourceSession: 'plain', teamRootSession: null, agentRole: 'standalone', branch: null, worktree: null },
    });
  });

  it.each(['explorer', 'reviewer', 'implementer', 'other'])('a %s member never writes and is told to suggest', (role) => {
    const decision = decideTeamNoteWriter('child', member(role), null);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toMatch(/Suggested notes/);
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

  it('requires one of the six kinds', () => {
    for (const kind of ['decision', 'discovery', 'risk', 'pending', 'test', 'context']) expect(checkTeamNoteKind(kind)).toBeNull();
    expect(checkTeamNoteKind('idea')).toMatch(/noteKind/);
    expect(checkTeamNoteKind(undefined)).toMatch(/noteKind/);
  });

  it('drops agent-supplied provenance and keeps everything else', () => {
    expect(stripTeamNoteProvenance({ noteKind: 'risk', sourceSession: 'forged', agentRole: 'coordinator', branch: 'x', worktree: 'y', teamRootSession: 'z', files: ['a'] }))
      .toEqual({ noteKind: 'risk', files: ['a'] });
  });

  it('lists a note in one compact line with kind, status, ref and short origin', () => {
    expect(formatTeamNoteSummary({
      title: 'Two consecutive imports are not covered',
      status: 'active',
      customFields: { noteKind: 'risk', agentRole: 'coordinator', sourceSession: '1234567890abcdef' },
    }, 'NIM-12')).toBe('- [RISK] Two consecutive imports are not covered (active) [ref: NIM-12] · coordinator, session 12345678');
  });
});
