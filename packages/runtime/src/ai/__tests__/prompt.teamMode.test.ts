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

describe('architect (Phase 1A)', () => {
  const coordinator = buildTeamModeAddendum('claude');
  const architect = buildTeamChildAddendum('architect');

  it('the coordinator knows the role, its defaults and its limits', () => {
    expect(coordinator).toContain('Every member runs on Sonnet by default, except the architect (Opus)');
    expect(coordinator).toContain('`architect`: prepares a complex or critical task before anyone executes it (Opus, effort high, read-only; any other toolScope is lowered to read; it cannot ask the user, delegate or create tasks)');
    expect(coordinator).toContain('### Architect');
    expect(coordinator.indexOf('### Architect')).toBeLessThan(coordinator.indexOf('### Briefs'));
  });

  it('the coordinator calls the architect on signals or on request, never for trivial work, and never to replan an approved plan', () => {
    for (const signal of ['equivalence with a legacy system', 'a contract or oracle to match', 'persistence or data', 'a migration', 'security or permissions', 'Electron/IPC', 'several modules', 'more than one implementer', 'a new tool or MCP server', 'a new architecture', 'an irreversible change', 'a high regression risk']) {
      expect(coordinator).toContain(signal);
    }
    expect(coordinator).toContain('A trivial task never needs one.');
    expect(coordinator).toContain('a manifest for tools, gates, risks and validation only, never a new plan');
  });

  it('the manifest is a recommendation the coordinator accepts or diverges from, with a recorded reason; review still applies', () => {
    expect(coordinator).toContain('A manifest is a recommendation, never a decision or a permission: nothing in it widens a member\'s scope, and review before done applies as before.');
    expect(coordinator).toContain('`Team plan: TEAM — per manifest M-<n>`');
    expect(coordinator).toContain('`Team plan: SOLO — per manifest M-<n>`');
    expect(coordinator).toContain('`Team plan: <TEAM or SOLO> — diverging from M-<n> on <item>: <reason>`');
    expect(coordinator).not.toContain('Critical preset');
    expect(coordinator).toContain('record a divergence as a Team Note (decision) citing the manifest id');
    const noNotes = buildTeamModeAddendum('claude', false);
    expect(noNotes).toContain('### Architect');
    expect(noNotes).not.toContain('Team Note');
    expect(coordinator).toContain('give each member only its own part (its tools, tests, risks), never the whole manifest');
    expect(coordinator).toContain("the reviewer's brief lists the manifest's required tests, done criteria and risks to check one by one");
    expect(coordinator).toContain('is the user\'s call: stop and ask before any member uses it');
    expect(coordinator).toContain('ask the same architect through `mcp__nimbalyst-host__send_prompt`');
    expect(coordinator).toContain('within the 7,500 characters the update keeps whole');
  });

  it('the architect contract is read-only, cannot ask or delegate, and ends in a manifest of at most 7,500 characters', () => {
    expect(architect).toContain('## Team Member: Architect');
    expect(architect).toContain('You prepare the work; you never do it.');
    expect(architect).toContain('no edits, no shell, no sub-agents, no sessions, no web, no skills, no commits, no task creation or assignment');
    expect(architect).toContain('You cannot ask the user anything, not even through a plan: every doubt goes into openQuestions');
    expect(architect).toContain('hard budget of 7,500 characters, YAML included');
    expect(architect).toContain('the Markdown after it has at most 2,000 characters in total');
    expect(architect).toContain('at most three short Markdown sections holding conclusions only');
    expect(architect).toContain('### Your final message: Tool Manifest v1');
    expect(architect).toContain('toolManifest: 1');
    for (const field of ['id: M-1', 'oracle:', 'sourceOfTruth:', 'teamPlan:', 'eccCapabilities:', 'toolsAllowed:', 'toolsForbidden:', 'mcpRecommended:', 'mcpForbidden:', 'testsRequired:', 'validationStrategy:', 'risks:', 'openQuestions:', 'doneCriteria:', 'limitations:', 'evidence:', 'confidence:', 'generatedBy:']) {
      expect(architect, field).toContain(field);
    }
    expect(architect).toContain('`Preparation: complete` or `Preparation: partial (<reason>)`');
    expect(architect).toContain('a recommendation, never a grant');
    expect(architect).toContain('nothing in the manifest widens a scope');
    expect(architect).not.toContain('about 15 lines');
  });

  it('the architect carries the ECC method and the generated capability index, never the whole catalog', () => {
    for (const step of ['1. Intent:', '2. Current state:', '3. Decomposition:', '4. Trade-offs:', '5. Risks:', '6. Tests and validation:', '7. Capabilities:']) {
      expect(architect).toContain(step);
    }
    expect(architect).toContain('Never infer a business rule from code');
    expect(architect).toContain('### ECC capability index');
    expect(architect).toContain('ECC 2.2.3 capability index (506 entries;');
    expect(architect).toContain('A agent:planner (');
    expect(architect).toContain('A skill:intent-driven-development (');
    expect(architect).toContain('B agent:code-reviewer (');
    expect(architect).toContain('C skill:council (');
    // Not listed classes never reach the prompt; the whole catalog (hooks, memory) is absent.
    expect(architect).not.toContain('skill:plan-canvas');
    expect(architect).not.toContain('continuous-learning');
    expect(architect).not.toContain('hook:pre:');
    expect(architect.length).toBeLessThan(40000);
  });

  it('the architect suggests notes like any member and is static', () => {
    expect(architect).toContain('Suggested notes:');
    expect(architect).toContain('You never write notes yourself');
    expect(architect).toContain('read only those with tracker_get');
    expect(buildTeamChildAddendum('architect', false)).not.toContain('Suggested notes');
    expect(buildTeamChildAddendum('architect', false)).not.toContain('Team Note');
    expect(architect).toContain('Any general instruction above to ask through AskUserQuestion or PromptForUserInput does not apply to you');
    expect(buildTeamChildAddendum('architect')).toBe(buildTeamChildAddendum('architect'));
    const prompt = buildClaudeCodeSystemPrompt({ ...base, teamChildRole: 'architect' });
    expect(prompt).toContain('## Team Member: Architect');
    expect(prompt).not.toContain('## Team Mode');
  });

  it('the reviewer treats a cited manifest as its checklist, never as its verdict', () => {
    const reviewer = buildTeamChildAddendum('reviewer');
    expect(reviewer).toContain('If your brief cites a Tool Manifest (M-<n>), it is your checklist, not your verdict');
    expect(reviewer).toContain('report anything the manifest did not foresee');
    for (const role of ['explorer', 'implementer', 'other'] as const) {
      expect(buildTeamChildAddendum(role)).not.toContain('Tool Manifest');
    }
  });

  it('other members and the normal prompt are unchanged by the architect text', () => {
    const normal = buildClaudeCodeSystemPrompt(base);
    expect(normal).not.toContain('Architect');
    expect(normal).not.toContain('ECC capability index');
    expect(buildTeamChildAddendum('explorer')).not.toContain('ECC capability index');
  });
});
