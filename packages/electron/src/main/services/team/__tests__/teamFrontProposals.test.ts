// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  TeamFrontProposalError,
  TeamFrontProposalRegistry,
  normalizeTeamFrontTitle,
  parseTeamFrontProposalArgs,
  validateTeamFrontProposal,
  type TeamFrontProposalPorts,
  type ResolvedTeamFrontProposalItem,
} from '../teamFrontProposals';

const create = (title: string, extra: Record<string, unknown> = {}) => ({ action: 'create', title, description: 'Goal and state.', ...extra });
const change = (frontId: string, status: string, extra: Record<string, unknown> = {}) => ({ action: 'status', frontId, status, ...extra });

function refusal(run: () => unknown, code = 'invalid-arguments'): TeamFrontProposalError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TeamFrontProposalError);
    expect((error as TeamFrontProposalError).code).toBe(code);
    return error as TeamFrontProposalError;
  }
  throw new Error('expected a refusal');
}

describe('team front proposal arguments: refusals first', () => {
  it('refuses anything that is not an object with an items array', () => {
    for (const bad of [undefined, null, 'x', 7, [], { items: 'x' }, { items: [] }, {}]) refusal(() => parseTeamFrontProposalArgs(bad));
  });

  it('refuses an unknown top-level key and an unknown item key', () => {
    expect(refusal(() => parseTeamFrontProposalArgs({ items: [create('A')], extra: 1 })).message).toMatch(/unknown key "extra"/);
    expect(refusal(() => parseTeamFrontProposalArgs({ items: [create('A', { owner: 'me' })] })).message).toMatch(/unknown key "owner"/);
    expect(refusal(() => parseTeamFrontProposalArgs({ items: [change('f1', 'paused', { title: 'x' })] })).message).toMatch(/unknown key "title"/);
  });

  it('refuses currentMission wherever it appears, with its own message', () => {
    expect(refusal(() => parseTeamFrontProposalArgs({ items: [create('A', { currentMission: 'x' })] })).message).toMatch(/currentMission is written only by Nimbalyst/);
    expect(refusal(() => parseTeamFrontProposalArgs({ items: [change('f1', 'paused', { currentMission: 'x' })] })).message).toMatch(/currentMission/);
    expect(refusal(() => parseTeamFrontProposalArgs({ items: [create('A')], currentMission: 'x' })).message).toMatch(/currentMission/);
  });

  it('refuses a __proto__ key and a non-plain item', () => {
    refusal(() => parseTeamFrontProposalArgs(JSON.parse('{"items":[{"action":"create","title":"A","description":"d","__proto__":{"x":1}}]}')));
    refusal(() => parseTeamFrontProposalArgs({ items: [null] }));
    refusal(() => parseTeamFrontProposalArgs({ items: ['create'] }));
    refusal(() => parseTeamFrontProposalArgs({ items: [new Date()] }));
  });

  it('refuses more than 10 items', () => {
    const items = Array.from({ length: 11 }, (_, i) => create(`Front ${i}`));
    expect(refusal(() => parseTeamFrontProposalArgs({ items })).message).toMatch(/limit is 10/);
    expect(parseTeamFrontProposalArgs({ items: items.slice(0, 10) })).toHaveLength(10);
  });

  it('refuses an unknown or missing action', () => {
    refusal(() => parseTeamFrontProposalArgs({ items: [{ title: 'A', description: 'd' }] }));
    refusal(() => parseTeamFrontProposalArgs({ items: [{ action: 'delete', frontId: 'f1' }] }));
  });

  it('bounds the title: required, trimmed, at most 120, no control characters', () => {
    refusal(() => parseTeamFrontProposalArgs({ items: [create('   ')] }));
    refusal(() => parseTeamFrontProposalArgs({ items: [{ action: 'create', description: 'd' }] }));
    refusal(() => parseTeamFrontProposalArgs({ items: [create(42 as never)] }));
    refusal(() => parseTeamFrontProposalArgs({ items: [create('x'.repeat(121))] }));
    expect(parseTeamFrontProposalArgs({ items: [create('x'.repeat(120))] })).toHaveLength(1);
    for (const bad of ['a\nb', 'a\tb', 'a\u0000b', 'a\u007Fb', 'a\u0085b', 'a b', 'a‮b']) {
      refusal(() => parseTeamFrontProposalArgs({ items: [create(bad)] }));
    }
  });

  it('bounds the description: required, at most 2000, no control characters other than line breaks and tabs', () => {
    refusal(() => parseTeamFrontProposalArgs({ items: [{ action: 'create', title: 'A' }] }));
    refusal(() => parseTeamFrontProposalArgs({ items: [{ action: 'create', title: 'A', description: '  ' }] }));
    refusal(() => parseTeamFrontProposalArgs({ items: [{ action: 'create', title: 'A', description: 'x'.repeat(2001) }] }));
    for (const bad of ['a\u0000b', 'a\u001Bb', 'a\u007Fb', 'a b', 'a‮b']) {
      refusal(() => parseTeamFrontProposalArgs({ items: [{ action: 'create', title: 'A', description: bad }] }));
    }
    const ok = parseTeamFrontProposalArgs({ items: [{ action: 'create', title: 'A', description: `Goal:\n\t- one\r\n- two${'x'.repeat(1970)}` }] });
    expect(ok).toHaveLength(1);
  });

  it('refuses an invalid status and a bad front id', () => {
    refusal(() => parseTeamFrontProposalArgs({ items: [create('A', { status: 'done' })] }));
    refusal(() => parseTeamFrontProposalArgs({ items: [change('f1', 'archived')] }));
    refusal(() => parseTeamFrontProposalArgs({ items: [{ action: 'status', frontId: 'f1' }] }));
    for (const bad of ['', 'Team Mode', '../x', 'f1;drop', '-lead', 'x'.repeat(129), 7]) {
      refusal(() => parseTeamFrontProposalArgs({ items: [change(bad as never, 'paused')] }));
    }
  });
});

