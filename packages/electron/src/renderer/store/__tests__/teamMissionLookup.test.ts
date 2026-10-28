// @vitest-environment jsdom
/**
 * Finding and opening the mission that occupies a front (navigation only). The lookup asks the
 * host for a FRESH session list and reads the read-only exposure of mission roots (teamFront,
 * teamGoal, teamMissionStatus); it never touches the cached session atom, never parses a
 * message and never decides who owns the front (the main does, at creation).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  findActiveTeamMissionsActionAtom,
  openSessionInTabActionAtom,
  openTeamMissionActionAtom,
} from '../actions/sessionHistoryActions';
import { activeWorkspacePathAtom } from '../atoms/openProjects';

const session = (over: Record<string, unknown>) => ({
  id: 's', title: 'New Session', createdAt: 1, updatedAt: 1, isArchived: false, workspaceId: '/repo', ...over,
});

let invoke: ReturnType<typeof vi.fn>;
let listed: unknown[];
let workspace: string | null;

/** A `get` whose workspace can change between the call and the answer. */
const get = ((key: unknown) => (key === activeWorkspacePathAtom ? workspace : undefined)) as any;

beforeEach(() => {
  workspace = '/repo';
  listed = [];
  invoke = vi.fn(async (channel: string) => (channel === 'sessions:list' ? { success: true, sessions: listed } : undefined));
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { invoke } });
});
afterEach(() => {
  delete (window as any).electronAPI;
});

describe('findActiveTeamMissionsActionAtom', () => {
  it('asks the host for a fresh list of the open workspace (not the cached atom)', async () => {
    await findActiveTeamMissionsActionAtom.write(get, vi.fn(), 'tfr_a');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('sessions:list', '/repo', { includeArchived: false });
    await findActiveTeamMissionsActionAtom.write(get, vi.fn(), 'tfr_a');
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('returns the roots of that front that are not closed, with their goal, oldest first', async () => {
    listed = [
      session({ id: 'm2', createdAt: 20, teamFront: 'tfr_a', teamGoal: 'Second', teamMissionStatus: 'active' }),
      session({ id: 'm1', createdAt: 10, teamFront: 'tfr_a', teamGoal: 'First', teamMissionStatus: 'active' }),
      session({ id: 'other-front', teamFront: 'tfr_b', teamGoal: 'Elsewhere', teamMissionStatus: 'active' }),
      session({ id: 'closed', teamFront: 'tfr_a', teamGoal: 'Done', teamMissionStatus: 'closed' }),
      session({ id: 'archived', isArchived: true, teamFront: 'tfr_a', teamGoal: 'Gone', teamMissionStatus: 'active' }),
      session({ id: 'remote', remoteHostDeviceId: 'laptop', teamFront: 'tfr_a', teamGoal: 'Far away', teamMissionStatus: 'active' }),
      session({ id: 'plain' }),
    ];
    const outcome = await findActiveTeamMissionsActionAtom.write(get, vi.fn(), 'tfr_a');
    expect(outcome).toEqual({
      ok: true,
      missions: [{ id: 'm1', goal: 'First' }, { id: 'm2', goal: 'Second' }],
    });
  });

  it('a mission without a recorded goal is still listed, with a null goal', async () => {
    listed = [session({ id: 'm1', teamFront: 'tfr_a', teamMissionStatus: 'active' })];
    expect(await findActiveTeamMissionsActionAtom.write(get, vi.fn(), 'tfr_a')).toEqual({ ok: true, missions: [{ id: 'm1', goal: null }] });
  });

  it('none found is a successful lookup with an empty list', async () => {
    listed = [session({ id: 'plain' })];
    expect(await findActiveTeamMissionsActionAtom.write(get, vi.fn(), 'tfr_a')).toEqual({ ok: true, missions: [] });
  });

  it('a failed or rejected lookup is a failure, never an empty result', async () => {
    invoke.mockResolvedValueOnce({ success: false, error: 'db down', sessions: [] });
    expect(await findActiveTeamMissionsActionAtom.write(get, vi.fn(), 'tfr_a')).toEqual({ ok: false });
    invoke.mockRejectedValueOnce(new Error('ipc closed'));
    expect(await findActiveTeamMissionsActionAtom.write(get, vi.fn(), 'tfr_a')).toEqual({ ok: false });
  });

  it('does nothing without a workspace', async () => {
    workspace = null;
    expect(await findActiveTeamMissionsActionAtom.write(get, vi.fn(), 'tfr_a')).toEqual({ ok: false });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('an answer that arrives after the workspace changed is discarded as stale', async () => {
    listed = [session({ id: 'm1', teamFront: 'tfr_a', teamGoal: 'Old project', teamMissionStatus: 'active' })];
    invoke.mockImplementationOnce(async () => {
      workspace = '/other-project'; // the user switched projects while the host was answering
      return { success: true, sessions: listed };
    });
    expect(await findActiveTeamMissionsActionAtom.write(get, vi.fn(), 'tfr_a')).toEqual({ ok: false, stale: true });
  });

  it('writes nothing: no session is added, selected or opened by looking', async () => {
    listed = [session({ id: 'm1', teamFront: 'tfr_a', teamGoal: 'First', teamMissionStatus: 'active' })];
    const set = vi.fn();
    await findActiveTeamMissionsActionAtom.write(get, set, 'tfr_a');
    expect(set).not.toHaveBeenCalled();
  });
});

describe('openTeamMissionActionAtom', () => {
  it('opens a mission that still exists, through the ordinary open-session action', async () => {
    listed = [session({ id: 'm1', teamFront: 'tfr_a', teamGoal: 'First', teamMissionStatus: 'active' })];
    const set = vi.fn(async () => undefined);
    expect(await openTeamMissionActionAtom.write(get, set as any, 'm1')).toBe(true);
    expect(invoke).toHaveBeenCalledWith('sessions:list', '/repo', { includeArchived: false });
    expect(set).toHaveBeenCalledWith(openSessionInTabActionAtom, 'm1');
  });

  it('does not open a session that is gone, archived or remote: it reports it instead', async () => {
    listed = [
      session({ id: 'archived', isArchived: true, teamFront: 'tfr_a', teamMissionStatus: 'active' }),
      session({ id: 'remote', remoteHostDeviceId: 'laptop', teamFront: 'tfr_a', teamMissionStatus: 'active' }),
    ];
    for (const id of ['missing', 'archived', 'remote']) {
      const set = vi.fn();
      expect(await openTeamMissionActionAtom.write(get, set as any, id)).toBe(false);
      expect(set).not.toHaveBeenCalled();
    }
  });

  it('does not open anything if the list cannot be read, or if the workspace changed meanwhile', async () => {
    invoke.mockResolvedValueOnce({ success: false, sessions: [] });
    const set = vi.fn();
    expect(await openTeamMissionActionAtom.write(get, set as any, 'm1')).toBe(false);

    listed = [session({ id: 'm1', teamFront: 'tfr_a', teamMissionStatus: 'active' })];
    invoke.mockImplementationOnce(async () => {
      workspace = '/other-project';
      return { success: true, sessions: listed };
    });
    expect(await openTeamMissionActionAtom.write(get, set as any, 'm1')).toBe(false);
    expect(set).not.toHaveBeenCalled();
  });
});
