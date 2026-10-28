// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNewSessionActionAtom, createTeamMissionActionAtom } from '../actions/sessionHistoryActions';
import { activeWorkspacePathAtom } from '../atoms/openProjects';
import { activeFileRepoPathAtom } from '../atoms/workspaceRepos';
import { defaultAgentModelAtom } from '../atoms/appSettings';
import { selectedMachineAtom } from '../atoms/remoteMachines';
import { addSessionFullAtom, setSelectedWorkstreamAtom, setSessionDraftInputAtom } from '../index';

const MISSION_KEYS = ['teamFront', 'teamGoal', 'teamDoneCriterion', 'teamMissionStatus', 'teamMissionContext', 'teamMissionVersion', 'currentMission'];

function makeGet(opts: { workspace?: string | null; remoteHost?: string } = {}) {
  const workspace = opts.workspace === undefined ? '/repo' : opts.workspace;
  return ((key: unknown) => {
    if (key === activeWorkspacePathAtom || key === activeFileRepoPathAtom) return workspace;
    if (key === defaultAgentModelAtom) return 'claude-code:opus';
    if (workspace && key === selectedMachineAtom(workspace)) return opts.remoteHost;
    return undefined;
  }) as any;
}

const input = {
  teamMission: { front: 'tfr_front1', goal: 'Ship it', doneCriterion: 'Green' },
  model: 'claude-code:opus',
  effortLevel: 'high',
  launchSource: 'session_history' as const,
};

let invoke: ReturnType<typeof vi.fn>;

beforeEach(() => {
  invoke = vi.fn(async (_channel: string, payload: any) => ({ success: true, id: payload.session.id }));
  (window as any).electronAPI = { invoke };
});
afterEach(() => {
  delete (window as any).electronAPI;
});

