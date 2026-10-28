// @vitest-environment node
/**
 * What the coordinator is taught about Team Notes (F1 gate 3): the kinds
 * including handoff, nextAction on pending and handoff, the handoff fields, the
 * two body caps, the fields Nimbalyst fills, and what to do when a write is
 * refused. The numbers and names are checked against the rules the host
 * enforces (teamNoteRules), so the text cannot drift from them.
 */
import { describe, expect, it } from 'vitest';
import { buildClaudeCodeSystemPrompt, buildTeamChildAddendum, buildTeamModeAddendum } from '../prompt';
import {
  TEAM_NOTE_BODY_MAX_CHARS,
  TEAM_NOTE_HANDOFF_BODY_MAX_CHARS,
  TEAM_NOTE_HANDOFF_ONLY_FIELDS,
  TEAM_NOTE_HANDOFF_RESULTS,
  TEAM_NOTE_KINDS,
  TEAM_NOTE_NEXT_ACTION_KINDS,
  TEAM_NOTE_PROVENANCE_FIELDS,
  validateTeamNoteData,
} from '../../plugins/TrackerPlugin/models/teamNoteRules';

const notes = (() => {
  const text = buildTeamModeAddendum('claude');
  return text.slice(text.indexOf('### Team Notes'));
})();
const thousands = (n: number) => n.toLocaleString('en-US');

describe('Team Notes: the kinds and the caps match the enforced rules', () => {
  it('lists every kind the rules accept, handoff included, and nothing else', () => {
    const line = notes.split('\n').find((l) => l.includes('`fields.noteKind` ='));
    expect(line).toBeDefined();
    const listed = /`fields\.noteKind` = ([^.]+)\./.exec(line as string)?.[1] ?? '';
    expect(listed.split(/, | or /).filter(Boolean)).toEqual([...TEAM_NOTE_KINDS]);
  });

  it('states the body cap of a note and of a handoff, as the rules enforce them', () => {
    expect(notes).toContain(`capped at ${TEAM_NOTE_BODY_MAX_CHARS} characters (${thousands(TEAM_NOTE_HANDOFF_BODY_MAX_CHARS)} for a handoff)`);
    expect(notes).toContain('a longer one is refused');
    expect(notes).not.toContain('about 600');
    // The numbers of the rules, so a change there fails here.
    expect(TEAM_NOTE_BODY_MAX_CHARS).toBe(600);
    expect(TEAM_NOTE_HANDOFF_BODY_MAX_CHARS).toBe(2500);
  });
});

describe('Team Notes: nextAction', () => {
  it('requires it on exactly the kinds the rules require it on, as fields.nextAction', () => {
    expect([...TEAM_NOTE_NEXT_ACTION_KINDS]).toEqual(['pending', 'handoff']);
    expect(notes).toContain('A `pending` note needs `fields.nextAction`');
    expect(notes).toContain('the concrete next step, in one or two lines');
    expect(notes).toMatch(/`handoff` note[^\n]*needs `fields\.result`[^\n]*and `fields\.nextAction`/);
  });

  it('every field the rules name in their refusals is one the text names', () => {
    const refusals = [
      validateTeamNoteData({ noteKind: 'pending', title: 't' }, { mode: 'create' }),
      validateTeamNoteData({ noteKind: 'handoff', title: 't' }, { mode: 'create' }),
      validateTeamNoteData({ noteKind: 'decision', result: 'completed', commits: ['a'], pendings: ['x'], relatedNotes: ['y'] }, { mode: 'create' }),
    ].flat().join(' ');
    for (const field of ['nextAction', 'result', 'commits', 'pendings', 'relatedNotes']) {
      expect(refusals, field).toContain(field);
      expect(notes, field).toContain(`\`fields.${field}\``);
    }
  });
});

