// @vitest-environment jsdom
/**
 * After a refusal that says the front is taken (mission-active), or a failure with no code (the
 * outcome is unknown), the dialog looks for the mission that occupies the front and offers to OPEN
 * it. It is navigation only: the refusal stays a refusal, nothing here says this attempt created
 * the mission, and the front is not freed.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { setLanguage } from '@nimbalyst/runtime/i18n';
import { NewTeamMissionDialog } from '../NewTeamMissionDialog';
import type { FindActiveMissionsOutcome, TeamMissionCreateOutcome } from '../../../store/actions/sessionHistoryActions';
import { trackerItemsChangedAtom } from '../../../store/atoms/trackerItemsChanged';
import type { TeamMissionRequestPayload } from '../../../../shared/teamMission';

const FRONT = { id: 'tfr_active', type: 'team-front', title: 'Portal', status: 'active', archived: false };
const FRONT_2 = { id: 'tfr_active2', type: 'team-front', title: 'Team Mode', status: 'active', archived: false };
const ACTIVE_ID = 'a9aa1758-1111-2222-3333-444455556666';

let invoke: ReturnType<typeof vi.fn>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const found = (...missions: Array<{ id: string; goal: string | null }>): FindActiveMissionsOutcome => ({ ok: true, missions });

function setup(options: {
  outcome?: TeamMissionCreateOutcome;
  find?: (front: string) => Promise<FindActiveMissionsOutcome>;
  open?: (id: string) => Promise<boolean>;
  withLookup?: boolean;
} = {}) {
  const onClose = vi.fn();
  const submit = vi.fn(async (_request: TeamMissionRequestPayload): Promise<TeamMissionCreateOutcome> =>
    options.outcome ?? { ok: false, errorCode: 'mission-active', message: `Front "Portal" already has an active mission (session ${ACTIVE_ID}, "New Session")` });
  const find = vi.fn(options.find ?? (async () => found({ id: ACTIVE_ID, goal: 'Ship the F1 identity layer' })));
  const open = vi.fn(options.open ?? (async () => true));
  const view = render(
    <NewTeamMissionDialog
      isOpen
      onSubmit={submit}
      onClose={onClose}
      {...(options.withLookup === false ? {} : { findActiveMissions: find, onOpenMission: open })}
    />,
  );
  return { onClose, submit, find, open, ...view };
}

const pick = (id: string) => fireEvent.click(screen.getByTestId(`team-mission-front-${id}`));
const type = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });
const createButton = () => screen.getByTestId('team-mission-create') as HTMLButtonElement;
const ready = () => screen.findByTestId('team-mission-front-tfr_active');

async function submitRefusal() {
  await ready();
  pick('tfr_active');
  type('team-mission-goal', 'My goal');
  fireEvent.click(createButton());
  await screen.findByTestId('team-mission-submit-error');
}

beforeEach(() => {
  invoke = vi.fn(async (channel: string) => (channel === 'document-service:tracker-items-by-type' ? [FRONT, FRONT_2] : undefined));
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { invoke } });
});
afterEach(async () => {
  cleanup();
  store.set(trackerItemsChangedAtom, null);
  await setLanguage('en');
});

describe('mission-active', () => {
  it('looks up the active mission of the SELECTED front and shows it by its goal and a short id, with Open', async () => {
    const { find } = setup();
    await submitRefusal();
    const card = await screen.findByTestId(`team-mission-active-${ACTIVE_ID}`);
    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith('tfr_active');
    expect(screen.getByTestId('team-mission-active-heading').textContent).toBe('Active mission on this front');
    expect(card.textContent).toContain('Ship the F1 identity layer');
    expect(card.textContent).toContain('a9aa1758');
    expect(card.textContent).not.toContain(ACTIVE_ID); // the short id, not the whole UUID
    expect(screen.getByTestId(`team-mission-open-${ACTIVE_ID}`).textContent).toBe('Open mission');
  });

  it('the refusal stays a refusal: still an alert with its code, the dialog open, the form usable, nothing said to be created', async () => {
    const { onClose } = setup();
    await submitRefusal();
    await screen.findByTestId(`team-mission-active-${ACTIVE_ID}`);
    const alert = screen.getByTestId('team-mission-submit-error');
    expect(alert.getAttribute('data-error-code')).toBe('mission-active');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(screen.getByTestId('team-mission-error-message').textContent).toBe('This front already has an active mission. Archive that mission or choose another front.');
    expect(onClose).not.toHaveBeenCalled();
    expect(createButton().disabled).toBe(false);
    expect(createButton().textContent).toBe('Start mission');
    expect(alert.textContent).not.toMatch(/created|started|success/i);
    // The found mission is inside the fixed error row, so it is as visible as the refusal.
    expect(screen.getByTestId('team-mission-body').contains(screen.getByTestId(`team-mission-active-${ACTIVE_ID}`))).toBe(false);
  });

  it('Open opens that mission, then closes the dialog (navigation, not a creation)', async () => {
    const { open, onClose, submit } = setup();
    await submitRefusal();
    fireEvent.click(await screen.findByTestId(`team-mission-open-${ACTIVE_ID}`));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(ACTIVE_ID);
    expect(submit).toHaveBeenCalledTimes(1); // nothing was sent again
  });

  it('when the mission can no longer be opened: says so, keeps the dialog, and looks again', async () => {
    const outcomes = [found({ id: ACTIVE_ID, goal: 'Ship it' }), found()];
    const { open, onClose, find } = setup({ open: async () => false, find: async () => outcomes.shift()! });
    await submitRefusal();
    fireEvent.click(await screen.findByTestId(`team-mission-open-${ACTIVE_ID}`));
    await screen.findByTestId('team-mission-active-open-failed');
    expect(screen.getByTestId('team-mission-active-open-failed').textContent).toBe(
      'That mission could not be opened (it may have been archived or deleted). The list was refreshed.',
    );
    expect(open).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId(`team-mission-active-${ACTIVE_ID}`)).toBeNull());
    expect(screen.getByTestId('team-mission-submit-error').getAttribute('data-error-code')).toBe('mission-active');
  });

  it('opening twice in a row is one open (guarded)', async () => {
    const gate = deferred<boolean>();
    const { open } = setup({ open: () => gate.promise });
    await submitRefusal();
    const button = await screen.findByTestId(`team-mission-open-${ACTIVE_ID}`);
    act(() => { button.click(); button.click(); });
    expect(open).toHaveBeenCalledTimes(1);
    await act(async () => gate.resolve(true));
  });
});

describe('a failure with no code', () => {
  it('runs the same lookup, because the mission may exist although the answer was lost', async () => {
    const { find } = setup({ outcome: { ok: false, message: 'Error: read-back failed' } });
    await submitRefusal();
    await screen.findByTestId(`team-mission-active-${ACTIVE_ID}`);
    expect(find).toHaveBeenCalledWith('tfr_active');
    const alert = screen.getByTestId('team-mission-submit-error');
    expect(alert.getAttribute('data-error-code')).toBe('');
    expect(screen.getByTestId('team-mission-error-message').textContent).toBe('The mission could not be started.');
    expect(screen.getByTestId('team-mission-error-details').textContent).toBe('Details: Error: read-back failed');
  });

  it.each(['invalid-request', 'front-unavailable', 'front-not-found', 'session-exists', 'not-a-team-root', 'no-workspace', 'remote-host', 'preset-unavailable'] as const)(
    'no lookup for %s: those refusals say nothing about a mission on the front',
    async (errorCode) => {
      const { find } = setup({ outcome: { ok: false, errorCode, message: 'no' } });
      await submitRefusal();
      await waitFor(() => expect(createButton().disabled).toBe(false));
      expect(find).not.toHaveBeenCalled();
      expect(screen.queryByTestId('team-mission-active-heading')).toBeNull();
    },
  );
});

describe('what the lookup can come back with', () => {
  it('none found: keeps the refusal and says the active mission could not be located', async () => {
    setup({ find: async () => found() });
    await submitRefusal();
    const note = await screen.findByTestId('team-mission-active-none');
    expect(note.textContent).toBe('The active mission on this front could not be located. It may be on another device, or the list may need a refresh.');
    expect(screen.getByTestId('team-mission-submit-error').getAttribute('data-error-code')).toBe('mission-active');
    expect(screen.queryByTestId('team-mission-active-heading')).toBeNull();
  });

  it('more than one: lists each with its own Open', async () => {
    const { open } = setup({
      find: async () => found({ id: 'm-aaaaaaaa-1', goal: 'First goal' }, { id: 'm-bbbbbbbb-2', goal: null }),
    });
    await submitRefusal();
    await screen.findByTestId('team-mission-active-m-aaaaaaaa-1');
    expect(screen.getByTestId('team-mission-active-heading').textContent).toBe('Active missions on this front');
    expect(screen.getByTestId('team-mission-active-m-aaaaaaaa-1').textContent).toContain('First goal');
    expect(screen.getByTestId('team-mission-active-m-bbbbbbbb-2').textContent).toContain('(no goal recorded)');
    fireEvent.click(screen.getByTestId('team-mission-open-m-bbbbbbbb-2'));
    await waitFor(() => expect(open).toHaveBeenCalledWith('m-bbbbbbbb-2'));
  });

  it('shows only a few, and says there are more', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `mission-${i}`, goal: `Goal ${i}` }));
    setup({ find: async () => found(...many) });
    await submitRefusal();
    await screen.findByTestId('team-mission-active-mission-0');
    expect(screen.getAllByTestId(/^team-mission-open-/)).toHaveLength(5);
    expect(screen.getByTestId('team-mission-active-more').textContent).toBe('There are more active missions on this front than shown.');
  });

  it('the lookup fails: the original refusal stays, with a short note', async () => {
    for (const reply of [{ ok: false } as FindActiveMissionsOutcome, 'throw' as const]) {
      const { unmount } = setup({ find: async () => { if (reply === 'throw') throw new Error('ipc closed'); return reply; } });
      await submitRefusal();
      const note = await screen.findByTestId('team-mission-active-failed');
      expect(note.textContent).toBe('Could not look for the active mission.');
      expect(screen.getByTestId('team-mission-submit-error').getAttribute('data-error-code')).toBe('mission-active');
      expect(screen.getByTestId('team-mission-error-message').textContent).toBe('This front already has an active mission. Archive that mission or choose another front.');
      expect(screen.queryByTestId('team-mission-active-heading')).toBeNull();
      unmount();
    }
  });

  it('shows a "looking" state while the host answers', async () => {
    const gate = deferred<FindActiveMissionsOutcome>();
    setup({ find: () => gate.promise });
    await submitRefusal();
    expect((await screen.findByTestId('team-mission-active-looking')).textContent).toBe('Looking for the active mission…');
    await act(async () => gate.resolve(found({ id: ACTIVE_ID, goal: 'Ship it' })));
    await screen.findByTestId(`team-mission-active-${ACTIVE_ID}`);
    expect(screen.queryByTestId('team-mission-active-looking')).toBeNull();
  });
});

describe('none found, by what triggered the lookup (N1)', () => {
  const TAKEN = 'The active mission on this front could not be located. It may be on another device, or the list may need a refresh.';
  const UNKNOWN = 'No mission was found on this front. If the creation did go through, it will appear in the session list.';

  it('after mission-active the front IS taken, so it says the active mission could not be located', async () => {
    setup({ find: async () => found() });
    await submitRefusal();
    expect((await screen.findByTestId('team-mission-active-none')).textContent).toBe(TAKEN);
  });

  it('after a failure with no code nothing says a mission exists: the text is neutral', async () => {
    setup({ outcome: { ok: false, message: 'Error: read-back failed' }, find: async () => found() });
    await submitRefusal();
    const note = await screen.findByTestId('team-mission-active-none');
    expect(note.textContent).toBe(UNKNOWN);
    expect(note.textContent).not.toMatch(/active mission|could not be located/i);
  });

  it('keeps the trigger when it looks again after a mission could not be opened', async () => {
    const answers = [found({ id: ACTIVE_ID, goal: 'Ship it' }), found()];
    setup({ outcome: { ok: false, message: 'Error: lost' }, open: async () => false, find: async () => answers.shift()! });
    await submitRefusal();
    fireEvent.click(await screen.findByTestId(`team-mission-open-${ACTIVE_ID}`));
    expect((await screen.findByTestId('team-mission-active-none')).textContent).toBe(UNKNOWN);
  });

  it('in pt-BR each trigger has its own text', async () => {
    await setLanguage('pt-BR');
    const first = setup({ find: async () => found() });
    await submitRefusal();
    expect((await screen.findByTestId('team-mission-active-none')).textContent).toBe(
      'Não foi possível localizar a missão ativa desta frente. Ela pode estar em outro dispositivo, ou a lista pode precisar ser atualizada.',
    );
    first.unmount();
    setup({ outcome: { ok: false, message: 'Error: x' }, find: async () => found() });
    await submitRefusal();
    expect((await screen.findByTestId('team-mission-active-none')).textContent).toBe(
      'Nenhuma missão foi encontrada nesta frente. Se a criação foi concluída, ela aparecerá na lista de sessões.',
    );
  });
});

describe('a tracker change that clears the chosen front also clears what was found (N2)', () => {
  it('removes a card that is on screen', async () => {
    setup();
    await submitRefusal();
    await screen.findByTestId(`team-mission-active-${ACTIVE_ID}`);

    invoke.mockImplementation(async (channel: string) =>
      channel === 'document-service:tracker-items-by-type' ? [{ ...FRONT, status: 'paused' }, FRONT_2] : undefined);
    act(() => store.set(trackerItemsChangedAtom, { version: 1, payload: {} }));

    await screen.findByTestId('team-mission-front-gone');
    expect(screen.queryByTestId(`team-mission-active-${ACTIVE_ID}`)).toBeNull();
    expect(screen.queryByTestId('team-mission-active-heading')).toBeNull();
    expect(screen.queryByTestId('team-mission-active-open-failed')).toBeNull();
    // The refusal itself is still what the user saw.
    expect(screen.getByTestId('team-mission-submit-error').getAttribute('data-error-code')).toBe('mission-active');
  });

  it('and a lookup that was still pending cannot bring the card back', async () => {
    const gate = deferred<FindActiveMissionsOutcome>();
    setup({ find: () => gate.promise });
    await submitRefusal();
    await screen.findByTestId('team-mission-active-looking');

    invoke.mockImplementation(async (channel: string) =>
      channel === 'document-service:tracker-items-by-type' ? [{ ...FRONT, status: 'closed' }, FRONT_2] : undefined);
    act(() => store.set(trackerItemsChangedAtom, { version: 1, payload: {} }));
    await screen.findByTestId('team-mission-front-gone');
    expect(screen.queryByTestId('team-mission-active-looking')).toBeNull();

    await act(async () => gate.resolve(found({ id: 'late', goal: 'Late answer' })));
    expect(screen.queryByTestId('team-mission-active-late')).toBeNull();
    expect(screen.queryByTestId('team-mission-active-heading')).toBeNull();
  });

  it('a change that leaves the chosen front pickable keeps the card', async () => {
    setup();
    await submitRefusal();
    await screen.findByTestId(`team-mission-active-${ACTIVE_ID}`);
    invoke.mockImplementation(async (channel: string) =>
      channel === 'document-service:tracker-items-by-type' ? [{ ...FRONT, title: 'Portal (renamed)' }, FRONT_2] : undefined);
    act(() => store.set(trackerItemsChangedAtom, { version: 1, payload: {} }));
    await screen.findByText('Portal (renamed)');
    expect(screen.getByTestId(`team-mission-active-${ACTIVE_ID}`)).toBeTruthy();
  });
});

describe('late answers and changes of mind', () => {
  it('a slow answer to an earlier attempt does not replace the answer to the latest one', async () => {
    const first = deferred<FindActiveMissionsOutcome>();
    const answers = [first.promise, Promise.resolve(found({ id: 'newer', goal: 'The newer lookup' }))];
    setup({ find: () => answers.shift()! });
    await submitRefusal(); // lookup #1, pending
    fireEvent.click(createButton()); // second attempt: lookup #2
    await screen.findByTestId('team-mission-active-newer');

    await act(async () => first.resolve(found({ id: 'older', goal: 'The older, stale lookup' })));
    expect(screen.queryByTestId('team-mission-active-older')).toBeNull();
    expect(screen.getByTestId('team-mission-active-newer')).toBeTruthy();
  });

  it('closing the dialog while the host answers shows nothing when it opens again', async () => {
    const gate = deferred<FindActiveMissionsOutcome>();
    const onSubmit = vi.fn(async () => ({ ok: false as const, errorCode: 'mission-active' as const, message: 'busy' }));
    const find = vi.fn(() => gate.promise);
    const { rerender } = render(<NewTeamMissionDialog isOpen onSubmit={onSubmit} onClose={vi.fn()} findActiveMissions={find} onOpenMission={vi.fn()} />);
    await ready();
    pick('tfr_active');
    type('team-mission-goal', 'Goal');
    fireEvent.click(createButton());
    await screen.findByTestId('team-mission-active-looking');

    rerender(<NewTeamMissionDialog isOpen={false} onSubmit={onSubmit} onClose={vi.fn()} findActiveMissions={find} onOpenMission={vi.fn()} />);
    rerender(<NewTeamMissionDialog isOpen onSubmit={onSubmit} onClose={vi.fn()} findActiveMissions={find} onOpenMission={vi.fn()} />);
    await ready();
    await act(async () => gate.resolve(found({ id: 'late', goal: 'Late answer' })));
    expect(screen.queryByTestId('team-mission-active-late')).toBeNull();
    expect(screen.queryByTestId('team-mission-active-heading')).toBeNull();
  });

  it('picking another front clears what was found for the previous one', async () => {
    setup();
    await submitRefusal();
    await screen.findByTestId(`team-mission-active-${ACTIVE_ID}`);
    pick('tfr_active2');
    expect(screen.queryByTestId(`team-mission-active-${ACTIVE_ID}`)).toBeNull();
    expect(screen.queryByTestId('team-mission-active-heading')).toBeNull();
  });

  it('a lookup that finds the workspace changed (stale) shows nothing and keeps the refusal', async () => {
    setup({ find: async () => ({ ok: false, stale: true }) });
    await submitRefusal();
    await waitFor(() => expect(screen.queryByTestId('team-mission-active-looking')).toBeNull());
    expect(screen.queryByTestId('team-mission-active-failed')).toBeNull();
    expect(screen.queryByTestId('team-mission-active-none')).toBeNull();
    expect(screen.queryByTestId('team-mission-active-heading')).toBeNull();
    expect(screen.getByTestId('team-mission-submit-error').getAttribute('data-error-code')).toBe('mission-active');
  });

  it('a successful creation never runs a lookup', async () => {
    const { find, onClose } = setup({ outcome: { ok: true, sessionId: 'new' } });
    await ready();
    pick('tfr_active');
    type('team-mission-goal', 'Goal');
    fireEvent.click(createButton());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(find).not.toHaveBeenCalled();
  });

  it('without the lookup callbacks the dialog behaves as before', async () => {
    setup({ withLookup: false });
    await submitRefusal();
    expect(screen.getByTestId('team-mission-submit-error').getAttribute('data-error-code')).toBe('mission-active');
    expect(screen.queryByTestId('team-mission-active-looking')).toBeNull();
    expect(screen.queryByTestId('team-mission-active-heading')).toBeNull();
  });
});

describe('Brazilian Portuguese', () => {
  it('speaks the lookup in pt-BR', async () => {
    await setLanguage('pt-BR');
    setup({ find: async () => found({ id: ACTIVE_ID, goal: 'Entregar a camada de identidade' }) });
    await submitRefusal();
    await screen.findByTestId(`team-mission-active-${ACTIVE_ID}`);
    expect(screen.getByTestId('team-mission-active-heading').textContent).toBe('Missão ativa nesta frente');
    expect(screen.getByTestId(`team-mission-open-${ACTIVE_ID}`).textContent).toBe('Abrir missão');
  });

  it('pt-BR notes: none found and lookup failed', async () => {
    await setLanguage('pt-BR');
    const { unmount } = setup({ find: async () => found() });
    await submitRefusal();
    expect((await screen.findByTestId('team-mission-active-none')).textContent).toBe(
      'Não foi possível localizar a missão ativa desta frente. Ela pode estar em outro dispositivo, ou a lista pode precisar ser atualizada.',
    );
    unmount();
    setup({ find: async () => ({ ok: false }) });
    await submitRefusal();
    expect((await screen.findByTestId('team-mission-active-failed')).textContent).toBe('Não foi possível procurar a missão ativa.');
  });
});
