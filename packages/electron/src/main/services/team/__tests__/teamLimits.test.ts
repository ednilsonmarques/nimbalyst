// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  TEAM_LIMITS,
  extendedTeamBudget,
  isTeamBudgetExhausted,
  resolveAuthorizedTeamBudget,
  teamSpawnRefusal,
} from '../teamPolicy';

const root = { rootSessionId: 'root', depth: 0 };

describe('teamSpawnRefusal', () => {
  it('uses the approved limits', () => {
    expect(TEAM_LIMITS).toEqual({ maxDepth: 2, maxActive: 3, budget: 8, budgetExtension: 4 });
  });

  it('allows a spawn under every limit', () => {
    expect(teamSpawnRefusal(root, { total: 7, active: 2 })).toBeNull();
    expect(teamSpawnRefusal({ rootSessionId: 'root', depth: 1 }, { total: 0, active: 0 })).toBeNull();
  });

  it('depth: a grandchild (depth 2) cannot create anyone', () => {
    expect(teamSpawnRefusal({ rootSessionId: 'root', depth: 2 }, { total: 0, active: 0 })).toMatch(/Team depth limit reached/);
  });

  it('budget: the 9th session is refused', () => {
    expect(teamSpawnRefusal(root, { total: 8, active: 0 })).toMatch(/Team budget reached: .* 8\/8/);
  });

  it('parallelism: a 4th active session is refused', () => {
    expect(teamSpawnRefusal(root, { total: 3, active: 3 })).toMatch(/3\/3 sessions are already active/);
  });
});

describe('team checkpoint', () => {
  it('the refusal says it is a checkpoint only the user can move, and forbids the workarounds', () => {
    const refusal = teamSpawnRefusal(root, { total: 8, active: 0 })!;
    expect(refusal).toContain('which is its checkpoint');
    expect(refusal).toContain('Only the user can authorize more');
    expect(refusal).toContain('"Continue team"');
    expect(refusal).toContain('no tool and no session can');
    expect(refusal).toContain('ask them to continue the team');
    expect(refusal).toContain("Do not change a member's role, do the work yourself or skip the independent review");
    expect(refusal).toContain('Team member: report this to your coordinator');
  });

  it('names the action as the user sees it, so the coordinator points to a button that exists', () => {
    const english = teamSpawnRefusal(root, { total: 8, active: 0 })!;
    expect(english).toContain('with the "Continue team" action now shown');
    expect(english).toContain('naming the action exactly as "Continue team"');

    const portuguese = teamSpawnRefusal(root, { total: 8, active: 0 }, 8, 'Continuar equipe')!;
    expect(portuguese).toContain('with the "Continuar equipe" action now shown');
    expect(portuguese).toContain('naming the action exactly as "Continuar equipe"');
    expect(portuguese).not.toContain('Continue team');
    // Only the label is localized: the pilot report still recognizes the refusal.
    expect(portuguese).toMatch(/^Team budget reached: this team has already created 8\/8 sessions/);
  });

  it('keeps the opening the pilot report script matches', () => {
    expect(teamSpawnRefusal(root, { total: 8, active: 0 })).toMatch(/^Team budget reached: this team/);
  });

  it('an authorized budget of 12 lets the 9th to 12th session through and stops the 13th', () => {
    for (const total of [8, 9, 10, 11]) expect(teamSpawnRefusal(root, { total, active: 0 }, 12)).toBeNull();
    expect(teamSpawnRefusal(root, { total: 12, active: 0 }, 12)).toMatch(/Team budget reached: .* 12\/12/);
  });

  it('each continuation adds 4: 8, 12, 16', () => {
    expect(extendedTeamBudget(8)).toEqual({ authorized: 12, extensions: 1 });
    expect(extendedTeamBudget(12)).toEqual({ authorized: 16, extensions: 2 });
  });

  it('a root without the key, or with a malformed one, is authorized for the initial 8', () => {
    for (const metadata of [
      undefined, null, 'teamBudget', [], {}, { teamMode: true },
      { teamBudget: null }, { teamBudget: 12 }, { teamBudget: { authorized: '12' } },
      { teamBudget: { authorized: 12.5 } }, { teamBudget: { authorized: Infinity } },
    ]) expect(resolveAuthorizedTeamBudget(metadata), JSON.stringify(metadata)).toBe(8);
  });

  it('a stored budget never lowers the initial one', () => {
    expect(resolveAuthorizedTeamBudget({ teamBudget: { authorized: 4 } })).toBe(8);
    expect(resolveAuthorizedTeamBudget({ teamBudget: { authorized: -1 } })).toBe(8);
    expect(resolveAuthorizedTeamBudget({ teamBudget: { authorized: 12, extensions: 1 } })).toBe(12);
  });

  it('is at the checkpoint exactly when everything authorized has been created', () => {
    expect(isTeamBudgetExhausted({ total: 7, active: 0 }, 8)).toBe(false);
    expect(isTeamBudgetExhausted({ total: 8, active: 0 }, 8)).toBe(true);
    expect(isTeamBudgetExhausted({ total: 8, active: 0 }, 12)).toBe(false);
  });

  it('continuing the team does not move the active or the depth limit', () => {
    expect(teamSpawnRefusal(root, { total: 9, active: 3 }, 12)).toMatch(/3\/3 sessions are already active/);
    expect(teamSpawnRefusal({ rootSessionId: 'root', depth: 2 }, { total: 9, active: 0 }, 12)).toMatch(/Team depth limit reached/);
    expect(teamSpawnRefusal({ rootSessionId: 'root', depth: 1 }, { total: 9, active: 2 }, 12)).toBeNull();
  });
});
