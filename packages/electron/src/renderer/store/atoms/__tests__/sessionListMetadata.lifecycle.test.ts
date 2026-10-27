// @vitest-environment node
/**
 * F1 S3, fifth exposure point: the targeted `sessions:session-updated` listener
 * merges the three exposed lifecycle keys (front, goal, status) into the registry
 * entry (read-only: main -> renderer), only when they are well formed. The context
 * and the done criterion are main-only and never merged.
 */
import { expect, it, vi } from 'vitest';

vi.mock('../../index', async () => {
  const { createStore } = await import('jotai'); return { store: createStore() };
});
vi.mock('../sessions', async () => {
  const { atom } = await import('jotai');
  return { sessionRegistryAtom: atom(new Map()), sessionListWorkspaceAtom: atom('/parent'), refreshSessionListAtom: atom(null, () => {}), sessionChildrenAtom: () => atom([]), sessionParentIdAtom: () => atom(null) };
});
vi.mock('../workstreamState', async () => {
  const { atom } = await import('jotai'); return { workstreamStateAtom: () => atom({}) };
});

import { store } from '../../index';
import { sessionRegistryAtom } from '../sessions';
import { sessionListMetadata } from '../sessionListMetadata';
import { initSessionListListeners } from '../../listeners/sessionListListeners';

function withListener(run: (send: (sessionId: string, updates: Record<string, unknown>) => void) => void) {
  const handlers = new Map<string, (...args: any[]) => void>();
  vi.stubGlobal('window', { electronAPI: { on: (channel: string, handler: any) => { handlers.set(channel, handler); return () => {}; } } });
  const dispose = initSessionListListeners();
  try {
    run((sessionId, updates) => handlers.get('sessions:session-updated')!(sessionId, updates));
  } finally { dispose(); vi.unstubAllGlobals(); }
}

it('merges the three exposed lifecycle keys into the registry entry of the session, leaving siblings alone', () => {
  const own = sessionListMetadata({ id: 'own', createdAt: 1, updatedAt: 2, teamMode: true }, '/parent');
  const sibling = sessionListMetadata({ id: 'sibling', createdAt: 1, updatedAt: 2 }, '/parent');
  store.set(sessionRegistryAtom, new Map([['own', own], ['sibling', sibling]]));
  withListener((send) => {
    send('own', { teamFront: 'team-front_1', teamGoal: 'Ship F1', teamMissionStatus: 'active' });
    expect(store.get(sessionRegistryAtom).get('own')).toMatchObject({
      teamMode: true, teamFront: 'team-front_1', teamGoal: 'Ship F1', teamMissionStatus: 'active',
    });
    expect(store.get(sessionRegistryAtom).get('sibling')).toBe(sibling);
  });
});

it('never merges the context or the done criterion: they are main-only', () => {
  const own = sessionListMetadata({ id: 'own', createdAt: 1, updatedAt: 2, teamMode: true }, '/parent');
  store.set(sessionRegistryAtom, new Map([['own', own]]));
  withListener((send) => {
    send('own', { teamMissionContext: 'Bootstrap block', teamDoneCriterion: 'S3 green', teamGoal: 'Ship F1' });
    const entry = store.get(sessionRegistryAtom).get('own') as unknown as Record<string, unknown>;
    expect(entry.teamGoal).toBe('Ship F1');
    expect(entry.teamMissionContext).toBeUndefined();
    expect(entry.teamDoneCriterion).toBeUndefined();
  });
});

it('ignores a value that is not a non-blank string, and a status outside active/closed', () => {
  const own = sessionListMetadata({ id: 'own', createdAt: 1, updatedAt: 2, teamMode: true }, '/parent');
  store.set(sessionRegistryAtom, new Map([['own', own]]));
  withListener((send) => {
    send('own', { teamFront: '', teamGoal: 7, teamMissionStatus: 'paused' });
    const entry = store.get(sessionRegistryAtom).get('own')!;
    for (const field of ['teamFront', 'teamGoal', 'teamMissionStatus'] as const) {
      expect(entry[field], field).toBeUndefined();
    }
  });
});
