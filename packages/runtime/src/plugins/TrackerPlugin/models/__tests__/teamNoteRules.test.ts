// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  assertTeamNoteBody,
  assertTeamNoteUpdate,
  prepareManualTeamNoteCreate,
  teamNoteBodyLength,
  validateTeamNoteData,
} from '../teamNoteRules';

const lexical = (text: string) => ({
  root: { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', text }] }] },
});
const agentNote = {
  title: 'Port the v16 rules gradually',
  description: 'Decided with the user.',
  noteKind: 'decision',
  status: 'active',
  sourceSession: 'root-session',
  teamRootSession: 'root-session',
  agentRole: 'coordinator',
  branch: 'worktree/x',
  worktree: '/p_worktrees/x',
};

describe('body length', () => {
  it('measures markdown and rich-text bodies the same way', () => {
    expect(teamNoteBodyLength('abc')).toBe(3);
    expect(teamNoteBodyLength(lexical('abcd'))).toBe(4);
    expect(teamNoteBodyLength(JSON.stringify(lexical('abcde')))).toBe(5);
    expect(teamNoteBodyLength(null)).toBe(0);
  });
});

describe('agent (MCP) creation', () => {
  it('accepts host provenance on the agent path', () => {
    expect(validateTeamNoteData(agentNote, { mode: 'create', allowProvenance: true })).toEqual([]);
  });
});

describe('manual creation (Tracker UI)', () => {
  it('is allowed, defaults to active and is marked manual without inventing provenance', () => {
    const data: Record<string, unknown> = { title: 'Confirm the waste formula with PCP', noteKind: 'pending', nextAction: 'Ask PCP which formula is official.' };
    prepareManualTeamNoteCreate('team-note', data, lexical('Ask PCP which formula is official.'));
    expect(data.status).toBe('active');
    expect(data.createdByAgent).toBe(false);
    for (const field of ['sourceSession', 'teamRootSession', 'agentRole', 'branch', 'worktree']) {
      expect(data[field], field).toBeUndefined();
    }
  });

  it('refuses hand-set provenance', () => {
    expect(() => prepareManualTeamNoteCreate('team-note', { title: 't', noteKind: 'risk', sourceSession: 'made-up' }))
      .toThrow(/sourceSession is set by Nimbalyst/);
  });

  it('refuses a missing or invalid kind and an invalid status', () => {
    expect(() => prepareManualTeamNoteCreate('team-note', { title: 't' })).toThrow(/noteKind/);
    expect(() => prepareManualTeamNoteCreate('team-note', { title: 't', noteKind: 'idea' })).toThrow(/noteKind/);
    expect(() => prepareManualTeamNoteCreate('team-note', { title: 't', noteKind: 'risk', status: 'done' })).toThrow(/status must be/);
  });

  it('applies the 600-character cap to both description and rich body', () => {
    expect(() => prepareManualTeamNoteCreate('team-note', { title: 't', noteKind: 'test', description: 'x'.repeat(601) })).toThrow(/limit is 600/);
    expect(() => prepareManualTeamNoteCreate('team-note', { title: 't', noteKind: 'test' }, lexical('y'.repeat(601)))).toThrow(/limit is 600/);
    expect(() => prepareManualTeamNoteCreate('team-note', { title: 't', noteKind: 'test' }, lexical('y'.repeat(600)))).not.toThrow();
  });
});

describe('manual edit (Tracker UI)', () => {
  const after = (changes: Record<string, unknown>) => ({ ...agentNote, ...changes });

  it('allows editing title, body, kind, status, files and supersedes', () => {
    const changes = { title: 'New title', description: 'Shorter.', noteKind: 'risk', status: 'resolved', files: ['a.ts'], customFields: { supersedes: ['nte_1'] } };
    expect(() => assertTeamNoteUpdate('team-note', changes, agentNote, after(changes))).not.toThrow();
  });

  it('protects agent provenance, top level or in the synced customFields bag', () => {
    expect(() => assertTeamNoteUpdate('team-note', { branch: 'main' }, agentNote, after({ branch: 'main' })))
      .toThrow(/branch records where the note came from/);
    const synced = { ...agentNote, customFields: { sourceSession: 'root-session' } };
    expect(() => assertTeamNoteUpdate('team-note', {}, synced, { ...synced, customFields: { sourceSession: 'other' } }))
      .toThrow(/sourceSession/);
  });

  it('a manual note cannot gain agent provenance later', () => {
    const manual = { title: 't', noteKind: 'context', status: 'active', createdByAgent: false };
    expect(() => assertTeamNoteUpdate('team-note', { worktree: '/x' }, manual, { ...manual, worktree: '/x' })).toThrow(/worktree/);
  });

  it('refuses invalid kind, status and oversized body on edit', () => {
    expect(() => assertTeamNoteUpdate('team-note', {}, agentNote, after({ noteKind: 'bug' }))).toThrow(/noteKind/);
    expect(() => assertTeamNoteUpdate('team-note', {}, agentNote, after({ status: 'to-do' }))).toThrow(/status must be/);
    expect(() => assertTeamNoteUpdate('team-note', {}, agentNote, after({ description: 'z'.repeat(700) }))).toThrow(/limit is 600/);
    expect(() => assertTeamNoteBody('team-note', lexical('z'.repeat(700)))).toThrow(/limit is 600/);
  });

  it('a note cannot change type and an item cannot become a note', () => {
    expect(() => assertTeamNoteUpdate('team-note', { type: 'task' }, agentNote, agentNote)).toThrow(/cannot change type/);
    expect(() => assertTeamNoteUpdate('task', { typeTags: ['task', 'team-note'] }, {}, {})).toThrow(/cannot be turned into/);
  });
});

describe('common tracker items are untouched', () => {
  it('creation, field edits and body saves of other types pass through unchanged', () => {
    const data: Record<string, unknown> = { title: 'A bug', status: 'to-do', sourceSession: 'whatever' };
    prepareManualTeamNoteCreate('bug', data, 'x'.repeat(5000));
    expect(data).toEqual({ title: 'A bug', status: 'to-do', sourceSession: 'whatever' });
    expect(() => assertTeamNoteUpdate('task', { status: 'anything', branch: 'b' }, { branch: 'a' }, { branch: 'b' })).not.toThrow();
    expect(() => assertTeamNoteBody('plan', 'x'.repeat(5000))).not.toThrow();
  });
});
