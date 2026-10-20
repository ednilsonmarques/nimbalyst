/**
 * The Office view-model derives only what the current state asserts: principal
 * state from processing/error, the waiting-for-you marker from the durable
 * pending-prompt bit, and nothing else.
 */
import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '@nimbalyst/runtime';
import { buildTeamForest } from '../../agentTeamGraph';
import {
  buildOfficeRoom,
  NO_SIGNALS,
  OFFICE_PRINCIPAL_STATES,
  officePrincipalState,
  officeWaitingKinds,
  type OfficeMemberSignals,
} from '../officeModel';

function session(id: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: id,
    provider: 'claude-code',
    model: 'claude-code:sonnet',
    sessionType: 'session',
    workspaceId: '/project',
    worktreeId: null,
    parentSessionId: null,
    childCount: 0,
    uncommittedCount: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    messageCount: 0,
    isArchived: false,
    isPinned: false,
    ...overrides,
  };
}

function signals(overrides: Partial<OfficeMemberSignals> = {}): OfficeMemberSignals {
  return { ...NO_SIGNALS, ...overrides };
}

function team() {
  const forest = buildTeamForest([
    session('lead', { teamMode: true, title: 'Coordenação' }),
    session('exp', { createdBySessionId: 'lead', teamRole: 'explorer', createdAt: 2_000 }),
    session('rev', { createdBySessionId: 'lead', teamRole: 'reviewer', createdAt: 3_000 }),
    session('sub', { createdBySessionId: 'exp', teamRole: 'other', createdAt: 4_000 }),
  ]);
  return forest.teams[0];
}

describe('officePrincipalState', () => {
  it('maps the real signals to working, error and idle only', () => {
    expect(officePrincipalState(signals({ processing: true }))).toBe('working');
    expect(officePrincipalState(signals({ errorReported: true }))).toBe('error');
    expect(officePrincipalState(signals())).toBe('idle');
    expect(OFFICE_PRINCIPAL_STATES).toEqual(['working', 'error', 'idle']);
  });

  it('lets a running turn win over an earlier, not yet shown error', () => {
    expect(officePrincipalState(signals({ processing: true, errorReported: true }))).toBe('working');
  });

  it('does not change the principal state when the session waits for the user', () => {
    expect(officePrincipalState(signals({ processing: true, awaitingUser: true }))).toBe('working');
    expect(officePrincipalState(signals({ awaitingUser: true }))).toBe('idle');
    expect(officePrincipalState(signals({ awaitingUser: true, errorReported: true }))).toBe('error');
  });
});

describe('officeWaitingKinds', () => {
  it('is absent unless the durable pending-prompt bit is set', () => {
    expect(officeWaitingKinds(signals())).toBeNull();
    // A loaded prompt list alone does not raise the marker: the views follow the same bit.
    expect(officeWaitingKinds(signals({ pendingPromptTypes: ['permission_request'] }))).toBeNull();
  });

  it('names the kind only when the pending prompt list already does', () => {
    expect(officeWaitingKinds(signals({ awaitingUser: true }))).toEqual(['unknown']);
    expect(
      officeWaitingKinds(
        signals({
          awaitingUser: true,
          pendingPromptTypes: ['ask_user_question_request', 'git_commit_proposal_request', 'ask_user_question_request'],
        }),
      ),
    ).toEqual(['question', 'commit']);
    expect(officeWaitingKinds(signals({ awaitingUser: true, pendingPromptTypes: ['request_user_input_request'] }))).toEqual(['input']);
    expect(officeWaitingKinds(signals({ awaitingUser: true, pendingPromptTypes: ['permission_request'] }))).toEqual(['permission']);
    expect(officeWaitingKinds(signals({ awaitingUser: true, pendingPromptTypes: ['exit_plan_mode_request'] }))).toEqual(['plan']);
  });
});

