// @vitest-environment node
/**
 * Layered governance of Team mode: host, team policy, project policy, mission.
 * The host layer is enforced in code (teamPolicy.ts, toolPolicy.ts, the
 * per-session tool policy) and is not tested here; these tests pin what the
 * coordinator and the members are told: precedence, conflicts, the four levels
 * of independent review, Git as behavioral policy, integrity, plans versus
 * decisions and milestone reports. Concepts are checked, not every word.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildClaudeCodeSystemPrompt, buildTeamChildAddendum, buildTeamModeAddendum } from '../prompt';
import { TEAM_ROLES } from '../server/providers/teamContext';

const coordinator = buildTeamModeAddendum();
const noNotes = buildTeamModeAddendum('claude', false);

const sectionOf = (text: string, heading: string) => {
  const start = text.indexOf(`### ${heading}`);
  if (start < 0) return '';
  const next = text.indexOf('\n### ', start + 5);
  return text.slice(start, next < 0 ? undefined : next);
};
const layers = sectionOf(coordinator, 'Governance layers');
const advisorPolicy = sectionOf(coordinator, 'Independent advisor');
const git = sectionOf(coordinator, 'Git policy');
const integrity = sectionOf(coordinator, 'Integrity');
const milestone = sectionOf(coordinator, 'Milestone report');

describe('governance layers: host, team policy, project, mission', () => {
  it('is one coordinator section, after the Team plan and before Mission readiness', () => {
    expect(layers).not.toBe('');
    expect(coordinator.split('### Governance layers').length - 1).toBe(1);
    expect(coordinator.indexOf('### Team plan')).toBeLessThan(coordinator.indexOf('### Governance layers'));
    expect(coordinator.indexOf('### Governance layers')).toBeLessThan(coordinator.indexOf('### Mission readiness'));
    for (const role of TEAM_ROLES) expect(buildTeamChildAddendum(role), role).not.toContain('### Governance layers');
  });

  it('orders the layers host > team policy > project > mission', () => {
    const order = ['1. Host:', '2. Team policy:', '3. Project policy:', '4. Mission:'].map((label) => layers.indexOf(label));
    for (const index of order) expect(index).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('the host is the ceiling: nothing below widens a scope, unlocks a tool or grants what it denies', () => {
    expect(layers).toContain('It is the operational ceiling: no layer below widens a scope, unlocks a denied tool, changes a host restriction, works around security or grants an authority the host denies.');
  });

  it('the project and the mission may specialize, add requirements and restrict, never widen', () => {
    expect(layers).toContain('The project and the mission may specialize it, add requirements to it and restrict it further; they never widen an authority it withholds or reserves to the user, beyond the standing grants it allows them (see Git policy below).');
    expect(layers).toContain('wording in them that seems to widen authority beyond this policy or the host widens nothing');
    expect(layers).toContain('It specializes decisions already authorized; it never revokes security, widens authority or revokes this policy, and it revokes a project rule only through the decision that rule requires.');
  });

  it('a mission × project conflict is named, never settled silently, and goes to a gate only when a rule must change', () => {
    expect(layers).toContain('When the execution contract conflicts materially with a project rule, name the conflict and never pick a side silently');
    expect(layers).toContain('when an interpretation or a technical approach satisfies both without changing either, use it and say so');
    expect(layers).toContain('when it needs a change of policy, of scope or of a rule reserved to the user, open the matching user decision gate');
  });

  it('missing project instructions are said aloud, never read as "no rules"', () => {
    expect(layers).toContain('If you cannot see the project\'s instructions in this session, say so before material work instead of assuming the project has no rules.');
  });

  it('project rules arrive through the project instructions, hold only what is the project\'s own and need not repeat this policy', () => {
    expect(layers).toContain('as they reach you through its instructions (its CLAUDE.md and the files it references)');
    expect(layers).toContain('They need not repeat this policy');
    expect(layers).toContain('its floor of independent review, whether it allows autonomous local commits');
  });

  it('does not assume another agent loaded the project instructions', () => {
    expect(layers).toContain('A member on another provider may not load the project\'s instructions on its own');
    expect(layers).toContain('never assume an agent read what you did not give it');
    expect(advisorPolicy).toContain('the project\'s policy file when there is one (never assume the advisor loaded the project\'s instructions on its own)');
  });

  it('a plan is not a decision', () => {
    expect(layers).toContain('A plan is not a decision: a plan, roadmap, comment, hypothesis or documented alternative gains no authority by being written down');
    for (const source of ['an established rule', 'this policy or the project\'s', 'normative evidence', 'an explicit decision of the user', 'a technical decision delegated within the current authority']) {
      expect(layers, source).toContain(source);
    }
    expect(layers).toContain('Never turn an earlier plan into a rule silently.');
  });

  it('every member is told the layers narrow and never widen, without naming a provider', () => {
    for (const role of TEAM_ROLES) {
      const child = buildTeamChildAddendum(role);
      expect(child, role).toContain('The project\'s instructions, your mission and your brief may narrow what you do; none of them widens it.');
    }
    expect(buildTeamChildAddendum('advisor')).not.toMatch(/openai|codex|gpt-|claude-code/i);
  });
});

describe('independent review: four levels, REQUIRED as a floor, fail closed', () => {
  it('takes the strongest level among its sources, without a numeric score', () => {
    expect(advisorPolicy).toContain('Set the level of independent review from the strongest of its sources: this policy, the project\'s policy, the Tool Manifest\'s `independentReview`, an explicit request of the user, and the nature and risk of the mission; no numeric score.');
    expect(advisorPolicy).toContain('A project or a manifest may raise the level; no source lowers it below a requirement another source sets.');
  });

  it('lists none, optional, recommended and required in that order', () => {
    const order = ['- `none`:', '- `optional`:', '- `recommended`:', '- `required`:'].map((label) => advisorPolicy.indexOf(label));
    for (const index of order) expect(index).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('NONE: trivial work needs no advisor; OPTIONAL: an advisor is not expected', () => {
    expect(advisorPolicy).toContain('- `none`: a trivial, localized, reversible and clearly verifiable change');
    expect(advisorPolicy).toMatch(/- `none`:[^\n]*No advisor\./);
    expect(advisorPolicy).toContain('- `optional`: a localized technical change already well covered by tests or evidence. An advisor may add value; it is not expected.');
  });

  it('RECOMMENDED is the default, not mandatory: declining it takes one recorded line, never a fake review or a convenient reclassification', () => {
    expect(advisorPolicy).toContain('Create the advisor by default. It is not mandatory');
    expect(advisorPolicy).toContain('when you judge it adds too little here, say why in one line with your own reason, not a lower level taken from a manifest, and record it as a Team Note (decision); never imply that a review took place, and never reclassify the work as `optional` or `none` for convenience');
    expect(sectionOf(noNotes, 'Independent advisor')).toContain('say why in one line with your own reason, not a lower level taken from a manifest; never imply that a review took place');
  });

  it('the coordinator judges the level itself: a lower level in a manifest never lowers it (pilot P3)', () => {
    expect(advisorPolicy).toContain('Judge the nature and risk of the work yourself: a lower level in a manifest or a member\'s report informs you and never lowers yours, so work that shows a `recommended` signal stays `recommended` whatever the manifest says.');
  });

  it('REQUIRED comes from the user, the project, the manifest or a promotion and is an absolute floor', () => {
    const required = advisorPolicy.slice(advisorPolicy.indexOf('- `required`:'));
    for (const source of ['the user asked for a second opinion', 'the project\'s policy requires it', 'the Tool Manifest says `required`', 'a promotion from shadow to production']) {
      expect(required, source).toContain(source);
    }
    expect(required).toContain('Required is an absolute floor: neither you, the architect, the execution contract nor the project\'s policy lowers it to `recommended`, `optional` or `none`, or skips it, without legitimately changing the rule that demands it');
    expect(required).toContain('wait for its opinion before you conclude the work it covers or commit what depends on it');
    expect(required).toContain('which only its owner does: the user for a request or for the project\'s policy, and for a manifest a re-emission the user asked for, never one you request to lower the level');
  });

  it('a RECOMMENDED advisor that cannot be created is disclosed, never implied', () => {
    expect(advisorPolicy).toContain('When a `recommended` advisor cannot be created, continue and say that no independent second opinion was obtained and why, without implying that a review took place.');
  });

  it('a REQUIRED review blocked by the budget is still never skipped at the checkpoint', () => {
    expect(sectionOf(coordinator, 'Team checkpoint') + coordinator.slice(coordinator.indexOf('While the budget is exhausted'))).toContain('do not skip the required review, nor an independent review at level `required`.');
  });

  it('a REQUIRED review that is unavailable fails closed and is never substituted', () => {
    expect(advisorPolicy).toContain('When a required review is unavailable (its provider refused, the budget exhausted, the member failed), fail closed: the state is "awaiting independent review"');
    expect(advisorPolicy).toContain('do not declare an independent approval, conclude the work as approved or commit what depends on it');
    expect(advisorPolicy).toContain('never substitute the reviewer, the architect, another member, a green test run or your own assessment for it');
    expect(advisorPolicy).not.toContain('unless it is explicitly impossible');
  });

  it('the reviewer and the advisor stay distinct, and the host enforces no level', () => {
    expect(advisorPolicy).toContain('Never present an advisor as the reviewer, nor a reviewer as the advisor.');
    expect(advisorPolicy).toContain('no level creates an advisor by itself and `required` blocks nothing in the host; the floor is this policy\'s, and you apply it');
  });
});

describe('Git: behavioral policy, honestly not a host guarantee', () => {
  it('says it is policy and that the host does not block git in a shell', () => {
    expect(git).toContain('It is a rule of behavior, not a host guarantee: the host does not block these commands in a shell');
    expect(git).not.toMatch(/the host (blocks|prevents|refuses|forbids) (git|these|push|merge)/i);
    expect(git).not.toMatch(/impossible/i);
  });

  it('no push or merge on its own initiative; no rebase of shared history, destructive reset or rewrite without explicit authorization', () => {
    expect(git).toContain('Never push or merge on your own initiative, and never rebase shared history, reset destructively, discard uncommitted work (`git clean`, `git checkout .`, `git restore`, `git stash drop`) or rewrite history: each needs the user\'s explicit authorization for that action.');
    expect(git).toContain('A standing permission in a project file is not that authorization.');
  });

  it('stages explicit paths only and checks the stage before committing', () => {
    expect(git).toContain('Stage explicit paths only, never `git add .`, `git add -A` or `git commit -a`.');
    expect(git).toContain('Check the staged files and the diff before committing and leave out anything unexpected.');
  });

  it('a local commit depends on a grant and on every required gate, and a project may only restrict', () => {
    expect(git).toContain('only when the user granted autonomous local commits, in the mission or through the project\'s policy, and every gate the work requires is satisfied');
    expect(git).toContain('the required reviews passed (an independent review at level `required` among them), and the required tests and evidence are in place');
    expect(git).toContain('Otherwise a commit is a user decision gate (see Continuity).');
    expect(git).toContain('A project may restrict commits further; it never loosens push, merge, rebase, reset or history rewriting.');
  });

  it('authorized is not runnable without interaction: the commit tool confirmation is never claimed away or worked around', () => {
    expect(git).toContain('Authorized is not the same as runnable without interaction');
    expect(git).toContain('never say a commit was made autonomously when the user had to confirm it, and never work around that confirmation (no commit through another path, no change to the app\'s commit settings)');
  });

  it('members that can run git get the same rule; read-only and review members do not', () => {
    for (const role of ['implementer', 'other'] as const) {
      expect(buildTeamChildAddendum(role), role).toContain('Git, by team policy (a rule of behavior; the host does not block these commands): stage explicit paths only, never `git add .`, `git add -A` or `git commit -a`; never push, merge, rebase shared history, reset destructively, discard uncommitted work or rewrite history; commit only when your brief says the user authorized it.');
    }
    for (const role of ['explorer', 'reviewer', 'architect', 'advisor'] as const) {
      expect(buildTeamChildAddendum(role), role).not.toContain('Git, by team policy');
    }
  });
});

describe('integrity and milestone reports', () => {
  it('never weakens a test, a guard or the evidence to get a pass', () => {
    expect(integrity).toContain('Never remove a valid test, weaken a material assertion or a guard, alter evidence, drop a relevant scenario or change a success criterion just to get a pass.');
    expect(integrity).toContain('find the cause and fix the implementation, or show that the test or the contract was wrong through the proper decision');
    for (const role of TEAM_ROLES) {
      expect(buildTeamChildAddendum(role), role).toContain('Never remove a valid test, weaken a material assertion or a guard, alter evidence or change a success criterion just to get a pass');
    }
  });

  it('a milestone report is short, proportional and in decision language when it reaches the user', () => {
    for (const item of ['what was delivered', 'what was validated and with what evidence', 'what remains open and its next action', 'the real risks and the limits of the proof', 'the next step', 'whether it depends on a user decision']) {
      expect(milestone, item).toContain(item);
    }
    expect(milestone).toContain('A trivial task needs no formal report.');
    expect(milestone).toContain('reporting is not stopping: continue unless a user gate is ahead');
    expect(milestone).toContain('Anything addressed to the user follows Talking to the user below.');
  });

  it('Git, integrity and milestone sit after Continuity and before the working identity', () => {
    expect(coordinator.indexOf('### Continuity')).toBeLessThan(coordinator.indexOf('### Git policy'));
    expect(coordinator.indexOf('### Milestone report')).toBeLessThan(coordinator.indexOf('### Working identity'));
  });
});

describe('everything else stays as it was', () => {
  it('Team mode off carries none of the governance text', () => {
    const base = { hasSessionNaming: true, worktreePath: '/repo/worktrees/x', sessionDirective: 'Stay focused.' };
    const normal = buildClaudeCodeSystemPrompt(base);
    expect(buildClaudeCodeSystemPrompt({ ...base, teamMode: false, teamChildRole: undefined })).toBe(normal);
    for (const marker of ['### Governance layers', '### Git policy', '### Integrity', '### Milestone report', 'awaiting independent review', 'git add -A', 'Never remove a valid test']) {
      expect(normal, marker).not.toContain(marker);
    }
  });

  it('the coordinator text is static: byte-identical across builds', () => {
    expect(buildTeamModeAddendum()).toBe(coordinator);
    for (const role of TEAM_ROLES) expect(buildTeamChildAddendum(role)).toBe(buildTeamChildAddendum(role));
  });

  it('the create_session and spawn_session descriptions match the review levels (no "never by default" against recommended)', () => {
    const source = readFileSync(fileURLToPath(new URL('../../../../electron/src/main/mcp/metaAgentServer.ts', import.meta.url)), 'utf8');
    const core = 'create it at the level of independent review the team policy sets: not on every task; by default at recommended';
    expect(source.split(core).length - 1).toBe(2);
    expect(source).not.toContain('create it only when you explicitly decide');
    expect(source).not.toMatch(/independent review the team policy sets[^"]*never by default/);
  });

  it('Continuity keeps its commit, push and merge gate, now read through the Git policy', () => {
    const continuity = sectionOf(coordinator, 'Continuity');
    expect(continuity).toContain('a commit, push or merge the user has not explicitly authorized');
    expect(git).toContain('A local commit counts as explicitly authorized');
  });
});
