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

describe('the front and the handoff (F1 S2)', () => {
  const frontSessions: Record<string, unknown> = {
    'root-front': { agentRole: 'standard', metadata: { teamMode: true, teamFront: 'team-front_1' }, worktreePath: null },
    root: sessions.root,
  };
  beforeEach(() => {
    AISessionsRepository.setStore({ get: async (id: string) => frontSessions[id] ?? null } as never);
  });

  it('the host copies the root\'s front into the note; the agent\'s own front is dropped', async () => {
    const args: any = note({ fields: { noteKind: 'decision', front: 'team-front_forged' } });
    expect(await guardTeamNoteCreate(args, 'root-front')).toBeNull();
    expect(args.fields).toEqual({ noteKind: 'decision', sourceSession: 'root-front', teamRootSession: 'root-front', agentRole: 'coordinator', front: 'team-front_1' });
  });

  it('a root with no front writes a note with no front, whatever the agent sent', async () => {
    for (const front of ['team-front_forged', { itemId: 'team-front_forged' }]) {
      const args: any = note({ fields: { noteKind: 'decision', front } });
      expect(await guardTeamNoteCreate(args, 'root')).toBeNull();
      expect(args.fields, JSON.stringify(front)).toEqual({ noteKind: 'decision', sourceSession: 'root', teamRootSession: 'root', agentRole: 'coordinator' });
    }
  });

  it('accepts handoff as a kind, with the larger body, and keeps 600 for the others', async () => {
    const long = 'x'.repeat(2500);
    expect(await guardTeamNoteCreate(note({ description: long, fields: { noteKind: 'handoff', nextAction: 'n', result: 'completed' } }), 'root')).toBeNull();
    expect((await guardTeamNoteCreate(note({ description: 'x'.repeat(2501), fields: { noteKind: 'handoff' } }), 'root'))?.content[0].text).toMatch(/limit is 2500/);
    expect((await guardTeamNoteCreate(note({ description: 'x'.repeat(601), fields: { noteKind: 'pending' } }), 'root'))?.content[0].text).toMatch(/limit is 600/);
    // The same body in the fields bag.
    expect(await guardTeamNoteCreate(note({ description: undefined, fields: { noteKind: 'handoff', description: long } }), 'root')).toBeNull();
  });

  it('an update is held to the cap of the kind it names, else of the note\'s own kind, else the strict one', async () => {
    const long = 'x'.repeat(2000);
    expect((await guardTeamNoteUpdate({ id: 'nte_1', description: long }, 'team-note', 'root'))?.content[0].text).toMatch(/limit is 600/);
    expect(await guardTeamNoteUpdate({ id: 'nte_1', description: long }, 'team-note', 'root', 'handoff')).toBeNull();
    expect((await guardTeamNoteUpdate({ id: 'nte_1', description: long }, 'team-note', 'root', 'decision'))?.content[0].text).toMatch(/limit is 600/);
    expect((await guardTeamNoteUpdate({ id: 'nte_1', description: 'x'.repeat(2501) }, 'team-note', 'root', 'handoff'))?.content[0].text).toMatch(/limit is 2500/);
    // The kind the update names wins over the stored one.
    expect((await guardTeamNoteUpdate({ id: 'nte_1', description: long, fields: { noteKind: 'risk' } }, 'team-note', 'root', 'handoff'))?.content[0].text).toMatch(/limit is 600/);
    expect(await guardTeamNoteUpdate({ id: 'nte_1', description: long, fields: { noteKind: 'handoff' } }, 'team-note', 'root', 'decision')).toBeNull();
  });

  it('an update cannot set or change the front: it is stripped like the other provenance', async () => {
    const args: any = { id: 'nte_1', fields: { front: 'team-front_9', nextAction: 'new step' } };
    expect(await guardTeamNoteUpdate(args, 'team-note', 'root-front')).toBeNull();
    expect(args.fields).toEqual({ nextAction: 'new step' });
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
