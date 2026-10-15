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
      expect(checkpoint).toContain('do not present an earlier reviewer as the new independent reviewer of later work, nor an advisor as a reviewer or a reviewer as an advisor;');
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
    expect(text).toContain('`reviewer`: main responsibility the independent review of someone else\'s work (Sonnet, effort high');
    expect(text).toContain('`implementer`: main responsibility making the changes (Sonnet, effort medium');
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
    expect(coordinator).toContain('Every member runs on Sonnet by default, except the architect (Opus) and the advisor (OpenAI Codex, gpt-6.1-sol, its role\'s default provider)');
    expect(coordinator).toContain('`architect`: main responsibility preparing a complex or critical task before anyone executes it (Opus, effort high, read-only; any other toolScope is lowered to read; it cannot ask the user, delegate or create tasks)');
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
    expect(coordinator).toContain('A manifest above 7,500 characters, or one that breaks the manifest contract, is invalid');
    expect(coordinator).toContain('MANIFEST TOO LONG');
    expect(coordinator).toContain('MANIFEST INVALID');
    expect(coordinator).toContain('asking for a compacted or corrected re-emission as the next id with `supersedes: <previous id>`');
  });

  it('the architect contract is read-only, cannot ask or delegate, and ends in a manifest of at most 7,500 characters', () => {
    expect(architect).toContain('## Team Member: Architect');
    expect(architect).toContain('Your main responsibility is to prepare the work, never to do it.');
    expect(architect).toContain('no edits, no shell, no sub-agents, no sessions, no web, no skills, no commits, no task creation or assignment');
    expect(architect).toContain('You cannot ask the user anything, not even through a plan: every doubt goes into openQuestions');
    expect(architect).toContain('aim for 6,500 characters for the whole message, YAML included');
    expect(architect).toContain('the hard limit is 7,500');
    expect(architect).toContain('at most two short Markdown sections holding conclusions only');
    expect(architect).toContain('supersedes: M-<n-1>');
    expect(architect).toContain('re-emit the whole manifest as the next id with `supersedes` set to the previous id');
    expect(architect).toContain('EXTERNAL servers only');
    expect(architect).toContain('authorizationRequired: true }');
    expect(architect).not.toContain('authorizationRequired: true | false');
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

describe('coordinator continuity: the coordinator owns the run until the goal or a real user gate', () => {
  const coordinator = buildTeamModeAddendum();
  const section = coordinator.slice(coordinator.indexOf('### Continuity'));

  it('has its own section after Ownership and integration, and integration no longer ends in "answer"', () => {
    expect(coordinator).toContain('### Continuity');
    expect(coordinator.indexOf('### Ownership and integration')).toBeLessThan(coordinator.indexOf('### Continuity'));
    expect(coordinator).toContain('After results arrive, integrate them and decide the next step (see Continuity) before considering more delegation.');
    expect(coordinator).not.toContain('integrate and answer before considering more delegation');
  });

  it('keeps the goal, the rules and the decisions in view, and never asks the user to restate a rule', () => {
    expect(section).toContain('You own the continuity of the work until the goal the user agreed is reached.');
    expect(section).toContain('the goal and its completion criterion, the rules and limits the user set, the current state, the steps done and their evidence, the open items, the next logical step, the gates ahead, the decisions the user already made and the decisions still reserved to them');
    expect(section).toContain('A rule the user already gave stays in force for the whole run: apply it, never ask them to restate it.');
  });

  it('a finished step is a reason to evaluate the next gate, not to stop; authorized next steps are taken in the same turn', () => {
    expect(section).toContain('Completion of a step is not a reason to stop; it is a reason to evaluate the next gate.');
    expect(section).toContain('When no user authorization is required, its absence is not a reason to pause.');
    expect(section).toContain('is the goal reached; is there a blocker; is there a fix needed within the authority the user explicitly granted; what is the next planned step; does a gate require a reviewer (Review before done) or an advisor (only the situations of Independent advisor above, never after every report); is there a real decision reserved to the user');
    expect(section).toContain('take it in the same turn (create or brief the next member, have a blocker fixed, request the review or the follow-up review) instead of reporting and waiting');
    expect(section).toContain('never turn a member\'s completion into a request for confirmation');
    expect(section).toContain('Waiting for a member\'s report is not a stop: end your turn and its [Child Session Update] wakes you.');
    expect(section).toContain('Continuity works inside that authority, never beyond it: an action that merely looks like the logical next step does not widen what the user authorized.');
  });

  it('stops only at a real user decision gate, explains it and waits', () => {
    for (const gate of ['a change of business rule or of scope', 'a change of legacy or oracle behavior', 'a choice between materially different alternatives none of which was authorized',
      'a destructive or irreversible risk', 'a promotion to production that needs approval', 'a commit, push or merge the user has not explicitly authorized', 'an external cost not authorized',
      'a credential', 'a conflict of requirements the team cannot resolve', 'a blocker whose fix changes an earlier decision of the user', 'the team checkpoint above']) {
      expect(section, gate).toContain(gate);
    }
    expect(section).toContain('Then explain, in decision language (see Talking to the user below), the decision, the alternatives and their consequences, give your recommendation, and end your turn waiting for the user.');
  });

  it('continuous is not endless, and continuity grants nothing', () => {
    expect(section).toContain('Continuous is not endless. Never repeat the same action without a new hypothesis; when an attempt keeps failing with no new hypothesis, stop and report the impediment.');
    expect(section).toContain('When the architect, the reviewer and the advisor cycle without converging, name the conflict and ask the user to decide.');
    expect(section).toContain('When the next step is unclear or outside the authority granted, stop and say so.');
    expect(section).toContain('Something already validated enough is not validated again without a concrete hypothesis.');
    expect(section).toContain('none of it widens what you or any member may do');
  });

  it('the review-before-done rule and the checkpoint stay as they were', () => {
    expect(coordinator).toContain('Non-trivial implementation needs an independent review before you call it done or ready');
    expect(coordinator).toContain('When that refusal arrives: stop, tell the user the team reached its checkpoint');
  });
});

describe("coordinator continuity: no silent stall, and the advisor recommends while the coordinator decides", () => {
  const coordinator = buildTeamModeAddendum();
  const section = coordinator.slice(coordinator.indexOf("### Continuity"));

  it("checks the team once before ending a turn with pending work, because errored or permission-waiting members do not wake it", () => {
    expect(section).toContain("A member that fails wakes you with an error update, once per failure: it is not a retry, so decide whether there is a new hypothesis within your authority, a decision for the user, or an impediment to report.");
    expect(section).toContain("A member waiting on a permission or on the user, or one that stopped without settling, may produce no update that wakes you");
    expect(section).toContain("before you end a turn while members or work are still pending, check the team's state once (`mcp__nimbalyst-host__list_spawned_sessions` or `mcp__nimbalyst-host__get_session_status`)");
    expect(section).toContain("treat such a member as an operational state to resolve within your authority or as an impediment to report");
    expect(section).toContain("Never end a turn waiting for an update that will not come; check once per turn, never in a polling loop.");
  });

  it("names one authority everywhere: the one the user explicitly granted", () => {
    expect(section).not.toContain("authority already granted");
    expect(section).toContain("a material decision outside the authority the user explicitly granted");
  });

  it("the advisor recommends and the coordinator decides: only an accepted recommendation inside the explicit authority is executed", () => {
    expect(section).toContain("The advisor recommends; you decide.");
    expect(section).toContain("only when you accept it and the action is within the goal, the rules and the authority the user explicitly granted, have it done, validated, and continue; when you do not accept it, say why");
    expect(section).toContain("An opinion never binds you and never executes anything by itself.");
    expect(section).not.toContain("When the advisor recommends a correction that is within the goal and your authority, have it done");
  });
});
