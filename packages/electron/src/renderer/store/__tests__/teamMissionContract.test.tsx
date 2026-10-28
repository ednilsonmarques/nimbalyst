// @vitest-environment jsdom
/**
 * The renderer -> main contract of a mission, end to end without Electron: the exact
 * `sessions:create` payload that createTeamMissionActionAtom builds is run through the
 * very code the main runs on it (the metadata sanitizers of the handler, the real
 * parseTeamMissionRequest and the real createTeamMissionRoot) over in-memory ports.
 * The handler's own wiring is covered by main/ipc/__tests__/SessionHandlers.teamMission.test.ts;
 * this guards the two halves against drifting apart (a renamed key, a changed limit, an
 * extra field on one side would make the main refuse what the renderer sends).
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTeamMissionActionAtom } from '../actions/sessionHistoryActions';
import { activeWorkspacePathAtom } from '../atoms/openProjects';
import { activeFileRepoPathAtom } from '../atoms/workspaceRepos';
import { defaultAgentModelAtom } from '../atoms/appSettings';
import { selectedMachineAtom } from '../atoms/remoteMachines';
import { NewTeamMissionDialog } from '../../components/AgenticCoding/NewTeamMissionDialog';
import { buildTeamMissionCreateInput } from '../../components/AgenticCoding/teamMissionDialog';
import { createTeamMissionRoot, TeamMissionError, type TeamMissionPorts } from '../../../main/services/team/teamMissions';
import { sanitizeRendererCreateTeamMetadata } from '../../../main/services/team/teamSessionMetadata';
import { stripOwnerControlledMetadata } from '../../../main/services/extensionSessions/sessionOwnership';
import { normalizeSessionPhaseMetadataUpdate } from '../../../main/services/session/sessionPhaseTransition';
import { resolveSessionModelSelection } from '../../../main/services/ai/sessionModelSelection';

const WORKSPACE = '/repo';
const FRONT_ITEM = { id: 'tfr_x', type: 'team-front', title: 'Portal', status: 'active', archived: false };

let stored: Map<string, Record<string, unknown>>;
let created: Array<Record<string, any>>;

function fakePorts(): TeamMissionPorts {
  return {
    async sessionExists(id) { return stored.has(id); },
    async getSessionMetadata(id) { return stored.get(id) ?? null; },
    async getFront(id, workspaceId) {
      if (id !== FRONT_ITEM.id || workspaceId !== WORKSPACE) return null;
      return { id, title: FRONT_ITEM.title, type: 'team-front', status: 'active', archived: false, description: 'State of the front' };
    },
    async findActiveMissionRoot() { return null; },
    async createSession(payload) {
      created.push(payload as Record<string, any>);
      stored.set(payload.id, (payload.metadata ?? {}) as Record<string, unknown>);
    },
  };
}

/** What the `sessions:create` handler does with the payload (SessionHandlers.ts, the `teamMission !== undefined` branch). */
async function mainSessionsCreate(payload: any) {
  const { session, workspaceId, teamMission } = payload;
  const { provider, model } = resolveSessionModelSelection(session.provider, session.model);
  const createPayload = {
    id: session.id,
    provider,
    model,
    title: session.title || 'Untitled',
    mode: session.mode || 'agent',
    workspaceId,
    worktreeId: null,
    agentRole: session.agentRole || 'standard',
    createdBySessionId: session.createdBySessionId || null,
    ...(session.metadata && typeof session.metadata === 'object'
      ? { metadata: normalizeSessionPhaseMetadataUpdate(sanitizeRendererCreateTeamMetadata(stripOwnerControlledMetadata(session.metadata), model)) }
      : {}),
  };
  try {
    await createTeamMissionRoot({ payload: createPayload as any, request: teamMission }, fakePorts(), { policyFiles: () => [] });
    return { success: true, id: session.id };
  } catch (error) {
    if (error instanceof TeamMissionError) return { success: false, error: error.message, errorCode: error.code };
    return { success: false, error: String(error) };
  }
}

function makeGet() {
  return ((key: unknown) => {
    if (key === activeWorkspacePathAtom || key === activeFileRepoPathAtom) return WORKSPACE;
    if (key === defaultAgentModelAtom) return 'claude-code:opus';
    if (key === selectedMachineAtom(WORKSPACE)) return undefined;
    return undefined;
  }) as any;
}

