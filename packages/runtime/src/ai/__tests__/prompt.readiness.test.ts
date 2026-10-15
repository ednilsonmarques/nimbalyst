// @vitest-environment node
/**
 * Mission readiness (clarification gate, adaptive questioning, execution
 * contract, method by mission type): autonomy scales with clarity. Scenarios
 * A-J are checked as the contract the coordinator receives, by concept rather
 * than exact wording; the per-type items are checked one by one because the
 * coordinator must not get more than the type needs.
 */
import { describe, expect, it } from 'vitest';
import { buildMissionReadinessSection, buildTeamChildAddendum, buildTeamModeAddendum } from '../prompt';

const coordinator = buildTeamModeAddendum();
const noNotes = buildTeamModeAddendum('claude', false);
const advisor = buildTeamChildAddendum('advisor');

const sectionOf = (text: string, heading: string) => {
  const start = text.indexOf(`### ${heading}`);
  if (start < 0) return '';
  const next = text.indexOf('\n### ', start + 5);
  return text.slice(start, next < 0 ? undefined : next);
};
const readiness = sectionOf(coordinator, 'Mission readiness');
const clarification = sectionOf(coordinator, 'Clarification');
const contract = sectionOf(coordinator, 'Execution contract');
const method = sectionOf(coordinator, 'Method by mission type');
const continuity = sectionOf(coordinator, 'Continuity');

describe('the readiness gate is part of the coordinator contract, in the right place', () => {
  it('comes after the Team plan and before any execution rule, and only the coordinator receives it', () => {
    for (const section of [readiness, clarification, contract, method]) expect(section).not.toBe('');
    expect(coordinator.indexOf('### Team plan')).toBeLessThan(coordinator.indexOf('### Mission readiness'));
    expect(coordinator.indexOf('### Method by mission type')).toBeLessThan(coordinator.indexOf('### Review before done'));
    for (const role of ['explorer', 'implementer', 'reviewer', 'architect', 'advisor', 'other'] as const) {
      expect(buildTeamChildAddendum(role), role).not.toContain('### Mission readiness');
      expect(buildTeamChildAddendum(role), role).not.toContain('### Execution contract');
    }
  });

  it('autonomy scales with clarity: ambiguity reduces execution authority, no creative interpretation of a material gap', () => {
    expect(readiness).toMatch(/Autonomy scales with clarity: ambiguity reduces execution authority/);
    expect(readiness).toMatch(/Never start a materially ambiguous mission just because there is enough information to do something/);
    expect(readiness).toMatch(/never fill a material gap with a creative interpretation/);
  });

  it('judges the eight dimensions', () => {
    for (const dimension of ['objective (', 'scope (', 'source of truth (', 'completion criterion (', 'authority (', 'constraints (', 'evidence (', 'material ambiguities (']) {
      expect(readiness, dimension).toContain(dimension);
    }
  });

  it('lists the hard blockers once, and Continuity cites them instead of keeping its own list', () => {
    for (const blocker of ['a business rule', 'the expected behavior', 'the source of truth', 'the scope', 'an architecture choice that is the user\'s to make', 'the completion criterion', 'the authority', 'a destructive or irreversible risk', 'security', 'existing data', 'compatibility', 'a promotion to production', 'an unauthorized external cost']) {
      expect(readiness, blocker).toContain(blocker);
    }
    expect(readiness).toMatch(/A purely cosmetic detail is never a hard blocker/);
    expect(continuity).toMatch(/a hard blocker of Mission readiness above, at the start or discovered during the work/);
    expect(continuity).not.toMatch(/could change the result, the scope, a business rule/);
  });

  it('hard blockers prevail over the score: no threshold rule, a blocker means NOT READY even at 95', () => {
    expect(readiness).toMatch(/the score never decides alone: a hard blocker means NOT READY even at 95/);
    expect(readiness).toMatch(/a low score without a hard blocker calls for more research, not more questions/);
    expect(coordinator).not.toMatch(/\b\d{2} points? (means|=)|score (above|of at least) \d+ (means|=)/i);
    // No threshold in any wording ("above 80, proceed", ">= 80"): the only number is the 95 counterexample.
    expect(readiness).not.toMatch(/\b(?:above|below|over|under|at least|>=|≥)\s*\d{2}\b/i);
  });
});