describe('team front proposal arguments: accepted shape', () => {
  it('normalizes a create (trimmed, status defaults to active) and keeps a status change as is', () => {
    expect(parseTeamFrontProposalArgs({ items: [create('  Portal  ', { description: ' state ' }), create('Billing', { status: 'paused' }), change('tfr_abc-1.x', 'closed')] })).toEqual([
      { action: 'create', title: 'Portal', description: 'state', status: 'active' },
      { action: 'create', title: 'Billing', description: 'Goal and state.', status: 'paused' },
      { action: 'status', frontId: 'tfr_abc-1.x', status: 'closed' },
    ]);
  });
});

function ports(overrides: Partial<TeamFrontProposalPorts> & { fronts?: Array<{ id: string; title: string; status: string | null; archived?: boolean; type?: string }>; missions?: Record<string, string | null> } = {}): TeamFrontProposalPorts {
  const fronts = overrides.fronts ?? [];
  return {
    listFronts: overrides.listFronts ?? (async () => fronts.map((f) => ({ id: f.id, title: f.title, status: f.status, archived: f.archived ?? false }))),
    getFront: overrides.getFront ?? (async (id) => {
      const f = fronts.find((x) => x.id === id);
      return f ? { id: f.id, title: f.title, type: f.type ?? 'team-front', status: f.status, archived: f.archived ?? false, description: null } : null;
    }),
    findActiveMissionRoot: overrides.findActiveMissionRoot ?? (async (id) => (overrides.missions && id in overrides.missions ? { id: `root-${id}`, title: overrides.missions[id] } : null)),
  };
}

const validate = (raw: unknown, p: TeamFrontProposalPorts) => validateTeamFrontProposal(parseTeamFrontProposalArgs(raw), '/ws', p);

async function refused(promise: Promise<unknown>, code: string): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(TeamFrontProposalError);
    expect((error as TeamFrontProposalError).code).toBe(code);
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
}

describe('D2: duplicate titles', () => {
  it('refuses a create whose title equals an existing non-archived front, ignoring case and spacing', async () => {
    const p = ports({ fronts: [{ id: 'f1', title: 'Team  Mode', status: 'active' }] });
    expect(await refused(validate({ items: [create('team mode')] }, p), 'duplicate-title')).toMatch(/already exists/);
    await refused(validate({ items: [create('TEAM MODE')] }, p), 'duplicate-title');
  });

  it('refuses two creates with the same title in one batch', async () => {
    expect(await refused(validate({ items: [create('Portal'), create('PORTAL')] }, ports()), 'duplicate-title')).toMatch(/another item of this proposal/);
  });

  it('allows a title that only an archived front has', async () => {
    const p = ports({ fronts: [{ id: 'f1', title: 'Portal', status: 'closed', archived: true }] });
    expect(await validate({ items: [create('Portal')] }, p)).toHaveLength(1);
  });

  it('compares with one normalisation the write step can reuse', () => {
    expect(normalizeTeamFrontTitle('  Team   MODE ')).toBe(normalizeTeamFrontTitle('team mode'));
  });
});