describe('createTeamMissionActionAtom', () => {
  it('sends sessions:create with the explicit teamMission and the ordinary team-root fields, and no mission key in metadata', async () => {
    const set = vi.fn();
    const outcome = await createTeamMissionActionAtom.write(makeGet(), set, input);

    expect(invoke).toHaveBeenCalledTimes(1);
    const [channel, payload] = invoke.mock.calls[0];
    expect(channel).toBe('sessions:create');
    expect(payload.teamMission).toEqual({ front: 'tfr_front1', goal: 'Ship it', doneCriterion: 'Green' });
    expect(payload.session.metadata).toEqual({ teamMode: true, effortLevel: 'high' });
    for (const key of MISSION_KEYS) expect(payload.session.metadata).not.toHaveProperty(key);
    expect(payload.session).toMatchObject({ provider: 'claude-code', model: 'claude-code:opus', title: 'New Session' });
    expect(payload.workspaceId).toBe('/repo');
    expect(payload.launchSource).toBe('session_history');
    expect(payload.hadPrefilledPrompt).toBe(false);
    expect(Object.keys(payload).sort()).toEqual(['hadPrefilledPrompt', 'launchSource', 'session', 'teamMission', 'workspaceId']);
    expect(outcome).toEqual({ ok: true, sessionId: payload.session.id });
  });

  it('on success adds the new Team root to the session list and selects it', async () => {
    const set = vi.fn();
    const outcome = await createTeamMissionActionAtom.write(makeGet(), set, input);
    const added = set.mock.calls.find(([atomRef]) => atomRef === addSessionFullAtom);
    expect(added?.[1]).toMatchObject({ id: (outcome as any).sessionId, teamMode: true, effortLevel: 'high', workspaceId: '/repo' });
    const selected = set.mock.calls.find(([atomRef]) => atomRef === setSelectedWorkstreamAtom);
    expect(selected?.[1]).toEqual({ workspacePath: '/repo', selection: { type: 'session', id: (outcome as any).sessionId } });
  });

  it('a refusal keeps its code and the main message, and creates nothing in the list', async () => {
    invoke.mockResolvedValueOnce({ success: false, error: 'Front "A" already has an active mission', errorCode: 'mission-active' });
    const set = vi.fn();
    const outcome = await createTeamMissionActionAtom.write(makeGet(), set, input);
    expect(outcome).toEqual({ ok: false, errorCode: 'mission-active', message: 'Front "A" already has an active mission' });
    expect(set).not.toHaveBeenCalled();
  });

  it('a failure without a code (unexpected error in the main) is a failure, never a success', async () => {
    invoke.mockResolvedValueOnce({ success: false, error: 'Error: db is down' });
    const outcome = await createTeamMissionActionAtom.write(makeGet(), vi.fn(), input);
    expect(outcome).toEqual({ ok: false, errorCode: undefined, message: 'Error: db is down' });
  });

  it('a success reply without an id is not a success', async () => {
    invoke.mockResolvedValueOnce({ success: true });
    const set = vi.fn();
    const outcome = await createTeamMissionActionAtom.write(makeGet(), set, input);
    expect(outcome.ok).toBe(false);
    expect(set).not.toHaveBeenCalled();
  });

  it('a rejected invoke becomes a failure with the error text', async () => {
    invoke.mockRejectedValueOnce(new Error('ipc closed'));
    const outcome = await createTeamMissionActionAtom.write(makeGet(), vi.fn(), input);
    expect(outcome).toEqual({ ok: false, message: 'Error: ipc closed' });
  });

  it('uses a new session id for every attempt', async () => {
    await createTeamMissionActionAtom.write(makeGet(), vi.fn(), input);
    await createTeamMissionActionAtom.write(makeGet(), vi.fn(), input);
    expect(invoke.mock.calls[0][1].session.id).not.toBe(invoke.mock.calls[1][1].session.id);
  });

  it('does not start a mission on a remote machine, and does not call the main', async () => {
    const outcome = await createTeamMissionActionAtom.write(makeGet({ remoteHost: 'sandbox-one' }), vi.fn(), input);
    expect(outcome).toEqual({ ok: false, errorCode: 'remote-host' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does nothing without a workspace', async () => {
    const outcome = await createTeamMissionActionAtom.write(makeGet({ workspace: null }), vi.fn(), input);
    expect(outcome).toEqual({ ok: false, errorCode: 'no-workspace' });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('the ordinary Team creation is unchanged', () => {
  it('createNewSessionActionAtom still sends no teamMission, so the root stays a legacy root', async () => {
    const set = vi.fn();
    const id = await createNewSessionActionAtom.write(makeGet(), set, {
      launchSource: 'session_history',
      model: 'claude-code:opus',
      metadata: { teamMode: true, effortLevel: 'high' },
    });
    const [channel, payload] = invoke.mock.calls[0];
    expect(channel).toBe('sessions:create');
    expect(payload).not.toHaveProperty('teamMission');
    expect(payload.session.metadata).toEqual({ teamMode: true, effortLevel: 'high' });
    expect(id).toBe(payload.session.id);
    const added = set.mock.calls.find(([atomRef]) => atomRef === addSessionFullAtom);
    expect(added?.[1]).toMatchObject({ teamMode: true, effortLevel: 'high', title: 'New Session' });
  });

  it('a failed ordinary creation is still swallowed as undefined (callers rely on it)', async () => {
    invoke.mockResolvedValueOnce({ success: false, error: 'x' });
    const set = vi.fn();
    const id = await createNewSessionActionAtom.write(makeGet(), set, { metadata: { teamMode: true } });
    expect(id).toBeUndefined();
    expect(set).not.toHaveBeenCalled();
  });
});

describe('the extracted post-create helper keeps the ECC Architect branch as it was', () => {
  const DRAFT = 'Prepare this task with ECC Architect before implementation:\n\n';

  it('a Team root with a draft and selectSession:false registers the session and the draft, and does not select it', async () => {
    const set = vi.fn();
    const id = await createNewSessionActionAtom.write(makeGet(), set, {
      launchSource: 'session_history',
      model: 'claude-code:opus',
      title: 'ECC Architect',
      initialDraft: DRAFT,
      selectSession: false,
      metadata: { teamMode: true, effortLevel: 'high', sessionDirective: 'begin with the architect' },
    });

    const [, payload] = invoke.mock.calls[0];
    expect(payload).not.toHaveProperty('teamMission');
    expect(payload.hadPrefilledPrompt).toBe(true);
    expect(payload.session.metadata).toEqual({ teamMode: true, effortLevel: 'high', sessionDirective: 'begin with the architect' });

    const added = set.mock.calls.find(([atomRef]) => atomRef === addSessionFullAtom);
    expect(added?.[1]).toMatchObject({ id, title: 'ECC Architect', teamMode: true, effortLevel: 'high', workspaceId: '/repo', messageCount: 0, isArchived: false });
    // The directive stays in the stored metadata only; it is not a list field.
    expect(added?.[1]).not.toHaveProperty('sessionDirective');

    const draft = set.mock.calls.find(([atomRef]) => atomRef === setSessionDraftInputAtom);
    expect(draft?.[1]).toEqual({ sessionId: id, draftInput: DRAFT, workspacePath: '/repo', persist: true });
    expect(set.mock.calls.some(([atomRef]) => atomRef === setSelectedWorkstreamAtom)).toBe(false);
    expect(id).toBe(payload.session.id);
  });

  it('with the default selectSession it also selects the new session', async () => {
    const set = vi.fn();
    const id = await createNewSessionActionAtom.write(makeGet(), set, { metadata: { teamMode: true }, initialDraft: 'x' });
    const selected = set.mock.calls.find(([atomRef]) => atomRef === setSelectedWorkstreamAtom);
    expect(selected?.[1]).toEqual({ workspacePath: '/repo', selection: { type: 'session', id } });
  });
});
