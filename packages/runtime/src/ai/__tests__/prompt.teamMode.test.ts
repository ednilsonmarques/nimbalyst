import { describe, expect, it } from 'vitest';
import { buildClaudeCodeSystemPrompt, buildTeamChildAddendum, buildTeamModeAddendum } from '../prompt';

const base = { hasSessionNaming: true, worktreePath: '/repo/worktrees/x', sessionDirective: 'Stay focused.' };

describe('Team mode system prompt', () => {
  it('is byte-identical to the normal prompt when Team mode is off', () => {
    const normal = buildClaudeCodeSystemPrompt(base);
    expect(buildClaudeCodeSystemPrompt({ ...base, teamMode: false, teamChildRole: undefined })).toBe(normal);
    expect(normal).not.toContain('## Team Mode');
    expect(normal).not.toContain('## Team Member');
  });

  it('adds the coordinator policy for a team root, before the session directive', () => {
    const prompt = buildClaudeCodeSystemPrompt({ ...base, teamMode: true });
    expect(prompt).toContain('## Team Mode');
    expect(prompt).not.toContain('## Team Member');
    expect(prompt.indexOf('## Team Mode')).toBeLessThan(prompt.indexOf('Stay focused.'));
    expect(prompt.trimEnd().endsWith('</addendum>')).toBe(true);
  });

  it('adds the member contract for a team child', () => {
    const prompt = buildClaudeCodeSystemPrompt({ ...base, teamChildRole: 'reviewer' });
    expect(prompt).toContain('## Team Member');
    expect(prompt).toContain('You are the reviewer of a coordinated team');
    expect(prompt).not.toContain('## Team Mode');
  });

  it('a root wins over a stray child role', () => {
    const prompt = buildClaudeCodeSystemPrompt({ ...base, teamMode: true, teamChildRole: 'explorer' });
    expect(prompt).toContain('## Team Mode');
    expect(prompt).not.toContain('## Team Member');
  });

  it('coordinator policy states the two delegation levels, roles, limits and ownership', () => {
    const text = buildTeamModeAddendum('claude');
    expect(text).toContain('mcp__nimbalyst-host__create_session');
    expect(text).toContain('mcp__nimbalyst-host__spawn_session');
    expect(text).toContain('SDK sub-agent');
    for (const role of ['explorer', 'implementer', 'reviewer', 'other']) expect(text).toContain(`\`${role}\``);
    expect(text).toContain('at most 3 real sessions active at once, 8 real sessions in total');
    expect(text).toContain('2 levels deep');
    expect(text).toContain('do not read or redo it yourself');
  });

  it('teaches the coordinator Team Notes when trackers are enabled', () => {
    const prompt = buildClaudeCodeSystemPrompt({ ...base, teamMode: true });
    expect(prompt).toContain('### Team Notes');
    expect(prompt).toContain('mcp__nimbalyst-trackers__tracker_list');
    expect(prompt).toContain('look for a similar note');
    expect(prompt).toContain('cite only the keys of the relevant notes');
    expect(prompt).toContain('Never paste a report');
  });

  it('has no Team Notes at all when trackers are disabled in the workspace', () => {
    const root = buildClaudeCodeSystemPrompt({ ...base, teamMode: true, trackersEnabled: false });
    expect(root).toContain('## Team Mode');
    expect(root).not.toContain('Team Notes');
    const child = buildClaudeCodeSystemPrompt({ ...base, teamChildRole: 'explorer', trackersEnabled: false });
    expect(child).not.toContain('Suggested notes');
  });

  it('members only suggest notes', () => {
    const child = buildTeamChildAddendum('reviewer');
    expect(child).toContain('Suggested notes:');
    expect(child).toContain('you never write notes yourself');
    expect(child).toContain('read only those with tracker_get');
  });

  it('states the member defaults and explicit, sparing promotion', () => {
    const text = buildTeamModeAddendum('claude');
    expect(text).toContain('Every member runs on Sonnet by default');
    expect(text).toContain('`reviewer`: independent review of someone else\'s work (Sonnet, effort high');
    expect(text).toContain('`implementer`: makes the changes (Sonnet, effort medium');
    expect(text).toContain('pass `model` and `effortLevel` explicitly');
    expect(text).toContain('Promote only when the task clearly needs it');
    expect(text).not.toContain('defaults to your model');
  });

  it('is static: the same text every call (prompt-cache stable)', () => {
    expect(buildTeamModeAddendum('claude')).toBe(buildTeamModeAddendum('claude'));
    expect(buildTeamChildAddendum('implementer')).toBe(buildTeamChildAddendum('implementer'));
  });

  describe('team plan and review policy', () => {
    const text = buildTeamModeAddendum('claude');

    it('declares SOLO or TEAM in the first reply, without an extra turn', () => {
      expect(text).toContain('### Team plan');
      expect(text).toContain('In your first reply to a task, before any other work');
      expect(text).toContain('`Team plan: SOLO — <reason>`');
      expect(text).toContain('`Team plan: TEAM — <members and why>`');
    });

    it('keeps trivial work solo and fast', () => {
      expect(text).toContain('only when the task is clearly trivial');
      expect(text).toContain('an obvious or localized fix in one file');
      expect(text).toContain('Then just do it.');
      expect(text).toContain('Trivial SOLO work needs no reviewer.');
    });

    it('expects a team for non-trivial signals, including production-ready work', () => {
      for (const signal of [
        'extensive investigation', 'an unfamiliar area', 'several modules', 'implementation plus tests',
        'security', 'permissions', 'persistence or data', 'migrations', 'several independent fronts',
        'an explicit request for an audit or review', 'work meant to be production-ready',
      ]) expect(text).toContain(signal);
    });

    it('requires an independent reviewer for non-trivial implementation', () => {
      expect(text).toContain('### Review before done');
      expect(text).toContain('Non-trivial implementation needs an independent review before you call it done or ready');
      expect(text).toContain('role `reviewer` (Sonnet, effort high, toolScope review: it reads the code and runs the project\'s tests through `mcp__nimbalyst-host__run_project_tests`, nothing else)');
      expect(text).toContain('It is never a session that made the change, and it does not edit.');
    });

    it('never promotes a reviewer to full to run tests', () => {
      expect(text).not.toContain('pass toolScope "full"');
      expect(text).toContain('never edits, never runs a shell; any other toolScope is lowered to review');
    });

    it('turns suspected bugs into proposed test cases, not probes', () => {
      expect(text).toContain('it describes a concrete test case instead of writing a probe');
      expect(text).toContain('you or an implementer add the test, and the reviewer may run the tests again');
    });

    it('bounds the review loop', () => {
      expect(text).toContain('Ask for another review only after a significant fix');
      expect(text).toContain('one adequate final review without blockers is enough');
    });

    it('does not require an implementer or an explorer for every task', () => {
      expect(text).toContain('A TEAM plan can be just you implementing and a reviewer checking.');
      expect(text).toContain('Otherwise you may implement yourself and have a reviewer check it.');
      expect(text).toContain('not just to have one');
    });

    it('keeps the SDK Agent for quick lookups only, never as the reviewer', () => {
      expect(text).toContain('only for quick, one-off, read-only lookups');
      expect(text).toContain('It is not a team member.');
      expect(text).toContain('An SDK sub-agent never replaces this review.');
      expect(text).toContain('as soon as your plan is TEAM');
    });

    it('avoids a redundant get_session_result after an automatic report', () => {
      expect(text).toContain('When that report already answers what you need, do not call `mcp__nimbalyst-host__get_session_result`');
      expect(text).toContain('use it only when the report is incomplete or you need the result again later');
    });
  });

  it('gives the reviewer a non-editing contract with a clear verdict; other roles do not get it', () => {
    const reviewer = buildTeamChildAddendum('reviewer');
    expect(reviewer).toContain('check the final state of the change named in your brief');
    expect(reviewer).toContain('run the project\'s own tests with mcp__nimbalyst-host__run_project_tests');
    expect(reviewer).toContain('you have no shell and never edit anything');
    expect(reviewer).toContain('describe a concrete test case (input and expected result) for the coordinator to add');
    expect(reviewer).toContain('`Verdict: no blockers` or `Verdict: blockers found`');
    for (const role of ['explorer', 'implementer', 'other'] as const) {
      expect(buildTeamChildAddendum(role)).not.toContain('Verdict:');
    }
  });

  it('member contract asks for a short report without repeating the task', () => {
    const text = buildTeamChildAddendum('explorer');
    expect(text).toContain('about 15 lines');
    expect(text).toContain('Do not repeat the task');
    expect(text).toContain('Do not create other sessions');
  });
});