describe('status changes: existence, D1', () => {
  it('refuses a missing front, a non-front item, an archived front, a no-op and a repeated front', async () => {
    const p = ports({ fronts: [
      { id: 'f1', title: 'Portal', status: 'active' },
      { id: 'bug1', title: 'A bug', status: 'active', type: 'bug' },
      { id: 'old', title: 'Old', status: 'closed', archived: true },
    ] });
    await refused(validate({ items: [change('nope', 'paused')] }, p), 'front-not-found');
    await refused(validate({ items: [change('bug1', 'paused')] }, p), 'front-not-found');
    await refused(validate({ items: [change('old', 'active')] }, p), 'front-not-changeable');
    await refused(validate({ items: [change('f1', 'active')] }, p), 'no-change');
    await refused(validate({ items: [change('f1', 'paused'), change('f1', 'closed')] }, p), 'invalid-arguments');
  });

  it('D1: refuses closing a front that has an active mission, and names the mission', async () => {
    const p = ports({ fronts: [{ id: 'f1', title: 'Portal', status: 'active' }], missions: { f1: 'Portal: tooltips' } });
    const message = await refused(validate({ items: [change('f1', 'closed')] }, p), 'close-with-active-mission');
    expect(message).toMatch(/Portal: tooltips/);
  });

  it('D1: allows pausing it, with the warning on the item', async () => {
    const p = ports({ fronts: [{ id: 'f1', title: 'Portal', status: 'active' }], missions: { f1: 'Portal: tooltips' } });
    expect(await validate({ items: [change('f1', 'paused')] }, p)).toEqual([
      { action: 'status', frontId: 'f1', status: 'paused', frontTitle: 'Portal', fromStatus: 'active', activeMission: { title: 'Portal: tooltips' } },
    ]);
  });

  it('allows closing a front without a mission, and reactivating one', async () => {
    const p = ports({ fronts: [{ id: 'f1', title: 'Portal', status: 'active' }, { id: 'f2', title: 'Old', status: 'paused' }] });
    const out = await validate({ items: [change('f1', 'closed'), change('f2', 'active')] }, p);
    expect(out.map((i) => (i as { activeMission: unknown }).activeMission)).toEqual([null, null]);
  });

  it('reads the mission for every target, so a reactivation carries what existed at proposal time; the ports stay read-only', async () => {
    const findActiveMissionRoot = vi.fn(async () => ({ id: 'root-f2', title: 'Old: cleanup' }));
    const p = ports({ fronts: [{ id: 'f2', title: 'Old', status: 'paused' }], findActiveMissionRoot });
    const [item] = await validate({ items: [change('f2', 'active')] }, p);
    expect(findActiveMissionRoot).toHaveBeenCalledTimes(1);
    expect(item).toMatchObject({ status: 'active', activeMission: { title: 'Old: cleanup' } });
    expect(Object.keys(p).sort()).toEqual(['findActiveMissionRoot', 'getFront', 'listFronts']);
  });
});

const ITEMS: ResolvedTeamFrontProposalItem[] = [{ action: 'create', title: 'Portal', description: 'd', status: 'active' }];

describe('registry: one-shot, bound, one per root', () => {
  it('refuses a second pending proposal for the same root, allows another root', () => {
    const registry = new TeamFrontProposalRegistry();
    registry.register({ rootSessionId: 'r1', workspacePath: '/ws', items: ITEMS });
    expect(() => registry.register({ rootSessionId: 'r1', workspacePath: '/ws', items: ITEMS })).toThrowError(/already waiting/);
    expect(registry.register({ rootSessionId: 'r2', workspacePath: '/ws', items: ITEMS }).rootSessionId).toBe('r2');
    expect(registry.size()).toBe(2);
  });

  it('settles once: the second take finds nothing', () => {
    const registry = new TeamFrontProposalRegistry();
    const proposal = registry.register({ rootSessionId: 'r1', workspacePath: '/ws', items: ITEMS });
    const first = registry.take(proposal.id, { rootSessionId: 'r1', workspacePath: '/ws' });
    expect(first).toMatchObject({ ok: true });
    expect(registry.take(proposal.id, { rootSessionId: 'r1', workspacePath: '/ws' })).toEqual({ ok: false, reason: 'unknown' });
    expect(registry.pendingForRoot('r1')).toBeNull();
    // the root can propose again once settled
    registry.register({ rootSessionId: 'r1', workspacePath: '/ws', items: ITEMS });
  });

  it('refuses another root or another workspace and keeps the proposal pending', () => {
    const registry = new TeamFrontProposalRegistry();
    const proposal = registry.register({ rootSessionId: 'r1', workspacePath: '/ws', items: ITEMS });
    expect(registry.take(proposal.id, { rootSessionId: 'r2', workspacePath: '/ws' })).toEqual({ ok: false, reason: 'mismatch' });
    expect(registry.take(proposal.id, { rootSessionId: 'r1', workspacePath: '/other' })).toEqual({ ok: false, reason: 'mismatch' });
    expect(registry.take('tfp_forged', { rootSessionId: 'r1', workspacePath: '/ws' })).toEqual({ ok: false, reason: 'unknown' });
    expect(registry.take(proposal.id, { rootSessionId: 'r1', workspacePath: '/ws' })).toMatchObject({ ok: true });
  });

  it('stores an unguessable id and a frozen copy of the items', () => {
    const registry = new TeamFrontProposalRegistry();
    const items = structuredClone(ITEMS);
    const a = registry.register({ rootSessionId: 'r1', workspacePath: '/ws', items });
    const b = registry.register({ rootSessionId: 'r2', workspacePath: '/ws', items });
    expect(a.id).toMatch(/^tfp_[0-9a-f-]{36}$/);
    expect(a.id).not.toBe(b.id);
    (items[0] as { title: string }).title = 'changed after registering';
    expect((a.items[0] as { title: string }).title).toBe('Portal');
    expect(() => { (a.items[0] as { title: string }).title = 'x'; }).toThrow();
  });

  it('discard and discardRoot free the root', () => {
    const registry = new TeamFrontProposalRegistry();
    const a = registry.register({ rootSessionId: 'r1', workspacePath: '/ws', items: ITEMS });
    registry.discard(a.id);
    expect(registry.size()).toBe(0);
    registry.register({ rootSessionId: 'r1', workspacePath: '/ws', items: ITEMS });
    registry.discardRoot('r1');
    expect(registry.pendingForRoot('r1')).toBeNull();
    registry.discardRoot('nobody');
  });
});

