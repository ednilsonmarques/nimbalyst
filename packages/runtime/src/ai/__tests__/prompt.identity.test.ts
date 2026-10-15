// @vitest-environment node
/**
 * Identity Layer (working partner): HOW a session works and talks with the
 * user, below safety, authority, role and mission. Full for the coordinator
 * and the advisor, principles only for the architect and the reviewer, nothing
 * for the operational roles. Contracts are checked by concept, not by exact
 * wording, except for the precedence statement, which must not drift.
 */
import { describe, expect, it } from 'vitest';
import { buildTeamChildAddendum, buildTeamModeAddendum, buildWorkingIdentitySection } from '../prompt';

const coordinator = buildTeamModeAddendum();
const advisor = buildTeamChildAddendum('advisor');
const architect = buildTeamChildAddendum('architect');
const reviewer = buildTeamChildAddendum('reviewer');
const operational = (['implementer', 'explorer', 'other'] as const).map((role) => [role, buildTeamChildAddendum(role)] as const);

const identityOf = (text: string) => {
  const start = text.indexOf('### Working identity');
  if (start < 0) return '';
  const next = text.indexOf('\n### ', start + 5);
  return text.slice(start, next < 0 ? undefined : next);
};
const principlesOf = (text: string) => {
  const start = text.indexOf('### Working principles');
  if (start < 0) return '';
  const next = text.indexOf('\n### ', start + 5);
  return text.slice(start, next < 0 ? undefined : next);
};
const PRECEDENCE = 'This shapes how you work and communicate, never what you may do: safety and authority come first, then your role, then your mission; it never widens your scope, creates an authorization, skips a gate, changes a business rule or overrides your mission.';

describe('who receives the Identity Layer', () => {
  it('1: the coordinator receives the full working identity, with its own line as the user\'s interface', () => {
    const identity = identityOf(coordinator);
    expect(identity).not.toBe('');
    expect(identity).toMatch(/competent working partner/);
    expect(identity).toMatch(/goal is ill-defined/);
    expect(identity).toMatch(/never hide a material doubt to look autonomous/);
  });

  it('2: the advisor receives the full working identity, frank but still read-only, consultative and without executive authority', () => {
    const identity = identityOf(advisor);
    expect(identity).not.toBe('');
    expect(identity).toMatch(/frankness is your job/);
    expect(identity).toMatch(/coordinator, the reviewer or the user is wrong/);
    expect(identity).toMatch(/read-only, consultative, with no executive authority/);
    // The validated advisor contract is untouched around it.
    expect(advisor).toContain('You have read-only tools and nothing else');
    expect(advisor).toContain('Your opinion binds nobody');
    expect(advisor).toContain('Synthesis governs how you report, not how deep you look');
  });

  it('architect and reviewer inherit the principles only: honesty, independence, no automatic agreement, precision, no persona', () => {
    for (const text of [architect, reviewer]) {
      const principles = principlesOf(text);
      expect(principles).not.toBe('');
      expect(principles).toMatch(/evidence, not deference/);
      expect(principles).toMatch(/Never invent an objection/);
      expect(principles).toMatch(/Precision first/);
      expect(text).not.toContain('### Working identity');
      expect(text).not.toMatch(/swear|humor|irony|informal/i);
    }
  });

  it('4: the operational roles (implementer, explorer, other) get no personality at all', () => {
    for (const [role, text] of operational) {
      expect(text, role).not.toContain('### Working identity');
      expect(text, role).not.toContain('### Working principles');
      expect(text, role).not.toMatch(/swear|humor|irony|informal|working partner/i);
      expect(buildWorkingIdentitySection(role), role).toBe('');
    }
  });
});

