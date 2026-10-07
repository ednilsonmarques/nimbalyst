// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { TEAM_LIMITS, teamSpawnRefusal } from '../teamPolicy';

const root = { rootSessionId: 'root', depth: 0 };

describe('teamSpawnRefusal', () => {
  it('uses the approved limits', () => {
    expect(TEAM_LIMITS).toEqual({ maxDepth: 2, maxActive: 3, budget: 8 });
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