describe('invisible characters in a title (D2 look-alikes)', () => {
  it('refuses zero-width characters and the BOM, so "Billing" and "Billing<ZWSP>" cannot both exist', async () => {
    for (const bad of ['Billing​', 'Bill‌ing', 'Bill‍ing', 'Bill⁠ing', 'Bill﻿ing']) {
      expect(refusal(() => parseTeamFrontProposalArgs({ items: [create(bad)] })).message, JSON.stringify(bad)).toMatch(/invisible/);
    }
    // the visible original is still fine and D2 still catches a real duplicate
    const p = ports({ fronts: [{ id: 'f1', title: 'Billing', status: 'active' }] });
    await refused(validate({ items: [create('billing')] }, p), 'duplicate-title');
  });
});

describe('format and blank-looking characters in a title (every \\p{Cf}, plus the Hangul fillers)', () => {
  const cases: Array<[string, string]> = [
    ['soft hyphen U+00AD', 'Bill\u00ADing'],
    ['zero-width space U+200B', 'Billing\u200B'],
    ['word joiner U+2060', 'Bill\u2060ing'],
    ['invisible operators U+2061', 'Bill\u2061ing'],
    ['invisible plus U+2064', 'Bill\u2064ing'],
    ['Mongolian vowel separator U+180E', 'Bill\u180Eing'],
    ['tag character U+E0041', 'Bill\u{E0041}ing'],
    ['bidi override U+202E', 'Bill\u202Eing'],
    ['bidi isolate U+2067', 'Bill\u2067ing'],
    ['byte order mark inside U+FEFF', 'Bill\uFEFFing'],
    ['Hangul filler U+3164', 'Bill\u3164ing'],
    ['Hangul choseong filler U+115F', 'Bill\u115Fing'],
    ['Hangul jungseong filler U+1160', 'Bill\u1160ing'],
  ];

  for (const [name, title] of cases) {
    it(`refuses ${name} in a title`, () => {
      expect(refusal(() => parseTeamFrontProposalArgs({ items: [create(title)] })).message).toMatch(/invisible/);
    });
  }

  it('does not touch ordinary text, accents, emoji or other scripts in a title', () => {
    for (const title of ['Billing', 'Cobran\u00E7a', 'Portal \u2014 v2', '\u30C1\u30FC\u30E0', '\u{1F680} Launch', 'caf\u00E9 e\u0301']) {
      expect(parseTeamFrontProposalArgs({ items: [create(title)] })).toHaveLength(1);
    }
  });

  it('keeps the description rules as they are: a zero-width character there is not refused', () => {
    expect(parseTeamFrontProposalArgs({ items: [create('A', { description: 'Goal\u200B and state.' })] })).toHaveLength(1);
  });

  it('"Billing<ZWSP>" can never coexist with "Billing" because it is refused before D2 compares', async () => {
    const p = ports({ fronts: [{ id: 'f1', title: 'Billing', status: 'active' }] });
    expect(() => parseTeamFrontProposalArgs({ items: [create('Billing\u200B')] })).toThrow(/invisible/);
    await refused(validate({ items: [create('billing')] }, p), 'duplicate-title');
  });
});