let invoke: ReturnType<typeof vi.fn>;
beforeEach(() => {
  stored = new Map();
  created = [];
  invoke = vi.fn(async (channel: string, payload: any) => {
    if (channel === 'sessions:create') return mainSessionsCreate(payload);
    if (channel === 'document-service:tracker-items-by-type') return [FRONT_ITEM];
    return undefined;
  });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { invoke } });
});
afterEach(() => cleanup());

describe('the payload createTeamMissionActionAtom builds is accepted by the real main code', () => {
  it('starts a mission from the exact payload, writing the keys the host owns', async () => {
    const outcome = await createTeamMissionActionAtom.write(makeGet(), vi.fn(), {
      teamMission: { front: 'tfr_x', goal: '  g  ', doneCriterion: 'd' },
      model: 'claude-code:opus',
      effortLevel: 'high',
      launchSource: 'session_history',
    });

    expect(outcome.ok).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0].metadata).toMatchObject({
      teamMode: true,
      effortLevel: 'high',
      teamFront: 'tfr_x',
      teamGoal: 'g',
      teamDoneCriterion: 'd',
      teamMissionStatus: 'active',
      teamMissionVersion: 1,
    });
    expect(created[0].model).toBe('claude-code:opus');
    expect(created[0].provider).toBe('claude-code');
    expect(typeof created[0].metadata.teamMissionContext).toBe('string');
  });

  it('is accepted with the input the dialog host builds from the Standard preset', async () => {
    const input = buildTeamMissionCreateInput({ front: 'tfr_x', goal: 'Ship it' })!;
    const outcome = await createTeamMissionActionAtom.write(makeGet(), vi.fn(), input);
    expect(outcome.ok).toBe(true);
    expect(created[0].metadata).toMatchObject({ teamMode: true, teamFront: 'tfr_x', teamGoal: 'Ship it' });
    expect(created[0].metadata).not.toHaveProperty('teamDoneCriterion');
  });

  it('a front of another workspace or an unknown id is refused with its own code, not as a success', async () => {
    const outcome = await createTeamMissionActionAtom.write(makeGet(), vi.fn(), {
      teamMission: { front: 'tfr_unknown', goal: 'g' },
      model: 'claude-code:opus',
      effortLevel: 'high',
    });
    expect(outcome).toMatchObject({ ok: false, errorCode: 'front-not-found' });
    expect(created).toHaveLength(0);
  });
});

describe('control characters in the goal', () => {
  it('pasting \\u0001 is refused by the main as invalid-request; the dialog shows the main detail and stays usable', async () => {
    const dispatch = (request: any) => createTeamMissionActionAtom.write(makeGet(), vi.fn(), buildTeamMissionCreateInput(request)!);
    const onClose = vi.fn();
    render(<NewTeamMissionDialog isOpen onSubmit={dispatch} onClose={onClose} />);
    fireEvent.click(await screen.findByTestId('team-mission-front-tfr_x'));
    fireEvent.change(screen.getByTestId('team-mission-goal'), { target: { value: 'bad \u0001 goal' } });
    await act(async () => { fireEvent.click(screen.getByTestId('team-mission-create')); });

    // By test id, not by role: role queries run getComputedStyle, and in this file jsdom meets an app
    // stylesheet selector it cannot parse (a SyntaxError unrelated to the dialog).
    const alert = await screen.findByTestId('team-mission-submit-error');
    expect(alert.getAttribute('data-error-code')).toBe('invalid-request');
    expect(screen.getByTestId('team-mission-error-message').textContent).toContain('rejected the mission data');
    expect(screen.getByTestId('team-mission-error-details').textContent).toContain('control characters');
    expect(created).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();

    // The form is usable: fix the text and the same dialog starts the mission.
    const create = screen.getByTestId('team-mission-create') as HTMLButtonElement;
    expect(create.disabled).toBe(false);
    expect((screen.getByTestId('team-mission-goal') as HTMLTextAreaElement).value).toBe('bad \u0001 goal');
    fireEvent.change(screen.getByTestId('team-mission-goal'), { target: { value: 'a clean goal' } });
    await act(async () => { fireEvent.click(create); });
    expect(created).toHaveLength(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
