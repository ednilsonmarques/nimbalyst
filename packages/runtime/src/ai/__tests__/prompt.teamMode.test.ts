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
    expect(text).toContain('at most 3 real sessions active at once');
    expect(text).toContain('2 levels deep');
    expect(text).toContain('a budget of 8 real sessions in total');
    expect(text).toContain('do not read or redo it yourself');
  });

  describe('team checkpoint', () => {
    const text = buildTeamModeAddendum('claude');
    const checkpoint = text.slice(text.indexOf('### Team checkpoint'), text.indexOf('### Ownership and integration'));

    it('counts every member ever created and no longer tells the coordinator to just integrate or ask', () => {
      expect(text).toContain('counting every member ever created, finished and archived ones included');
      expect(text).not.toContain('integrate what you have or ask the user');
    });

    it('exhausted budget: stop, inform the user, ask to continue the team', () => {
      expect(checkpoint).toContain('The budget is a checkpoint, not a wall, and only the user can move it');
      expect(checkpoint).toContain('when a creation is refused with "Team budget reached"');
      expect(checkpoint).toContain('Nimbalyst shows the user an action to continue the team in this transcript');
      expect(checkpoint).toContain('stop, tell the user the team reached its checkpoint (how many members were created and what the next one is for), ask them to continue the team, naming the action exactly as the refusal names it, and end your turn');
      expect(checkpoint).toContain('You are told when they authorize it.');
    });

    it('never hardcodes the action name: the refusal gives it in the user language', () => {
      expect(checkpoint).toContain("the refusal gives that action's exact name in the user's language");
      // The static, cached prompt names no button in any language.
      expect(text).not.toContain('Continue team');
      expect(text).not.toContain('Continuar equipe');
    });

    it('the coordinator cannot extend the budget itself', () => {
      expect(checkpoint).toContain('You cannot extend the budget yourself and no tool does.');
    });

    it('never changes a role to get around the budget', () => {
      expect(checkpoint).toContain('While the budget is exhausted, never work around it:');
      expect(checkpoint).toContain("do not change a member's role: an explorer does not become an implementer, an implementer does not become a reviewer;");
      expect(checkpoint).toContain('do not tell a member to forget its earlier role or instructions;');
      expect(checkpoint).toContain('do not take over work you were going to delegate, just to avoid creating a member;');
      // Implementing yourself as a plan (not as an escape) is still allowed.
      expect(text).toContain('Otherwise you may implement yourself and have a reviewer check it.');
    });

    it('never skips the review nor recycles an earlier reviewer as the independent one', () => {
      expect(checkpoint).toContain('do not present an earlier reviewer as the new independent reviewer of later work;');
      expect(checkpoint).toContain('do not skip the required review.');
      // The mandatory independent review itself is untouched.
      expect(text).toContain('Non-trivial implementation needs an independent review before you call it done or ready');
    });

    it('reusing a member in its own role stays allowed', () => {
      expect(checkpoint).toContain('Reusing a member in its own role stays fine, with or without budget left');
      expect(checkpoint).toContain('an explorer gets a new investigation, an implementer continues related implementation, a reviewer gets a follow-up of the same review round');
    });

    it('does not reach the members: they only report to their coordinator', () => {
      for (const role of ['explorer', 'implementer', 'reviewer', 'other'] as const) {
        expect(buildTeamChildAddendum(role)).not.toContain('Team checkpoint');
      }
    });
  });

  it('records Team Notes at milestones, a few durable ones, never everything', () => {
    const prompt = buildClaudeCodeSystemPrompt({ ...base, teamMode: true });
    expect(prompt).toContain('At each milestone (a phase finished, before a significant change of phase, before you end the task) ask yourself');
    expect(prompt).toContain('If yes, record it now, usually one to three short notes; if no, record nothing.');
    expect(prompt).toContain('Worth a note: an architectural decision, a confirmed legacy behavior, an important risk, a tool limitation, a relevant test or oracle, a pending item for later.');
    expect(prompt).toContain('Not worth a note: each file read, each attempt, temporary progress, a summary of the session.');
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

    it('works from the automatic report and fetches the result only when it is cut or missing', () => {
      expect(text).toContain('a [Child Session Update] that carries their final report');
      expect(text).toContain('do NOT call `mcp__nimbalyst-host__get_session_result` after it');
      expect(text).toContain('Call it only when the report is marked `[truncated: ...]`, the member ended without a useful report, or you need a result again later, and say which.');
    });

    it('asks for a stated reason whenever a role default model or effort is overridden', () => {
      expect(text).toContain("Whenever you override a role's default model or effort, say why in one short clause, in the team plan or in that member's brief; without a reason, keep the default.");
      expect(text).toContain('Every member runs on Sonnet by default');
    });

    it('tells the reviewer brief where the tests live when package.json is not at the root', () => {
      expect(text).toContain('the brief also names its folder (the `projectPath` of `mcp__nimbalyst-host__run_project_tests`, e.g. "web")');
      expect(buildTeamChildAddendum('reviewer')).toContain('pass `projectPath`, e.g. "web", when the package.json is in a subfolder');
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