describe('scenarios A-J', () => {
  it('A: a simple, clear task is executed directly, with no readiness line and no questions', () => {
    expect(readiness).toMatch(/A trivial, clear task needs none of this: no readiness line, no questions, just the SOLO plan and the work/);
    expect(clarification).toMatch(/none for a clear task/);
    // The visible line is an instruction for four moments, not a decoration of every reply.
    expect(readiness).toMatch(/write it as one line in four moments only: right after the Team plan line when a non-trivial mission starts, before your questions when it is NOT READY, when a reassessment changes it, and when the user asks/);
    expect(readiness).toMatch(/Never in other replies and never for a trivial task/);
  });

  it('B: a small reversible gap is READY WITH ASSUMPTIONS: stated, recorded, and the work goes on', () => {
    expect(readiness).toMatch(/READY WITH ASSUMPTIONS \(no hard blocker; small gaps that are non-material, low-impact, consistent with the rules already set and reversible, covered by assumptions you state and record/);
    expect(readiness).toMatch(/I will name the internal helper normalizeName/);
    // An assumption is never a back door.
    expect(readiness).toMatch(/An assumption never settles a business rule, never widens authority, never chooses an oracle, never changes legacy behavior and never changes an observable contract/);
  });

  it('C: an ambiguous business rule is NOT READY: no material work, the user is asked first', () => {
    expect(readiness).toMatch(/NOT READY — CLARIFY \(at least one hard blocker\)/);
    expect(clarification).toMatch(/While NOT READY, do no material work/);
    expect(clarification).toMatch(/Investigation never settles a business rule, an authority or the choice of an oracle: the repository shows how the system behaves today, not what the business requires/);
    expect(clarification).toMatch(/Then ask only the hard-blocker questions/);
  });

  it('D: a conflicting source of truth is a hard blocker', () => {
    expect(readiness).toMatch(/a missing or conflicting answer that could materially change .*the source of truth/);
  });

  it('E: a critical but well specified mission is READY: criticality alone is not a reason to ask', () => {
    expect(readiness).toMatch(/Criticality alone is not a reason to ask: a critical mission whose brief already answers the hard-blocker questions is READY/);
  });

  it('F: new evidence that breaks a premise forces reassessment and stops at the right gate', () => {
    expect(contract).toMatch(/The contract is alive/);
    expect(contract).toMatch(/reassess readiness/);
    expect(contract).toMatch(/a new hard blocker lowers autonomy at once: start no new material work and assess each member still running on the broken premise/);
    expect(contract).toMatch(/open a specific user decision gate, with the new readiness line, that says exactly what changed and asks only what is needed/);
    expect(contract).toMatch(/After the decision, update the contract and continue/);
  });

  it('G: a minor ambiguity found mid-way is recorded and the work goes on', () => {
    expect(contract).toMatch(/a minor, reversible gap becomes a recorded assumption and the work goes on/);
    expect(continuity).toMatch(/a minor ambiguity is recorded as an assumption and the work goes on/);
  });

  it('H: a decision the user already made is never asked again', () => {
    expect(clarification).toMatch(/never ask again what the user already decided \(that decision is part of the contract\)/);
    expect(clarification).toMatch(/never re-interrogate a settled point/);
    expect(clarification).toMatch(/Never ask what the files, the Team Notes or earlier messages already answer/);
  });

  it('I: an applicable ECC type gives only its relevant items, never the whole list', () => {
    expect(method).toMatch(/Use the smallest sufficient method/);
    expect(method).toMatch(/only those the mission and the evidence leave open/);
    expect(method).toMatch(/never present a list whole, and never ask an item already answered/);
    const items: Record<string, string[]> = {
      'Legacy or migration': ['the oracle', 'literal or semantic equivalence', 'known defects reproduced or fixed', 'golden cases', 'shadow mode', 'promotion criterion', 'fallback'],
      Security: ['trust boundaries', 'authority', 'fail-open or fail-closed', 'credentials', 'destructive actions', 'rollback'],
      Database: ['backward compatibility', 'existing data', 'rollback', 'downtime', 'who owns the schema'],
      'Public contract or API': ['existing consumers', 'compatibility', 'versioning', 'rollout', 'observability'],
      'Production promotion': ['evidence', 'rollback', 'owner', 'monitoring', 'approval gate'],
    };
    for (const [type, list] of Object.entries(items)) {
      const line = method.split('\n').find((l) => l.startsWith(`- ${type}:`)) ?? '';
      expect(line, type).not.toBe('');
      for (const item of list) expect(line, `${type}: ${item}`).toContain(item);
    }
  });

  it('J: a mission outside those types gets no checklist forced on it', () => {
    expect(method).toMatch(/never apply them to a mission outside the type/);
    expect(method).toMatch(/When the mission falls into one of these types/);
  });
});

describe('adaptive questioning', () => {
  it('researches first and asks only what requires the user\'s judgment', () => {
    expect(clarification).toMatch(/Research what you can; ask only what requires the user's judgment/);
    expect(clarification).toMatch(/read-only investigation is fine when it can settle a technical fact/);
  });

  it('questions are few, specific, easy, decision-oriented, grouped, with options and a recommendation, and scale with risk', () => {
    expect(clarification).toMatch(/few, specific, easy to answer and decision-oriented, grouped in one message, each with its options and your recommendation when you have one/);
    expect(clarification).toMatch(/Scale the depth with the risk, the ambiguity, the size, the reversibility, the impact and how far the evidence can be trusted/);
    expect(clarification).toMatch(/one to three for a moderate gap, more only when a critical mission truly leaves several material decisions open/);
    expect(clarification).toMatch(/never ask to confirm a routine step/);
  });

  it('no question loop: a new answer reopens only the new material gap', () => {
    expect(clarification).toMatch(/a new round is valid only when the previous answer revealed a material gap that was not reasonably visible before; ask only that/);
  });

  it('frank about an ill-defined mission, never inventing a doubt (Identity Layer)', () => {
    expect(clarification).toMatch(/When the mission is too ill-defined to release the team, say so plainly/);
    expect(clarification).toMatch(/never invent a doubt to look careful/);
  });
});

describe('execution contract and continuity', () => {
  it('consolidates the contract fields and shows the user only what they need', () => {
    for (const field of ['goal', 'scope and out of scope', 'source of truth', 'invariants', 'granted authority', 'decisions reserved to the user', 'completion criterion', 'validation strategy', 'reviewer and advisor gates', 'accepted assumptions', 'known risks', 'rollback when material']) {
      expect(contract, field).toContain(field);
    }
    expect(contract).toMatch(/Show the user only what they need, in a few lines/);
  });

  it('once READY after the user\'s answers, execution starts in the same turn, without asking to continue', () => {
    expect(contract).toMatch(/When readiness came from the user's answers, start the execution in the same turn: never ask whether to continue/);
    expect(contract).toMatch(/Readiness never replaces Continuity: once READY, you own the continuity and do not go back to asking for routine confirmations/);
    expect(continuity).toMatch(/Completion of a step is not a reason to stop/);
  });

  it('briefs, the reviewer and the advisor draw on the contract; a TEAM mission records it as one Team Note when trackers are on', () => {
    expect(contract).toMatch(/Briefs, the reviewer's checklist and the advisor's brief draw on the contract/);
    expect(coordinator).toMatch(/the contract's completion criterion when there is one/);
    expect(coordinator).toMatch(/the goal of the task and the core of the execution contract/);
    expect(contract).toMatch(/For a TEAM mission, record its distilled core as one Team Note \(decision\) and update that note when the contract changes/);
    const offline = sectionOf(noNotes, 'Execution contract') + sectionOf(noNotes, 'Clarification');
    expect(offline).not.toBe('');
    expect(offline).not.toContain('Team Note');
  });
});

describe('the advisor contests readiness but never owns it; nothing gains authority', () => {
  it('the advisor may contest a READY and recommend going back to clarification; the gate stays the coordinator\'s', () => {
    expect(advisor).toMatch(/The mission's readiness is a premise too: when a READY classification hides a material ambiguity, an assumption settles something that is the user's to decide, or the source of truth turns out to conflict, say so and recommend going back to clarification/);
    expect(advisor).toMatch(/The readiness gate stays the coordinator's; you do not run it/);
    expect(continuity).toMatch(/the advisor may contest a READY, point out a forgotten ambiguity or a risky assumption, or recommend going back to clarification, but the readiness gate stays yours/);
    // Still read-only and without authority.
    expect(advisor).toContain('You have read-only tools and nothing else');
    expect(advisor).toContain('Your opinion binds nobody');
  });

  it('readiness grants nothing: no new tool, permission or authority word, and the user gates stay', () => {
    const all = readiness + clarification + contract + method;
    expect(all).not.toMatch(/you may (commit|push|merge|promote)|without (asking|approval) you may|grants? you/i);
    expect(readiness).toMatch(/An assumption never settles a business rule, never widens authority/);
    expect(continuity).toMatch(/a commit, push or merge the user has not explicitly authorized/);
    expect(buildMissionReadinessSection('`send_prompt`')).toContain('`send_prompt` only queues guidance');
  });
});

describe('final polish (Reviewer N1-N6)', () => {
  it('1 (N1): reversibility alone never makes a decision non-material; materiality comes first', () => {
    expect(readiness).toMatch(/Materiality comes first and reversibility never cancels it/);
    expect(readiness).toMatch(/reversibility is one factor among others/);
    expect(readiness).toMatch(/a decision of behavior, rule, contract or semantics can be material even when it is technically easy to revert/);
    expect(readiness).toMatch(/"git revert is easy" is never enough to call a decision non-material/);
    expect(readiness).not.toMatch(/easily reversible detail is never a hard blocker/);
    // READY WITH ASSUMPTIONS needs all four conditions, not reversibility alone.
    expect(readiness).toMatch(/non-material, low-impact, consistent with the rules already set and reversible/);
  });

  it('2 (N2): the pt-BR fallback example is gone; assumption examples are technical and local', () => {
    expect(coordinator).not.toMatch(/pt-BR as the fallback|fallback because it is already the project default/);
    expect(readiness).toMatch(/I will name the internal helper normalizeName/);
    expect(readiness).toMatch(/I will put the new tests in a new file next to the existing ones/);
    expect(readiness).toMatch(/never chooses an oracle, never changes legacy behavior and never changes an observable contract/);
  });

  it('3 (N3): "you decide" is an explicit delegation of that decision, recorded, decided on evidence, and not asked again', () => {
    expect(clarification).toMatch(/When the user delegates a specific decision \("you decide", "pick the best", "do as you think best", "you can decide"\), that is an explicit delegation of that decision only/);
    expect(clarification).toMatch(/record that it was delegated, decide it on the evidence, the rules, the risk and the goal, record the choice and its reason in one line, and continue without asking it again/);
  });

  it('4 (N3): a delegation widens no global authority and replaces no reserved gate', () => {
    expect(clarification).toMatch(/A delegation covers only that decision: it widens no other authority, allows nothing outside policy and replaces no gate still reserved to the user/);
  });

  it('5 (N3): clarification converges without a rigid numeric cap, and fragmentation ends in a higher-level question', () => {
    expect(clarification).toMatch(/Clarification must converge: each round must reduce material ambiguity/);
    expect(clarification).toMatch(/When the questions start to fragment without converging, stop asking one by one: sum up the conflict, explain why the mission is still not executable, and ask for a higher-level decision or a reformulation/);
    expect(clarification).toMatch(/Never turn clarification into an endless conversation/);
    expect(clarification).not.toMatch(/at most \d+ rounds?|\b\d+ rounds? (at most|maximum)/i);
  });

  it('6 (N4): a technical architecture choice the team can settle is not a user gate', () => {
    expect(readiness).toMatch(/a technical architecture choice is not a question for the user by default; the team first tries to settle it on technical evidence/);
    expect(readiness).toMatch(/It becomes a user decision gate only when the alternatives differ materially in requirements, cost, risk, contract or operation and none of them was authorized, or when technical evidence alone cannot settle it/);
    expect(readiness).toMatch(/Otherwise settle it technically, record why, and continue/);
    expect(readiness).not.toMatch(/a relevant architecture/);
  });

  it('7 (N5): send_prompt is described as a queue, never as a pause; interrupt only where allowed, with its cost', () => {
    expect(contract).toMatch(/send_prompt.* only queues guidance; it does not stop a turn already running/);
    expect(contract).toMatch(/When letting that turn finish is safe, send the new information, let it finish, and discard or reassess its result against the updated contract/);
    expect(contract).toMatch(/interrupt it only where the tool and the policy allow \(the `interrupt` option of .*send_prompt.*\), knowing that the interrupted turn's work may be lost, and resume it on the updated contract/);
    expect(contract).not.toMatch(/\bpause through\b/);
  });

  it('8 (N6): while NOT READY an explorer is preferred, and an architect stays possible when the gap is truly architectural', () => {
    expect(clarification).toMatch(/with the cheapest sufficient means: your own reads or an explorer first/);
    expect(clarification).toMatch(/an architect only when the gap is truly architectural, reads and an explorer are not enough, and an architectural analysis is needed to make the mission READY/);
    expect(clarification).not.toMatch(/never (create|use) an architect/i);
  });
});
