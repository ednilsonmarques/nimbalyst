// @vitest-environment node
/**
 * User decision language: when the coordinator, the architect, the reviewer or
 * the advisor talk to the user directly, they speak in decision language (the
 * problem, why it matters, the choices, the consequences, the recommendation,
 * what the user must decide) and keep the internal terms in parentheses.
 * Conversational clarity for the user, technical precision for the project.
 * Communication only: no gate, role, scope or authority changes.
 */
import { describe, expect, it } from 'vitest';
import {
  buildTeamChildAddendum,
  buildTeamModeAddendum,
  buildUserFacingCommunicationSection,
} from '../prompt';

const coordinator = buildTeamModeAddendum();
const architect = buildTeamChildAddendum('architect');
const reviewer = buildTeamChildAddendum('reviewer');
const advisor = buildTeamChildAddendum('advisor');
const operational = (['implementer', 'explorer', 'other'] as const).map((role) => [role, buildTeamChildAddendum(role)] as const);

const sectionOf = (text: string, heading = '### Talking to the user') => {
  const start = text.indexOf(heading);
  if (start < 0) return '';
  const next = text.indexOf('\n### ', start + 5);
  return text.slice(start, next < 0 ? undefined : next);
};
const CORE = 'Conversational clarity for the user; technical precision for the project.';

describe('one shared contract, no new role or agent', () => {
  it('the coordinator, architect, reviewer and advisor share the same core, once each', () => {
    for (const text of [coordinator, architect, reviewer, advisor]) {
      expect(text.split('### Talking to the user').length - 1).toBe(1);
      expect(sectionOf(text)).toContain(CORE);
      expect(sectionOf(text)).toMatch(/what the problem is, why it matters, which real choices exist, what changes with each, the risks, what the team recommends, and what exactly the user has to decide/);
    }
  });

  it('the operational roles get nothing, and no translator, summarizer or new role appears', () => {
    for (const [role, text] of operational) {
      expect(text, role).not.toContain('### Talking to the user');
      expect(buildUserFacingCommunicationSection(role), role).toBe('');
    }
    for (const text of [coordinator, architect, reviewer, advisor]) {
      expect(sectionOf(text)).not.toMatch(/translator|summarizer|new role|new member|create_session|spawn_session/i);
    }
  });
});

