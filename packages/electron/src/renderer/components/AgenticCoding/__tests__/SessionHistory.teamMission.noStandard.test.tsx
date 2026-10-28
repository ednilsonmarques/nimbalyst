// @vitest-environment jsdom
/**
 * A mission is created on the Standard coordinator preset. If that preset is ever missing from
 * the list, SessionHistory must not quietly use another one (a different, possibly costlier,
 * model): it fails closed with a clear message and creates nothing.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Provider } from 'jotai';
import { store } from '@nimbalyst/runtime/store';

vi.mock('@nimbalyst/runtime/ai/server/providers/teamContext', async (importOriginal) => {
  const original = await importOriginal<typeof import('@nimbalyst/runtime/ai/server/providers/teamContext')>();
  return {
    ...original,
    TEAM_ROOT_PRESETS: original.TEAM_ROOT_PRESETS.filter((preset) => preset.id !== 'standard'),
  };
});

import { SessionHistory } from '../SessionHistory';
import { advancedSettingsAtom } from '../../../store/atoms/appSettings';
import { activeWorkspacePathAtom } from '../../../store/atoms/openProjects';
import { titleBarCreateMenusAtom } from '../../../store/atoms/titleBarCreate';
import { initWorkstreamState } from '../../../store/atoms/workstreamState';

const FRONT = { id: 'tfr_front1', type: 'team-front', title: 'Portal', status: 'active', archived: false };

let invoke: ReturnType<typeof vi.fn>;

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
  const base = store.get(advancedSettingsAtom);
  store.set(advancedSettingsAtom, { ...base, alphaFeatures: { ...base.alphaFeatures, 'agent-team-view': true } });
});

afterEach(() => {
  cleanup();
  const base = store.get(advancedSettingsAtom);
  store.set(advancedSettingsAtom, { ...base, alphaFeatures: { ...base.alphaFeatures, 'agent-team-view': false } });
});

describe('SessionHistory without a Standard coordinator preset', () => {
  it('shows a clear error and creates no session, rather than falling back to another preset', async () => {
    render(<Provider store={store}><SessionHistory /></Provider>);
    await waitFor(() => expect(store.get(titleBarCreateMenusAtom).agent).toBeDefined());
    const item = store.get(titleBarCreateMenusAtom).agent!.items.find((i) => i.id === 'team-mission')!;
    act(() => item.onSelect());
    fireEvent.click(await screen.findByTestId('team-mission-front-tfr_front1'));
    fireEvent.change(screen.getByTestId('team-mission-goal'), { target: { value: 'Ship the dialog' } });
    await act(async () => { fireEvent.click(screen.getByTestId('team-mission-create')); });

    // By test id: role queries run getComputedStyle, and jsdom cannot parse a selector of the app CSS loaded with SessionHistory.
    const alert = await screen.findByTestId('team-mission-submit-error');
    expect(alert.getAttribute('data-error-code')).toBe('preset-unavailable');
    expect(screen.getByTestId('team-mission-error-message').textContent).toBe('The Standard coordinator preset is not available, so no mission was started.');
    expect(invoke.mock.calls.some(([channel]) => channel === 'sessions:create')).toBe(false);
    // The dialog stays open with the text, so nothing the user typed is lost.
    expect((screen.getByTestId('team-mission-goal') as HTMLTextAreaElement).value).toBe('Ship the dialog');
  });
});