describe('Team Notes: the handoff', () => {
  it('names the three results exactly as the rules enforce them', () => {
    const [first, second, third] = TEAM_NOTE_HANDOFF_RESULTS;
    expect(notes).toContain(`\`fields.result\` (\`${first}\`, \`${second}\` or \`${third}\`)`);
  });

  it('names the structured fields, says they belong to a handoff only, and that the body is capped higher', () => {
    for (const field of TEAM_NOTE_HANDOFF_ONLY_FIELDS) expect(notes, field).toContain(`\`fields.${field}\``);
    expect(notes).toContain('`result`, `commits`, `pendings` and `relatedNotes` belong only to a handoff; every other kind refuses them');
    expect(notes).toContain('`fields.commits` (a list of short commit ids');
    expect(notes).toContain('`fields.pendings` (the item ids of the pending notes you hand over');
  });

  it('points relationships at item ids, never at issue keys, which the write does not resolve', () => {
    // Evidence: trackerToolHandlers.test.ts ("relationship targets: what a key becomes") shows the funnel
    // stores exactly the string it is given, so a key like NIB-12 would be a dangling target.
    expect(notes).toContain('the `id` that `mcp__nimbalyst-trackers__tracker_create` returned or `mcp__nimbalyst-trackers__tracker_get` shows (`team-note_…`), never the issue key (`NIB-12`), which is not resolved there');
    expect(notes).toContain('`fields.relatedNotes` (item ids, as above)');
    expect(notes).toContain('set `supersedes` to the old note\'s item id');
    // Reading by key stays fine: tracker_get resolves a key, so briefs keep citing keys.
    expect(notes).toContain('cite only the keys of the relevant notes');
    expect(notes).not.toMatch(/`fields\.(pendings|relatedNotes)` \((the )?keys/);
  });

  it('is written for a coordinator who never saw this session, and not as routine progress', () => {
    expect(notes).toContain('passes a mission\'s state on to the next coordinator');
    expect(notes).toContain('never as routine progress');
    expect(notes).toContain('a coordinator who never saw this session');
  });

  it('does not teach the closing flow or any immutability rule that belongs to F2', () => {
    for (const f2 of ['team_mission_close', 'never edited', 'immutable', 'one handoff per', 'supersedes it']) {
      expect(notes, f2).not.toContain(f2);
    }
  });
});

describe('Team Notes: what Nimbalyst fills in', () => {
  it('names every provenance field the rules protect, the front included, and says not to set them', () => {
    expect([...TEAM_NOTE_PROVENANCE_FIELDS]).toEqual(['sourceSession', 'teamRootSession', 'agentRole', 'branch', 'worktree', 'front']);
    const line = notes.split('\n').find((l) => l.includes('are filled in by Nimbalyst')) ?? '';
    for (const word of ['Source session', 'root session', 'role', 'branch', 'worktree', 'front']) expect(line, word).toContain(word);
    expect(line).toContain('never set them');
    // Evidence: trackerToolHandlers.test.ts ("provenance the agent passes is discarded") - through the agent's
    // tracker_create and tracker_update the value is dropped on both; only manual writers (UI, IPC, CLI) are refused.
    expect(line).toContain('a value you pass is discarded, on creation and on update alike');
    expect(line).not.toContain('refused');
  });
});

describe('Team Notes: when a write is refused', () => {
  it('says to read the refusal, fix the field it names and retry once', () => {
    expect(notes).toContain('When a write is refused, the tool error names the problem and the field');
    expect(notes).toContain('Read it, fix that field and retry once.');
  });

  it('forbids dropping the note silently and getting around the rule', () => {
    expect(notes).toContain('Do not drop the note silently');
    expect(notes).toContain('do not change its kind, split it or strip its content just to get past the rule');
  });

  it('tells the coordinator to report a refusal that persists, with its text', () => {
    expect(notes).toContain('If the retry fails too, say so in your next message to the user, with the refusal text');
  });
});

describe('Team Notes: the members\' suggestions carry a next action for a pending item', () => {
  const variants: Array<[string, string]> = [
    ['implementer', buildTeamChildAddendum('implementer')],
    ['reviewer', buildTeamChildAddendum('reviewer')],
    ['explorer', buildTeamChildAddendum('explorer')],
    ['other', buildTeamChildAddendum('other')],
    ['architect', buildTeamChildAddendum('architect')],
    ['advisor', buildTeamChildAddendum('advisor')],
  ];

  it.each(variants)('%s: the suggested-notes format asks for the next action of a pending item', (_role, text) => {
    expect(text).toContain('Suggested notes:');
    expect(text).toContain('- [KIND] title — short summary (a pending item also names its next action)');
  });

  it('a member without trackers is told nothing about notes', () => {
    for (const role of ['implementer', 'architect', 'advisor'] as const) {
      expect(buildTeamChildAddendum(role, false)).not.toContain('next action');
    }
  });
});

describe('without trackers there is nothing to teach', () => {
  it('a coordinator in a workspace without trackers gets no note guidance or nextAction', () => {
    const root = buildClaudeCodeSystemPrompt({ teamMode: true, trackersEnabled: false });
    for (const word of ['Team Notes', 'nextAction', 'fields.noteKind', 'fields.result']) expect(root, word).not.toContain(word);
  });
});