describe('1: coordinator, plain language before the technical term', () => {
  const section = sectionOf(coordinator);

  it('explains in plain words first and keeps the internal name in parentheses', () => {
    expect(section).toMatch(/say what the thing is in plain words first and keep the internal name in parentheses for traceability/);
    expect(section).toMatch(/Members report to you in technical language; translate their findings for the user instead of passing their codes on, and keep the codes in parentheses/);
    expect(section).toMatch(/Bad: "A\.7b: rule N, P or nothing\?"/);
    expect(section).toMatch(/We found a rare difference in how altered arrays are handled \(A\.7b\)/);
    expect(section).toMatch(/tighten the validation \(rule N\)/);
    expect(section).toMatch(/Which way do you want to go\?/);
  });

  it('covers every channel to the user, the widget included', () => {
    expect(section).toMatch(/applies whenever a reply to them carries a decision, a finding or a member's report/);
    expect(section).toMatch(/Mission readiness questions, user decision gates, the team checkpoint/);
    // A routine reply is not inflated into the decision format.
    expect(section).toMatch(/a routine reply stays short/);
    expect(section).not.toMatch(/every reply to them/);
    expect(section).toMatch(/the plain explanation and your recommendation go in your message before the options, and each option says in plain words what choosing it means/);
    // The Continuity gate points to the contract instead of repeating it.
    expect(coordinator).toMatch(/Then explain, in decision language \(see Talking to the user below\), the decision, the alternatives and their consequences/);
  });
});

describe('2: architect, a purely technical choice never becomes a user question', () => {
  const section = sectionOf(architect);

  it('settles technical choices in the team and raises only material impact', () => {
    expect(section).toMatch(/A purely technical choice the team can settle is never framed as a question for the user/);
    expect(section).toMatch(/settle it in your trade-offs when the evidence allows, or leave it in openQuestions as a technical question for the team, with your assumption/);
    expect(section).toMatch(/Raise to the user only what materially changes behavior, a contract, cost, risk, compatibility, scope, schedule or operation/);
    expect(section).toMatch(/explain the architecture by its impact: why the choice exists, what changes in the project, and whether it is a technical choice or one of product or business rule; module names never replace the explanation/);
  });

  it('its manifest stays technical and its read-only seat is unchanged', () => {
    expect(section).toMatch(/Your manifest and your reports to the coordinator stay technical/);
    expect(architect).toContain('You cannot ask the user anything, not even through a plan: every doubt goes into openQuestions with the assumption you proceed on.');
  });
});

describe('2b: coordinator, a technical choice the team can settle is not the user\'s decision', () => {
  it('points to the Architecture rule instead of restating it', () => {
    expect(sectionOf(coordinator)).toMatch(/What the team can settle technically is settled and recorded \(see Architecture in Mission readiness\) and never presented to the user as their decision/);
    expect(coordinator).toMatch(/Otherwise settle it technically, record why, and continue/);
  });
});

describe('3: reviewer, verdict and impact before details', () => {
  const section = sectionOf(reviewer);

  it('opens a direct answer with a plain synthesis, details after', () => {
    expect(section).toMatch(/start with a plain synthesis before any detail: approved or not, whether there is a blocker, what really matters, what has to be redone, and whether a decision of theirs is needed; the technical details come after/);
  });

  it('its report to the coordinator stays technical, with the same Verdict line', () => {
    expect(section).toMatch(/Your report to the coordinator stays technical and starts with its Verdict line/);
    expect(reviewer).toContain('Start your report with `Verdict: no blockers` or `Verdict: blockers found`');
  });
});

describe('4: advisor, real severity apart from technical detail', () => {
  const section = sectionOf(advisor);

  it('turns the discussion into consequences and says what really matters', () => {
    expect(section).toMatch(/turn the discussion into consequences: say whether the problem really matters, separate a real risk from a technical detail, say whether it is worth fixing now or can go to the backlog, and challenge the team's recommendation when the evidence supports it/);
    expect(section).toMatch(/this looks scary in the report, but in practice it does not block the step/);
    expect(section).toMatch(/this one does deserve your decision, because it changes product behavior/);
    expect(section).toMatch(/Plain, never academic/);
  });

  it('its opinion for the coordinator keeps the fixed format', () => {
    expect(section).toMatch(/Your opinion for the coordinator keeps the format of your final message below/);
    expect(section).not.toMatch(/format above/);
    expect(advisor.indexOf('### Talking to the user')).toBeLessThan(advisor.indexOf('### Your final message: independent opinion'));
    for (const marker of ['no material objections', 'approved with reservations', 'correct before proceeding', 'reconsider the approach']) {
      expect(advisor).toContain(`Independent opinion: ${marker}`);
    }
  });
});

describe('5: Mission readiness questions use decision language', () => {
  it('a material question explains what is at stake and its consequence before any internal code', () => {
    expect(coordinator).toMatch(/each with its options and your recommendation when you have one, and each in decision language \(see Talking to the user below\): what is at stake and its consequence first, the internal code only in parentheses, never "Confirm N6\?"/);
  });

  it('the readiness rules themselves are unchanged', () => {
    expect(coordinator).toMatch(/Then ask only the hard-blocker questions: few, specific, easy to answer and decision-oriented, grouped in one message/);
    expect(coordinator).toMatch(/a hard blocker means NOT READY even at 95/);
    expect(coordinator).toMatch(/While NOT READY, do no material work/);
  });
});

describe('6: technical terms stay for traceability', () => {
  it('no term is hidden; it is translated and kept in parentheses', () => {
    for (const text of [coordinator, architect, reviewer, advisor]) {
      const section = sectionOf(text);
      expect(section).toMatch(/Hide no technical term; translate it/);
      expect(section).toMatch(/three tests only make sense if the internal lap count becomes part of the formal contract \(RT3, RT26, RT27\)", never "Confirm RT3\/RT26\/RT27\?"/);
      expect(section).toMatch(/explain them one by one, each keeping its internal name in parentheses/);
      expect(section).not.toMatch(/omit the (code|term|id)|drop the (code|term|id)|without the internal name/i);
    }
  });
});

describe('7: internal artifacts are not translated', () => {
  it('artifacts and inter-member communication stay technical and precise', () => {
    for (const text of [coordinator, architect, reviewer, advisor]) {
      const section = sectionOf(text);
      expect(section).toMatch(/The translation is for the conversation only/);
      for (const artifact of ['Code', 'commits', 'documentation', 'tests', 'logs', 'Team Notes', 'tracker items', 'Tool Manifests', 'briefs, opinions and reports to other members', 'every persisted artifact stay technical and precise']) {
        expect(section, artifact).toContain(artifact);
      }
    }
    // Without trackers the rule stands, minus the Team Notes it cannot name.
    const noNotes = sectionOf(buildTeamModeAddendum('claude', false));
    expect(noNotes).toMatch(/every persisted artifact stay technical and precise/);
    expect(noNotes).not.toContain('Team Note');
  });

  it('the professional register for artifacts in the working identity is untouched', () => {
    expect(coordinator).toMatch(/Conversational personality belongs in the conversation; persistent project artifacts stay professional/);
    expect(coordinator).toMatch(/clear, professional register, with no swearing, slang or jokes/);
  });
});

describe('8: no authority changes', () => {
  it('the contract states it is communication only', () => {
    for (const text of [coordinator, architect, reviewer, advisor]) {
      expect(sectionOf(text)).toContain('This changes how you explain, never what you may decide or do, and it moves no gate.');
      expect(sectionOf(text)).not.toMatch(/you may (now )?(commit|push|merge|edit|run)|authoriz(e|ation) to/i);
    }
  });

  it('the authority rules around it are intact', () => {
    expect(coordinator).toMatch(/Stop and call the user only at a real user decision gate, a material decision outside the authority the user explicitly granted/);
    expect(coordinator).toMatch(/a commit, push or merge the user has not explicitly authorized/);
    expect(coordinator).toMatch(/The advisor recommends; you decide/);
    expect(reviewer).toMatch(/you have no shell and never edit anything/);
    expect(advisor).toContain('You have read-only tools and nothing else');
    expect(advisor).toContain('Your opinion binds nobody');
    expect(architect).toContain('You have read-only tools and nothing else');
  });

  it('the section sits after the authority it may not override', () => {
    expect(coordinator.indexOf('### Continuity')).toBeLessThan(coordinator.indexOf('### Talking to the user'));
    expect(coordinator.indexOf('### Working identity')).toBeLessThan(coordinator.indexOf('### Talking to the user'));
    expect(advisor.indexOf('You have read-only tools and nothing else')).toBeLessThan(advisor.indexOf('### Talking to the user'));
    expect(reviewer.indexOf('you have no shell and never edit anything')).toBeLessThan(reviewer.indexOf('### Talking to the user'));
  });
});

describe('9: personality stays allowed in the direct conversation, never forced', () => {
  it('the coordinator and the advisor keep their working identity register', () => {
    for (const text of [coordinator, advisor]) {
      expect(sectionOf(text)).toMatch(/Clarity is not stiffness: the register of your working identity still applies/);
      expect(sectionOf(text, '### Working identity')).toMatch(/Informality, humor, irony, sarcasm and a mild swear word may come on your own initiative/);
      expect(sectionOf(text, '### Working identity')).toMatch(/never force it/);
    }
  });

  it('plain, never childish or condescending; the architect and the reviewer gain no persona', () => {
    for (const text of [coordinator, architect, reviewer, advisor]) {
      expect(sectionOf(text)).toMatch(/Assume the user understands well once the problem is explained: plain, direct and simple, never childish or condescending/);
    }
    for (const text of [architect, reviewer]) {
      expect(text).not.toMatch(/swear|humor|irony|informal/i);
    }
  });
});

describe('10: several decisions are grouped by impact', () => {
  it('no dump of a technical list; how many really need the user, then one by one', () => {
    for (const text of [coordinator, architect, reviewer, advisor]) {
      const section = sectionOf(text);
      expect(section).toMatch(/Several decisions are never dumped as a technical list: group them by impact, say how many the user really has to decide and which ones follow from those/);
      expect(section).toMatch(/you need to decide three things now; the other four follow from them/);
    }
  });

  it('fact, team recommendation, own recommendation and the user\'s decision are kept apart', () => {
    for (const text of [coordinator, architect, reviewer, advisor]) {
      expect(sectionOf(text)).toMatch(/Keep apart what is fact or evidence, what the team or a member recommends \(say who\), what you recommend, and what is reserved to the user; never present a recommendation as a fact/);
    }
  });
});
