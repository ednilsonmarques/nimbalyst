// @vitest-environment jsdom
/**
 * The "new mission" entry at the real SessionHistory: the title bar menu item opens the
 * dialog (in the empty state and with sessions), is absent without the flag, and the
 * dialog's submit creates the Team root on the Standard coordinator preset.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Provider } from 'jotai';
import { store } from '@nimbalyst/runtime/store';
import { TEAM_ROOT_PRESETS } from '@nimbalyst/runtime/ai/server/providers/teamContext';
import { SessionHistory } from '../SessionHistory';
import { advancedSettingsAtom } from '../../../store/atoms/appSettings';
import { activeWorkspacePathAtom } from '../../../store/atoms/openProjects';
import { titleBarCreateMenusAtom } from '../../../store/atoms/titleBarCreate';
import { addSessionFullAtom } from '../../../store/atoms/sessions';
import { initWorkstreamState } from '../../../store/atoms/workstreamState';

const FRONT = { id: 'tfr_front1', type: 'team-front', title: 'Portal', status: 'active', archived: false };
const STANDARD = TEAM_ROOT_PRESETS.find((preset) => preset.id === 'standard')!;

let invoke: ReturnType<typeof vi.fn>;

function setTeamViewFlag(enabled: boolean) {
  const base = store.get(advancedSettingsAtom);
  store.set(advancedSettingsAtom, { ...base, alphaFeatures: { ...base.alphaFeatures, 'agent-team-view': enabled } });
}

const menuItems = () => store.get(titleBarCreateMenusAtom).agent?.items ?? [];
const missionItem = () => menuItems().find((item) => item.id === 'team-mission');

async function renderHistory() {
  render(<Provider store={store}><SessionHistory /></Provider>);
  await waitFor(() => expect(store.get(titleBarCreateMenusAtom).agent).toBeDefined());
}

beforeEach(() => {
  invoke = vi.fn(async (channel: string, payload?: any) => {
    if (channel === 'document-service:tracker-items-by-type') return [FRONT];
    if (channel === 'ai:remoteHosts') return [];
    if (channel === 'sessions:create') return { success: true, id: payload.session.id };
    return undefined;
  });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { invoke, on: () => () => {}, send: () => {} } });
  store.set(activeWorkspacePathAtom, '/repo');
  initWorkstreamState('/repo');
  setTeamViewFlag(true);
});

afterEach(() => {
  cleanup();
  setTeamViewFlag(false);
});

describe('SessionHistory and the new-mission entry', () => {
  it('is in the New menu behind the Team view flag, and absent without it', async () => {
    await renderHistory();
    expect(missionItem()?.testId).toBe('new-team-mission-button');
    cleanup();
    setTeamViewFlag(false);
    await renderHistory();
    expect(missionItem()).toBeUndefined();
  });

  it('opens the dialog from the empty state, and creates nothing by itself', async () => {
    await renderHistory();
    expect(screen.queryByTestId('team-mission-dialog')).toBeNull();
    act(() => missionItem()!.onSelect());
    expect(await screen.findByTestId('team-mission-dialog')).toBeTruthy();
    expect(invoke.mock.calls.some(([channel]) => channel === 'sessions:create')).toBe(false);
  });

  it('opens the dialog when there are sessions too (the other return path)', async () => {
    act(() => {
      store.set(addSessionFullAtom, {
        id: 'existing-session', title: 'Existing', createdAt: 1, updatedAt: 2, provider: 'claude-code', model: 'claude-code:opus',
        sessionType: 'session', messageCount: 1, workspaceId: '/repo', isArchived: false, isPinned: false,
        parentSessionId: null, worktreeId: null, childCount: 0, uncommittedCount: 0,
      } as never);
    });
    await renderHistory();
    act(() => missionItem()!.onSelect());
    expect(await screen.findByTestId('team-mission-dialog')).toBeTruthy();
  });

  it('submitting creates the Team root on the Standard preset (its model and effort) with the teamMission field', async () => {
    await renderHistory();
    act(() => missionItem()!.onSelect());
    fireEvent.click(await screen.findByTestId('team-mission-front-tfr_front1'));
    fireEvent.change(screen.getByTestId('team-mission-goal'), { target: { value: 'Ship the dialog' } });
    await act(async () => { fireEvent.click(screen.getByTestId('team-mission-create')); });

    const call = invoke.mock.calls.find(([channel]) => channel === 'sessions:create');
    expect(call).toBeTruthy();
    const payload = call![1];
    expect(payload.session.model).toBe(STANDARD.model);
    expect(payload.session.metadata).toEqual({ teamMode: true, effortLevel: STANDARD.effortLevel });
    expect(payload.teamMission).toEqual({ front: 'tfr_front1', goal: 'Ship the dialog' });
    expect(payload.launchSource).toBe('session_history');
    // Success closes the dialog.
    await waitFor(() => expect(screen.queryByTestId('team-mission-dialog')).toBeNull());
  });
});