describe('the Identity Layer never outranks safety, authority, role or mission', () => {
  it('3: every identity section states the precedence and that it grants nothing', () => {
    for (const section of [identityOf(coordinator), identityOf(advisor), principlesOf(architect), principlesOf(reviewer)]) {
      expect(section).toContain(PRECEDENCE);
    }
  });

  it('it sits after the authority rules it may not override: the advisor\'s read-only seat and the coordinator\'s checkpoint and continuity', () => {
    expect(advisor.indexOf('You have read-only tools and nothing else')).toBeLessThan(advisor.indexOf('### Working identity'));
    expect(coordinator.indexOf('### Team checkpoint')).toBeLessThan(coordinator.indexOf('### Working identity'));
    expect(coordinator.indexOf('### Continuity')).toBeLessThan(coordinator.indexOf('### Working identity'));
    expect(architect.indexOf('You have read-only tools and nothing else')).toBeLessThan(architect.indexOf('### Working principles'));
  });
});

describe('anti-sycophancy without manufactured opposition', () => {
  const full = [identityOf(coordinator), identityOf(advisor)];

  it('5: nothing tells a session to agree automatically; agreement comes from evidence', () => {
    for (const text of [coordinator, advisor, architect, reviewer]) {
      expect(text).not.toMatch(/always agree|agree with the user by default|defer to the user/i);
    }
    for (const section of full) {
      expect(section).toMatch(/Agreement must come from evidence, not deference/);
      expect(section).toMatch(/Do not agree by default/);
    }
  });

  it('6: disagreement must be grounded: why, and the better alternative when there is one', () => {
    for (const section of full) {
      expect(section).toMatch(/say so plainly, explain why, and give the better alternative when there is one/);
    }
  });

  it('agreeing when the user is right is valid, and inventing a counterpoint is forbidden', () => {
    for (const section of full) {
      expect(section).toMatch(/When the user is right, agree plainly/);
      expect(section).toMatch(/never invent a counterpoint to look independent/);
    }
  });

  it('7: informality, humor, sarcasm and a mild swear word may come on the session\'s own initiative, calibrated, never forced, never a substitute for precision', () => {
    for (const section of full) {
      expect(section).toMatch(/real working partner, not an over-polished corporate assistant/);
      expect(section).toMatch(/frankness matters more than artificial politeness/);
      expect(section).toMatch(/Informality, humor, irony, sarcasm and a mild swear word may come on your own initiative/);
      expect(section).toMatch(/Adapt the intensity to the context/);
      expect(section).toMatch(/freedom of register, not an obligation/);
      expect(section).toMatch(/never force it, never swear to manufacture a personality/);
      expect(section).toMatch(/never be gratuitously aggressive/);
      expect(section).toMatch(/never let style replace technical precision/);
      // No "only if the user swore first" gate: initiative is allowed.
      expect(section).not.toMatch(/user (swore|used that register) first|only (when|if) the user/i);
    }
  });

  it('register: the loose register stays in the conversation, persistent artifacts and inter-member messages stay professional, just as frank', () => {
    for (const section of full) {
      expect(section).toMatch(/Conversational personality belongs in the conversation; persistent project artifacts stay professional/);
      // The conversation keeps its freedom: informality and a mild swear word on the session's own initiative, no "user first" gate.
      expect(section).toMatch(/loose register is for your direct conversation with the user/);
      // The boundary is semantic, not storage: a stored chat history is still conversation.
      expect(section).toMatch(/The conversation with the user is not a project artifact for the purposes of this register rule, even though its history is stored/);
      expect(section).toMatch(/the line is what you are writing and for whom, not where it is kept/);
      expect(section).toMatch(/a mild swear word may come on your own initiative/);
      expect(section).not.toMatch(/user (swore|used that register) first|only (when|if) the user/i);
      // Artifacts and operational communication are professional and clean.
      expect(section).toMatch(/clear, professional register, with no swearing, slang or jokes/);
      for (const artifact of ['code and code comments', 'documentation', 'commit messages', 'Team Notes', 'tracker items', 'Tool Manifests', 'session titles and tags', 'briefs, missions, messages and reports to other members', 'persisted reports', 'read by third parties']) {
        expect(section, artifact).toContain(artifact);
      }
      // Register only: frankness and independence are not reduced.
      expect(section).toMatch(/changes the register, never the frankness or the independence/);
      expect(section).toMatch(/still says plainly "this approach is inadequate because X", without softening the criticism/);
    }
    // Without trackers the rule stands, minus the Team Notes it cannot name.
    const noNotes = identityOf(buildTeamModeAddendum('claude', false));
    expect(noNotes).toMatch(/clear, professional register, with no swearing, slang or jokes/);
    expect(noNotes).not.toContain('Team Note');
  });

  it('advisor channel: loose with the user directly, professional in every opinion for another member, with the same frankness, depth and markers', () => {
    const identity = identityOf(advisor);
    expect(identity).toMatch(/When the user talks to you directly, this whole identity applies, the looser register included/);
    expect(identity).toMatch(/Your opinion for the coordinator or another member is operational communication between agents and is always written in the professional register, even when it is later shown to the user/);
    expect(identity).toMatch(/changes the register only, never the frankness, the independence or the depth of your opinion/);
    expect(identity).toMatch(/the fixed "Independent opinion:" lines stay as they are/);
    // No room for an "informal persisted opinion".
    expect(identity).not.toMatch(/persisted or materialized|informal (opinion|report)/i);
    // The fixed marker lines of the contract are unchanged.
    for (const marker of ['no material objections', 'approved with reservations', 'correct before proceeding', 'reconsider the approach']) {
      expect(advisor).toContain(`Independent opinion: ${marker}`);
    }
    // Read-only and consultative: the channel rule grants nothing.
    expect(identity).toMatch(/read-only, consultative, with no executive authority/);
    expect(identity).toContain(PRECEDENCE);
  });

  it('the advisor keeps its personality and calibrates its tone with judgment, without becoming less consultative', () => {
    const identity = identityOf(advisor);
    expect(identity).toMatch(/calibrate your tone with judgment/);
    expect(identity).toMatch(/Informality, humor, irony, sarcasm and a mild swear word may come on your own initiative/);
    expect(identity).toMatch(/read-only, consultative, with no executive authority/);
  });

  it('8: praise and enthusiasm are not encouraged by default; the goal is better decisions, not pleasing', () => {
    for (const section of full) {
      expect(section).toMatch(/do not praise ideas by default/);
      expect(section).toMatch(/artificial enthusiasm/);
      expect(section).toMatch(/not for pleasing them/);
      expect(section).not.toMatch(/great idea|compliment|be enthusiastic/i);
    }
  });

  it('N1: the coordinator objects once, waits when the decision is the user\'s, then follows an explicit decision without pretending to agree', () => {
    const identity = identityOf(coordinator);
    expect(identity).toMatch(/state the objection plainly, with its consequence and the better alternative/);
    expect(identity).toMatch(/when the decision is the user's, wait for it/);
    expect(identity).toMatch(/Once the user decides explicitly, record it \("my recommendation was X; the user decided Y"\) and follow it/);
    expect(identity).toMatch(/following it is not pretending to agree/);
    expect(identity).toMatch(/Reopen it only on new material evidence, a risk unknown when it was taken, a conflict with safety or authority, or when it stops applying/);
    expect(identity).toMatch(/never loop on an argument already settled/);
    expect(identity).toMatch(/as long as it is safe and within policy/);
  });

  it('widget: an objection is written in the message, the options only complement it', () => {
    const identity = identityOf(coordinator);
    expect(identity).toMatch(/If you ask through the options widget, write the objection, why it matters and your recommendation in your message before the options/);
    expect(identity).toMatch(/the options complement your reasoning, they never carry it alone/);
  });

  it('N2: a material ambiguity is a user gate, a minor one is an assumption', () => {
    expect(coordinator).toMatch(/the objective or a material requirement too ambiguous to proceed safely/);
    // The list of what makes an ambiguity material lives once, in Mission readiness.
    expect(coordinator).toMatch(/meaning a hard blocker of Mission readiness above, at the start or discovered during the work/);
    expect(coordinator).toMatch(/could materially change a business rule, the expected behavior, the source of truth, the scope, an architecture choice that is the user's to make \(see Architecture below\), the completion criterion, the authority/);
    expect(coordinator).toMatch(/a minor ambiguity is recorded as an assumption and the work goes on/);
  });

  it('the member contracts stay provider-neutral', () => {
    expect(identityOf(advisor)).not.toMatch(/openai|codex|gpt-|claude-code|provider/i);
  });
});
