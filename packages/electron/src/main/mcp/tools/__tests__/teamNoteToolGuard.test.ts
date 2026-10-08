// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../database/initialize', () => ({ getDatabase: () => null }));

import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { guardTeamNoteCreate, guardTeamNoteUpdate, isTeamNoteCreate } from '../teamNoteToolGuard';

const sessions: Record<string, unknown> = {
  root: { agentRole: 'standard', metadata: { teamMode: true }, worktreePath: null },
  explorer: { agentRole: 'standard', metadata: { teamChild: { role: 'explorer', rootSessionId: 'root', depth: 1 } } },
  reviewer: { agentRole: 'standard', metadata: { teamChild: { role: 'reviewer', rootSessionId: 'root', depth: 1 } } },
  implementer: { agentRole: 'standard', metadata: { teamChild: { role: 'implementer', rootSessionId: 'root', depth: 1 } } },
};

beforeEach(() => {
  AISessionsRepository.setStore({ get: async (id: string) => sessions[id] ?? null } as never);
});
afterEach(() => {
  AISessionsRepository.clearStore();
});

const note = (extra: Record<string, unknown> = {}) => ({
  type: 'team-note',
  title: 'Port the v16 rules gradually',
  description: 'Decided with the user; see session for the comparison.',
  fields: { noteKind: 'decision' },
  ...extra,
});

describe('tracker_create of a team-note', () => {
  it('only team-note creates are guarded; other types pass untouched', () => {
    expect(isTeamNoteCreate({ type: 'task' })).toBe(false);
    expect(isTeamNoteCreate({ type: 'team-note' })).toBe(true);
  });

  it('the coordinator writes and the host fills provenance', async () => {
    const args: any = note();
    expect(await guardTeamNoteCreate(args, 'root')).toBeNull();
    expect(args.fields).toEqual({ noteKind: 'decision', sourceSession: 'root', teamRootSession: 'root', agentRole: 'coordinator' });
  });

  it('an agent cannot forge provenance', async () => {
    const args: any = note({ fields: { noteKind: 'risk', sourceSession: 'someone-else', agentRole: 'reviewer', branch: 'main', teamRootSession: 'x' } });
    expect(await guardTeamNoteCreate(args, 'root')).toBeNull();
    expect(args.fields).toEqual({ noteKind: 'risk', sourceSession: 'root', teamRootSession: 'root', agentRole: 'coordinator' });
  });

  it.each(['explorer', 'reviewer', 'implementer'])('a %s member is refused, even with write tools', async (member) => {
    const result = await guardTeamNoteCreate(note(), member);
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/Team members cannot write Team Notes/);
  });

  it('refuses an oversized body (including one passed in the fields bag)', async () => {
    const big = 'x'.repeat(601);
    expect((await guardTeamNoteCreate(note({ description: big }), 'root'))?.content[0].text).toMatch(/limit is 600/);
    expect((await guardTeamNoteCreate(note({ description: undefined, fields: { noteKind: 'test', description: big } }), 'root'))?.content[0].text)
      .toMatch(/limit is 600/);
  });

  it('refuses an invalid status on create and update (shared rule)', async () => {
    expect((await guardTeamNoteCreate(note({ status: 'done' }), 'root'))?.content[0].text).toMatch(/status must be/);
    expect((await guardTeamNoteUpdate({ id: 'nte_1', status: 'to-do' }, 'team-note', 'root'))?.content[0].text).toMatch(/status must be/);
  });

  it('refuses a missing kind and team-note as a mere type tag', async () => {
    expect((await guardTeamNoteCreate(note({ fields: {} }), 'root'))?.content[0].text).toMatch(/noteKind/);
    expect((await guardTeamNoteCreate({ type: 'task', typeTags: ['team-note'] }, 'root'))?.content[0].text).toMatch(/primary type/);
  });
});

describe('tracker_update of a team-note', () => {
  it('leaves non-note updates untouched', async () => {
    const args: any = { id: 'task_1', fields: { sourceSession: 'kept' } };
    expect(await guardTeamNoteUpdate(args, 'task', 'implementer')).toBeNull();
    expect(args.fields).toEqual({ sourceSession: 'kept' });
  });

  it('the coordinator resolves a pending note; provenance in the update is dropped', async () => {
    const args: any = { id: 'nte_1', status: 'resolved', fields: { sourceSession: 'forged', supersedes: ['nte_0'] } };
    expect(await guardTeamNoteUpdate(args, 'team-note', 'root')).toBeNull();
    expect(args.status).toBe('resolved');
    expect(args.fields).toEqual({ supersedes: ['nte_0'] });
  });

  it('members cannot update notes', async () => {
    expect((await guardTeamNoteUpdate({ id: 'nte_1', status: 'obsolete' }, 'team-note', 'implementer'))?.isError).toBe(true);
  });

  it('a note cannot change type and an item cannot become a note', async () => {
    expect((await guardTeamNoteUpdate({ id: 'nte_1', primaryType: 'task' }, 'team-note', 'root'))?.content[0].text).toMatch(/cannot change type/);
    expect((await guardTeamNoteUpdate({ id: 'task_1', primaryType: 'team-note' }, 'task', 'root'))?.content[0].text).toMatch(/cannot be turned into/);
  });

  it('caps the body on update too', async () => {
    expect((await guardTeamNoteUpdate({ id: 'nte_1', description: 'y'.repeat(700) }, 'team-note', 'root'))?.content[0].text).toMatch(/limit is 600/);
  });
});