describe('buildOfficeRoom', () => {
  it('lists the root and every member in tree order with role, provider and model from the session', () => {
    const room = buildOfficeRoom(team(), new Map(), null, 'Sem título');
    expect(room.rootId).toBe('lead');
    expect(room.title).toBe('Coordenação');
    expect(room.isTeamModeRoot).toBe(true);
    expect(room.members.map((m) => [m.sessionId, m.role, m.isRoot])).toEqual([
      ['lead', 'coordinator', true],
      ['exp', 'explorer', false],
      ['sub', 'other', false],
      ['rev', 'reviewer', false],
    ]);
    expect(room.members[1]).toMatchObject({ provider: 'claude-code', model: 'claude-code:sonnet' });
    // Nested member: the creator is named only when it is not the root.
    expect(room.members.find((m) => m.sessionId === 'sub')?.createdBySessionId).toBe('exp');
    expect(room.members.find((m) => m.sessionId === 'exp')?.createdBySessionId).toBeUndefined();
  });

  it('treats a member without signals as idle with no marker (nothing invented)', () => {
    const room = buildOfficeRoom(team(), new Map(), null, 'x');
    for (const member of room.members) {
      expect(member.principal).toBe('idle');
      expect(member.waitingUser).toBeNull();
    }
    expect([room.workingCount, room.waitingUserCount, room.errorCount]).toEqual([0, 0, 0]);
  });

  it('keeps the coordinator idle while members work: no "waiting for a child" state', () => {
    const room = buildOfficeRoom(
      team(),
      new Map([
        ['exp', signals({ processing: true })],
        ['rev', signals({ processing: true })],
      ]),
      null,
      'x',
    );
    const lead = room.members.find((m) => m.sessionId === 'lead')!;
    expect(lead.principal).toBe('idle');
    expect(lead.waitingUser).toBeNull();
    expect(room.workingCount).toBe(2);
  });

  it('counts principal states and markers independently', () => {
    const room = buildOfficeRoom(
      team(),
      new Map([
        ['lead', signals({ processing: true, awaitingUser: true, pendingPromptTypes: ['ask_user_question_request'] })],
        ['exp', signals({ errorReported: true })],
        ['rev', signals({ awaitingUser: true })],
      ]),
      'rev',
      'x',
    );
    const byId = new Map(room.members.map((m) => [m.sessionId, m]));
    expect(byId.get('lead')).toMatchObject({ principal: 'working', waitingUser: ['question'] });
    expect(byId.get('exp')).toMatchObject({ principal: 'error', waitingUser: null });
    expect(byId.get('rev')).toMatchObject({ principal: 'idle', waitingUser: ['unknown'], isActiveSession: true });
    expect(byId.get('lead')?.isActiveSession).toBe(false);
    // The coordinator's open turn is stopped on the user: counted as waiting, not as working.
    expect([room.workingCount, room.waitingUserCount, room.errorCount]).toEqual([0, 2, 1]);
  });

  it('counts as working only the open turns that are not stopped on the user', () => {
    const room = buildOfficeRoom(
      team(),
      new Map([
        ['exp', signals({ processing: true })],
        ['rev', signals({ processing: true, awaitingUser: true })],
      ]),
      null,
      'x',
    );
    expect(room.members.find((m) => m.sessionId === 'rev')?.principal).toBe('working');
    expect([room.workingCount, room.waitingUserCount]).toEqual([1, 1]);
  });

  it('takes the mission only from SessionMeta.teamMission, never from other text', () => {
    const forest = buildTeamForest([
      session('lead', { teamMode: true, title: 'Missão: coordenar tudo' }),
      session('exp', { createdBySessionId: 'lead', teamRole: 'explorer', teamMission: 'Mapear as fontes de dados.', createdAt: 2_000 }),
      session('rev', { createdBySessionId: 'lead', teamRole: 'reviewer', title: 'Revisar a POC', createdAt: 3_000 }),
      session('imp', { createdBySessionId: 'lead', teamRole: 'implementer', teamMission: '', createdAt: 4_000 }),
      session('arc', { createdBySessionId: 'lead', teamRole: 'architect', teamMission: '   ', createdAt: 5_000 }),
    ]);
    const room = buildOfficeRoom(forest.teams[0], new Map(), null, 'x');
    const byId = new Map(room.members.map((m) => [m.sessionId, m]));
    expect(byId.get('exp')?.mission).toBe('Mapear as fontes de dados.');
    // No mission stored: nothing inferred from the title, no placeholder.
    expect(byId.get('lead')?.mission).toBeUndefined();
    expect(byId.get('rev')?.mission).toBeUndefined();
    expect(byId.get('imp')?.mission).toBeUndefined();
    // Whitespace only counts as no mission.
    expect(byId.get('arc')?.mission).toBeUndefined();
  });

  it('leaves principal state and markers unchanged by the mission', () => {
    const live = new Map([
      ['exp', signals({ processing: true })],
      ['rev', signals({ awaitingUser: true, pendingPromptTypes: ['permission_request'] })],
    ]);
    const withMission = buildTeamForest([
      session('lead', { teamMode: true }),
      session('exp', { createdBySessionId: 'lead', teamRole: 'explorer', teamMission: 'Mapear', createdAt: 2_000 }),
      session('rev', { createdBySessionId: 'lead', teamRole: 'reviewer', teamMission: 'Revisar', createdAt: 3_000 }),
    ]).teams[0];
    const withoutMission = buildTeamForest([
      session('lead', { teamMode: true }),
      session('exp', { createdBySessionId: 'lead', teamRole: 'explorer', createdAt: 2_000 }),
      session('rev', { createdBySessionId: 'lead', teamRole: 'reviewer', createdAt: 3_000 }),
    ]).teams[0];
    const project = (root: typeof withMission) =>
      buildOfficeRoom(root, live, null, 'x').members.map((m) => [m.sessionId, m.principal, m.waitingUser]);
    expect(project(withMission)).toEqual(project(withoutMission));
  });

  it('gives a delegation tree outside Team mode no coordinator role', () => {
    const forest = buildTeamForest([
      session('meta', { title: '' }),
      session('child', { createdBySessionId: 'meta', createdAt: 2_000 }),
    ]);
    const room = buildOfficeRoom(forest.teams[0], new Map(), null, 'Sem título');
    expect(room.isTeamModeRoot).toBe(false);
    expect(room.title).toBe('Sem título');
    expect(room.members.map((m) => m.role)).toEqual([null, null]);
  });
});
