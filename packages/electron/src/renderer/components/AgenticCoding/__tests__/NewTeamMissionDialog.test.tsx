// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { setLanguage } from '@nimbalyst/runtime/i18n';
import { NewTeamMissionDialog } from '../NewTeamMissionDialog';
import { trackerItemsChangedAtom } from '../../../store/atoms/trackerItemsChanged';
import type { TeamMissionCreateOutcome } from '../../../store/actions/sessionHistoryActions';
import type { TeamMissionRequestPayload } from '../../../../shared/teamMission';

const FRONT_ACTIVE = { id: 'tfr_active', type: 'team-front', title: 'Portal', status: 'active', archived: false };
const FRONT_ACTIVE_2 = { id: 'tfr_active2', type: 'team-front', title: 'Team Mode', status: 'active', archived: false };
const FRONT_PAUSED = { id: 'tfr_paused', type: 'team-front', title: 'Sync', status: 'paused', archived: false };
const FRONT_CLOSED = { id: 'tfr_closed', type: 'team-front', title: 'Old work', status: 'closed', archived: false };

const MISSION_KEYS = ['teamFront', 'teamGoal', 'teamDoneCriterion', 'teamMissionStatus', 'teamMissionContext', 'teamMissionVersion', 'currentMission', 'metadata'];

let fronts: unknown[];
let invoke: ReturnType<typeof vi.fn>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function setup(onSubmit: (request: TeamMissionRequestPayload) => Promise<TeamMissionCreateOutcome> = async () => ({ ok: true, sessionId: 's1' })) {
  const onClose = vi.fn();
  const submit = vi.fn(onSubmit);
  const view = render(<NewTeamMissionDialog isOpen onSubmit={submit} onClose={onClose} />);
  return { onClose, submit, ...view };
}

async function ready() {
  await screen.findByTestId('team-mission-front-tfr_active');
}

const pick = (id: string) => fireEvent.click(screen.getByTestId(`team-mission-front-${id}`));
const type = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });
const createButton = () => screen.getByTestId('team-mission-create') as HTMLButtonElement;

beforeEach(() => {
  fronts = [FRONT_PAUSED, FRONT_ACTIVE, FRONT_CLOSED, FRONT_ACTIVE_2];
  invoke = vi.fn(async (channel: string) => (channel === 'document-service:tracker-items-by-type' ? fronts : undefined));
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { invoke } });
});

afterEach(async () => {
  cleanup();
  store.set(trackerItemsChangedAtom, null);
  await setLanguage('en');
});

describe('opening and loading the fronts', () => {
  it('shows the loading state, then the fronts read from the existing tracker channel', async () => {
    const gate = deferred<unknown[]>();
    invoke.mockImplementationOnce(() => gate.promise);
    setup();
    expect(screen.getByTestId('team-mission-fronts-loading')).toBeTruthy();
    expect(createButton().disabled).toBe(true);
    gate.resolve(fronts);
    await ready();
    expect(screen.queryByTestId('team-mission-fronts-loading')).toBeNull();
    expect(invoke).toHaveBeenCalledWith('document-service:tracker-items-by-type', 'team-front');
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('New mission');
  });

  it('lists active fronts first; paused and closed ones are disabled with their status visible', async () => {
    setup();
    await ready();
    const order = screen.getAllByRole('radio').map((el) => el.getAttribute('data-testid'));
    expect(order).toEqual([
      'team-mission-front-tfr_active',
      'team-mission-front-tfr_active2',
      'team-mission-front-tfr_paused',
      'team-mission-front-tfr_closed',
    ]);
    expect((screen.getByTestId('team-mission-front-tfr_paused') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('team-mission-front-tfr_closed') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('team-mission-front-tfr_active') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId('team-mission-front-status-tfr_paused').textContent).toBe('Paused');
    expect(screen.getByTestId('team-mission-front-status-tfr_closed').textContent).toBe('Closed');
    expect(screen.getByTestId('team-mission-front-status-tfr_active').textContent).toBe('Active');
  });

  it('selects an active front, and a click on a paused or a closed one selects nothing', async () => {
    setup();
    await ready();
    pick('tfr_paused');
    pick('tfr_closed');
    expect(screen.getAllByRole('radio').every((el) => el.getAttribute('aria-checked') === 'false')).toBe(true);
    pick('tfr_active2');
    expect(screen.getByTestId('team-mission-front-tfr_active2').getAttribute('aria-checked')).toBe('true');
  });

  it('says so when the workspace has no fronts', async () => {
    fronts = [];
    setup();
    await screen.findByTestId('team-mission-no-fronts');
    expect(createButton().disabled).toBe(true);
  });

  it('says so when there are fronts but none is active, and still shows them', async () => {
    fronts = [FRONT_PAUSED, FRONT_CLOSED];
    setup();
    await screen.findByTestId('team-mission-no-active-front');
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    type('team-mission-goal', 'A goal');
    expect(createButton().disabled).toBe(true);
  });

  it('shows a load error with a retry that loads again', async () => {
    invoke.mockRejectedValueOnce(new Error('ipc down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setup();
    await screen.findByTestId('team-mission-fronts-error');
    fireEvent.click(screen.getByTestId('team-mission-fronts-retry'));
    await ready();
    expect(screen.queryByTestId('team-mission-fronts-error')).toBeNull();
  });
});

describe('the goal and the done criterion', () => {
  it('needs a front and a goal before it can start, and a blank goal does not count', async () => {
    setup();
    await ready();
    expect(createButton().disabled).toBe(true);
    pick('tfr_active');
    expect(createButton().disabled).toBe(true);
    type('team-mission-goal', '   ');
    expect(createButton().disabled).toBe(true);
    expect(screen.getByTestId('team-mission-goal-error').textContent).toBe('The goal is required.');
    type('team-mission-goal', 'Ship the dialog');
    expect(createButton().disabled).toBe(false);
  });

  it('shows a counter against the shared limit, never cuts the text and blocks only past the limit', async () => {
    setup();
    await ready();
    pick('tfr_active');
    const goal = screen.getByTestId('team-mission-goal') as HTMLTextAreaElement;
    expect(goal.getAttribute('maxlength')).toBeNull();
    expect(screen.getByTestId('team-mission-goal-counter').textContent).toBe('0/400');

    type('team-mission-goal', 'a'.repeat(400));
    expect(screen.getByTestId('team-mission-goal-counter').textContent).toBe('400/400');
    expect(createButton().disabled).toBe(false);

    type('team-mission-goal', 'a'.repeat(401));
    expect(goal.value).toHaveLength(401);
    expect(screen.getByTestId('team-mission-goal-counter').textContent).toBe('401/400');
    expect(screen.getByTestId('team-mission-goal-error').textContent).toContain('401 of 400');
    expect(createButton().disabled).toBe(true);
  });

  it('counts the trimmed text, as the main does', async () => {
    setup();
    await ready();
    pick('tfr_active');
    type('team-mission-goal', `  ${'a'.repeat(400)}  `);
    expect(screen.getByTestId('team-mission-goal-counter').textContent).toBe('400/400');
    expect(createButton().disabled).toBe(false);
  });

  it('applies the same limit to the optional done criterion', async () => {
    setup();
    await ready();
    pick('tfr_active');
    type('team-mission-goal', 'A goal');
    type('team-mission-done', 'b'.repeat(401));
    expect(createButton().disabled).toBe(true);
    expect(screen.getByTestId('team-mission-done-counter').textContent).toBe('401/400');
    type('team-mission-done', 'b'.repeat(400));
    expect(createButton().disabled).toBe(false);
    type('team-mission-done', '');
    expect(createButton().disabled).toBe(false);
  });
});

describe('what is sent', () => {
  it('hands over the front id and the text exactly as typed, and nothing else', async () => {
    const { submit } = setup();
    await ready();
    pick('tfr_active2');
    type('team-mission-goal', '  Ship the dialog\nin two steps  ');
    type('team-mission-done', ' all tests green ');
    fireEvent.click(createButton());
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const request = submit.mock.calls[0][0];
    expect(request).toEqual({ front: 'tfr_active2', goal: '  Ship the dialog\nin two steps  ', doneCriterion: ' all tests green ' });
    for (const key of MISSION_KEYS) expect(request).not.toHaveProperty(key);
  });

  it('leaves the done criterion out when it is empty', async () => {
    const { submit } = setup();
    await ready();
    pick('tfr_active');
    type('team-mission-goal', 'Goal');
    fireEvent.click(createButton());
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(Object.keys(submit.mock.calls[0][0]).sort()).toEqual(['front', 'goal']);
  });

  it('Ctrl+Enter sends, like the button', async () => {
    const { submit } = setup();
    await ready();
    pick('tfr_active');
    type('team-mission-goal', 'Goal');
    fireEvent.keyDown(screen.getByTestId('team-mission-goal'), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  });
});

describe('success, cancel and the double submit', () => {
  it('closes the dialog on success', async () => {
    const { onClose } = setup();
    await ready();
    pick('tfr_active');
    type('team-mission-goal', 'Goal');
    fireEvent.click(createButton());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('team-mission-submit-error')).toBeNull();
  });

  it('sends once however many times the user clicks, and locks the form while it runs', async () => {
    const gate = deferred<TeamMissionCreateOutcome>();
    const { submit, onClose } = setup(() => gate.promise);
    await ready();
    pick('tfr_active');
    type('team-mission-goal', 'Goal');

    // Two clicks and a shortcut in the same tick: React has not re-rendered between them, so
    // only the synchronous in-flight guard (not the disabled button) can stop the second send.
    const button = createButton();
    act(() => {
      button.click();
      button.click();
      screen.getByTestId('team-mission-goal').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    });
    expect(submit).toHaveBeenCalledTimes(1);

    expect(createButton().disabled).toBe(true);
    expect(createButton().textContent).toBe('Starting…');
    expect(screen.getByTestId('team-mission-spinner')).toBeTruthy();
    expect((screen.getByTestId('team-mission-goal') as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByTestId('team-mission-cancel') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('team-mission-front-tfr_active2') as HTMLButtonElement).disabled).toBe(true);

    // Cancel, ESC and the overlay do nothing while it runs.
    fireEvent.click(screen.getByTestId('team-mission-cancel'));
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('team-mission-dialog-overlay'));
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => gate.resolve({ ok: true, sessionId: 's1' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('cancels with the button, ESC and the overlay, and sends nothing', async () => {
    const { submit, onClose } = setup();
    await ready();
    fireEvent.click(screen.getByTestId('team-mission-cancel'));
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('team-mission-dialog-overlay'));
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(submit).not.toHaveBeenCalled();
  });

  it('a click inside the dialog does not close it', async () => {
    const { onClose } = setup();
    await ready();
    fireEvent.click(screen.getByTestId('team-mission-dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('refusals and failures of the main', () => {
  async function fillAndSubmit(front = 'tfr_active') {
    await ready();
    pick(front);
    type('team-mission-goal', 'My goal');
    type('team-mission-done', 'My done');
    fireEvent.click(createButton());
  }

  it('mission-active: a translated message, the main message as detail, the dialog stays with the text', async () => {
    const message = 'Front "Portal" (tfr_active) already has an active mission (session abc, "Portal — release"); close or archive it, or choose another front.';
    const { onClose } = setup(async () => ({ ok: false, errorCode: 'mission-active', message }));
    await fillAndSubmit();
    const alert = await screen.findByRole('alert');
    expect(alert.getAttribute('data-error-code')).toBe('mission-active');
    expect(screen.getByTestId('team-mission-error-message').textContent).toBe('This front already has an active mission. Archive that mission or choose another front.');
    expect(screen.getByTestId('team-mission-error-details').textContent).toBe('Details: ' + message);
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByTestId('team-mission-goal') as HTMLTextAreaElement).value).toBe('My goal');
    expect((screen.getByTestId('team-mission-done') as HTMLTextAreaElement).value).toBe('My done');
    // The form is usable again (a retry is possible) and the refusal reloaded the fronts.
    expect(createButton().disabled).toBe(false);
    await waitFor(() => expect(invoke.mock.calls.filter(([c]) => c === 'document-service:tracker-items-by-type')).toHaveLength(2));
  });

  const REFUSALS: Array<[string, string]> = [
    ['invalid-request', 'Nimbalyst rejected the mission data. Review the front, the goal and the done criterion.'],
    ['not-a-team-root', 'A mission can only start on a new Team mode session.'],
    ['session-exists', 'That session already exists or was created at the same moment. Try again.'],
    ['front-not-found', 'This front no longer exists in the workspace. The list was refreshed.'],
    ['front-unavailable', 'This front can no longer take a new mission (it is paused, closed or archived). The list was refreshed.'],
    ['no-workspace', 'Open a workspace first.'],
    ['remote-host', 'A mission can only be started in a local workspace, not on a remote machine.'],
  ];
  it.each(REFUSALS)('%s gets its own message and never closes the dialog', async (errorCode, expected) => {
    const { onClose } = setup(async () => ({ ok: false, errorCode: errorCode as any, message: 'main says no' }));
    await fillAndSubmit();
    await screen.findByRole('alert');
    expect(screen.getByTestId('team-mission-error-message').textContent).toBe(expected);
    expect(screen.getByTestId('team-mission-error-details').textContent).toContain('main says no');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a failure without a code, or with an unknown one, gets the generic message plus the main detail', async () => {
    for (const errorCode of [undefined, 'from-the-future']) {
      const { onClose, unmount } = setup(async () => ({ ok: false, errorCode: errorCode as any, message: 'Error: db is down' }));
      await fillAndSubmit();
      await screen.findByRole('alert');
      expect(screen.getByTestId('team-mission-error-message').textContent).toBe('The mission could not be started.');
      expect(screen.getByTestId('team-mission-error-details').textContent).toContain('Error: db is down');
      expect(onClose).not.toHaveBeenCalled();
      unmount();
    }
  });

  it('a submit that throws is a failure, not a success', async () => {
    const { onClose } = setup(async () => { throw new Error('boom'); });
    await fillAndSubmit();
    await screen.findByRole('alert');
    expect(screen.getByTestId('team-mission-error-details').textContent).toContain('boom');
    expect(onClose).not.toHaveBeenCalled();
    expect(createButton().disabled).toBe(false);
  });

  it('front-unavailable after the front changed state: the list is reloaded and the stale choice is cleared', async () => {
    const { submit } = setup(async () => ({ ok: false, errorCode: 'front-unavailable', message: 'its status is "paused"' }));
    await ready();
    pick('tfr_active');
    type('team-mission-goal', 'My goal');
    // The front is paused in the Tracker without the dialog hearing about it...
    fronts = [{ ...FRONT_ACTIVE, status: 'paused' }, FRONT_ACTIVE_2, FRONT_PAUSED, FRONT_CLOSED];
    fireEvent.click(createButton());
    // ...so the main refuses, and the dialog reloads.
    await screen.findByRole('alert');
    await waitFor(() => expect((screen.getByTestId('team-mission-front-tfr_active') as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByTestId('team-mission-front-tfr_active').getAttribute('aria-checked')).toBe('false');
    expect(createButton().disabled).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
    // The user picks another front and the text they typed is still there.
    pick('tfr_active2');
    expect((screen.getByTestId('team-mission-goal') as HTMLTextAreaElement).value).toBe('My goal');
    expect(createButton().disabled).toBe(false);
  });
});

describe('a front changes while the dialog is open', () => {
  it('a tracker change that makes the chosen front unavailable clears the choice and says so', async () => {
    setup();
    await ready();
    pick('tfr_active');
    type('team-mission-goal', 'My goal');
    expect(createButton().disabled).toBe(false);

    fronts = [{ ...FRONT_ACTIVE, status: 'paused' }, FRONT_ACTIVE_2, FRONT_PAUSED, FRONT_CLOSED];
    act(() => store.set(trackerItemsChangedAtom, { version: 1, payload: {} }));

    await screen.findByTestId('team-mission-front-gone');
    expect(screen.getByTestId('team-mission-front-status-tfr_active').textContent).toBe('Paused');
    expect(createButton().disabled).toBe(true);
    expect((screen.getByTestId('team-mission-goal') as HTMLTextAreaElement).value).toBe('My goal');
  });

  it('a change that leaves the chosen front active keeps the choice', async () => {
    setup();
    await ready();
    pick('tfr_active');
    fronts = [{ ...FRONT_ACTIVE, title: 'Portal (renamed)' }, FRONT_ACTIVE_2, FRONT_PAUSED, FRONT_CLOSED];
    act(() => store.set(trackerItemsChangedAtom, { version: 1, payload: {} }));
    await screen.findByText('Portal (renamed)');
    expect(screen.getByTestId('team-mission-front-tfr_active').getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByTestId('team-mission-front-gone')).toBeNull();
  });
});

describe('opening again and the language', () => {
  it('starts clean every time it opens', async () => {
    const onSubmit = vi.fn(async () => ({ ok: true as const, sessionId: 's' }));
    const { rerender } = render(<NewTeamMissionDialog isOpen onSubmit={onSubmit} onClose={vi.fn()} />);
    await ready();
    pick('tfr_active');
    type('team-mission-goal', 'Left over');
    rerender(<NewTeamMissionDialog isOpen={false} onSubmit={onSubmit} onClose={vi.fn()} />);
    expect(screen.queryByTestId('team-mission-dialog')).toBeNull();
    rerender(<NewTeamMissionDialog isOpen onSubmit={onSubmit} onClose={vi.fn()} />);
    await ready();
    expect((screen.getByTestId('team-mission-goal') as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByTestId('team-mission-front-tfr_active').getAttribute('aria-checked')).toBe('false');
  });

  it('renders in Brazilian Portuguese, including the status of the fronts and a refusal', async () => {
    await setLanguage('pt-BR');
    setup(async () => ({ ok: false, errorCode: 'mission-active', message: 'detail' }));
    await ready();
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('Nova missão');
    expect(screen.getByTestId('team-mission-front-status-tfr_paused').textContent).toBe('Pausada');
    expect(screen.getByTestId('team-mission-front-status-tfr_closed').textContent).toBe('Fechada');
    pick('tfr_active');
    type('team-mission-goal', 'Meu objetivo');
    fireEvent.click(createButton());
    await screen.findByRole('alert');
    expect(screen.getByTestId('team-mission-error-message').textContent).toBe('Esta frente já tem uma missão ativa. Arquive essa missão ou escolha outra frente.');
  });
});

describe('overlapping loads (the older answer arrives last)', () => {
  it('does not overwrite the list or bring back a selection a newer load cleared', async () => {
    setup();
    await ready();
    pick('tfr_active');
    type('team-mission-goal', 'My goal');

    const older = deferred<unknown[]>();
    const newer = deferred<unknown[]>();
    invoke.mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise);
    act(() => store.set(trackerItemsChangedAtom, { version: 1, payload: {} }));
    act(() => store.set(trackerItemsChangedAtom, { version: 2, payload: {} }));

    // The newer load says the chosen front was paused...
    await act(async () => newer.resolve([{ ...FRONT_ACTIVE, status: 'paused' }, FRONT_ACTIVE_2]));
    await screen.findByTestId('team-mission-front-gone');
    expect(screen.getByTestId('team-mission-front-status-tfr_active').textContent).toBe('Paused');
    expect(createButton().disabled).toBe(true);

    // ...and the older, stale one (still showing it active and a third front) must not undo that.
    await act(async () => older.resolve([FRONT_ACTIVE, FRONT_ACTIVE_2, { id: 'tfr_stale', type: 'team-front', title: 'Stale', status: 'active', archived: false }]));
    expect(screen.getByTestId('team-mission-front-status-tfr_active').textContent).toBe('Paused');
    expect(screen.queryByTestId('team-mission-front-tfr_stale')).toBeNull();
    expect(screen.getByTestId('team-mission-front-tfr_active').getAttribute('aria-checked')).toBe('false');
    expect(createButton().disabled).toBe(true);
  });
});

describe('front-not-found', () => {
  it('reloads the list and drops the front that no longer exists', async () => {
    setup(async () => ({ ok: false, errorCode: 'front-not-found', message: 'No team-front with id "tfr_active"' }));
    await ready();
    pick('tfr_active');
    type('team-mission-goal', 'My goal');
    const loadsBefore = invoke.mock.calls.filter(([c]) => c === 'document-service:tracker-items-by-type').length;
    // The front was deleted in the Tracker; the dialog has not heard of it.
    fronts = [FRONT_ACTIVE_2, FRONT_PAUSED, FRONT_CLOSED];
    fireEvent.click(createButton());

    await screen.findByRole('alert');
    expect(screen.getByTestId('team-mission-error-message').textContent).toBe('This front no longer exists in the workspace. The list was refreshed.');
    await waitFor(() => expect(screen.queryByTestId('team-mission-front-tfr_active')).toBeNull());
    expect(invoke.mock.calls.filter(([c]) => c === 'document-service:tracker-items-by-type').length).toBe(loadsBefore + 1);
    expect(createButton().disabled).toBe(true);
    expect((screen.getByTestId('team-mission-goal') as HTMLTextAreaElement).value).toBe('My goal');
  });
});

describe('the empty state does not claim more than the dialog knows', () => {
  it('is neutral (the read may have failed) and offers a retry that loads again', async () => {
    fronts = [];
    setup();
    const empty = await screen.findByTestId('team-mission-no-fronts');
    expect(empty.textContent).toBe('No active team fronts found. If you expected one, create or reactivate a Team Front in the Tracker, then try again.');
    expect(empty.textContent).not.toMatch(/no fronts yet|has no fronts/i);

    fronts = [FRONT_ACTIVE];
    fireEvent.click(screen.getByTestId('team-mission-fronts-retry'));
    await ready();
    expect(screen.queryByTestId('team-mission-no-fronts')).toBeNull();
  });

  it('says it in Brazilian Portuguese too', async () => {
    await setLanguage('pt-BR');
    fronts = [];
    setup();
    const empty = await screen.findByTestId('team-mission-no-fronts');
    expect(empty.textContent).toBe('Nenhuma frente de equipe ativa encontrada. Se você esperava uma, crie ou reative uma Team Front no Rastreador e tente de novo.');
    expect(screen.getByTestId('team-mission-fronts-retry').textContent).toBe('Tentar de novo');
  });
});

describe('status labels', () => {
  it('a status the dialog does not know gets the "Status unknown" label and cannot be selected', async () => {
    fronts = [FRONT_ACTIVE, { id: 'tfr_odd', type: 'team-front', title: 'Odd', status: 'on-hold', archived: false }];
    setup();
    await ready();
    expect(screen.getByTestId('team-mission-front-status-tfr_odd').textContent).toBe('Status unknown');
    expect((screen.getByTestId('team-mission-front-tfr_odd') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('focus and keyboard (aria-modal)', () => {
  it('puts focus inside the dialog when it opens, then on the first front you can pick', async () => {
    setup();
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    await ready();
    expect(document.activeElement).toBe(screen.getByTestId('team-mission-front-tfr_active'));
  });

  it('does not steal focus from a field the user already moved to while the fronts loaded', async () => {
    const gate = deferred<unknown[]>();
    invoke.mockImplementationOnce(() => gate.promise);
    setup();
    const goal = screen.getByTestId('team-mission-goal');
    goal.focus();
    await act(async () => gate.resolve(fronts));
    await ready();
    expect(document.activeElement).toBe(goal);
  });

  it('moves between the active fronts with the arrow keys, selecting as it goes and skipping the disabled ones', async () => {
    fronts = [FRONT_ACTIVE, FRONT_PAUSED, FRONT_ACTIVE_2, FRONT_CLOSED];
    setup();
    await ready();
    const first = screen.getByTestId('team-mission-front-tfr_active');
    const second = screen.getByTestId('team-mission-front-tfr_active2');
    first.focus();

    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);
    expect(second.getAttribute('aria-checked')).toBe('true');
    expect(first.getAttribute('aria-checked')).toBe('false');

    fireEvent.keyDown(second, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(first);
    expect(first.getAttribute('aria-checked')).toBe('true');

    fireEvent.keyDown(first, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(first);
  });

  it('only the chosen front (or the first one, if none) is in the tab order', async () => {
    setup();
    await ready();
    const tabbable = () => screen.getAllByRole('radio').filter((el) => el.getAttribute('tabindex') === '0').map((el) => el.getAttribute('data-testid'));
    expect(tabbable()).toEqual(['team-mission-front-tfr_active']);
    pick('tfr_active2');
    expect(tabbable()).toEqual(['team-mission-front-tfr_active2']);
  });

  it('Tab at the last control wraps to the first and Shift+Tab at the first wraps to the last', async () => {
    setup();
    await ready();
    pick('tfr_active');
    type('team-mission-goal', 'Goal');
    const create = createButton();
    expect(create.disabled).toBe(false);
    create.focus();
    fireEvent.keyDown(create, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByTestId('team-mission-front-tfr_active'));
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(create);
  });

  it('brings focus back when it lands outside the open dialog', async () => {
    setup();
    await ready();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    outside.remove();
  });

  it('gives focus back to what had it before the dialog opened', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const onSubmit = vi.fn(async () => ({ ok: true as const, sessionId: 's' }));
    const { rerender } = render(<NewTeamMissionDialog isOpen onSubmit={onSubmit} onClose={vi.fn()} />);
    await ready();
    rerender(<NewTeamMissionDialog isOpen={false} onSubmit={onSubmit} onClose={vi.fn()} />);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

describe('no stale frame when it opens again', () => {
  it('never renders the error, the spinner or the old form of the previous session', async () => {
    const onSubmit = vi.fn(async () => ({ ok: false as const, errorCode: 'mission-active' as const, message: 'old detail' }));
    const { rerender } = render(<NewTeamMissionDialog isOpen onSubmit={onSubmit} onClose={vi.fn()} />);
    await ready();
    pick('tfr_active');
    type('team-mission-goal', 'Left over');
    fireEvent.click(createButton());
    await screen.findByRole('alert');
    rerender(<NewTeamMissionDialog isOpen={false} onSubmit={onSubmit} onClose={vi.fn()} />);

    // Watch every node the reopening inserts or removes, across all of its commits. A node
    // that appears in a stale first frame and is removed by a later one shows up as removed.
    const seen: string[] = [];
    const observer = new MutationObserver(() => {});
    observer.observe(document.body, { childList: true, subtree: true });
    const gate = deferred<unknown[]>();
    invoke.mockImplementationOnce(() => gate.promise);
    rerender(<NewTeamMissionDialog isOpen onSubmit={onSubmit} onClose={vi.fn()} />);
    for (const record of observer.takeRecords()) {
      for (const node of [...record.addedNodes, ...record.removedNodes]) seen.push((node as HTMLElement).outerHTML ?? '');
    }
    observer.disconnect();

    const html = seen.join('|');
    expect(html).not.toContain('team-mission-submit-error');
    expect(html).not.toContain('team-mission-spinner');
    expect((screen.getByTestId('team-mission-goal') as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByTestId('team-mission-fronts-loading')).toBeTruthy();
    await act(async () => gate.resolve(fronts));
  });
});

describe('Brazilian Portuguese, with the numbers interpolated', () => {
  it('shows the counter and the too-long message with the real counts', async () => {
    await setLanguage('pt-BR');
    setup();
    await ready();
    pick('tfr_active');
    type('team-mission-goal', 'a'.repeat(401));
    expect(screen.getByTestId('team-mission-goal-counter').textContent).toBe('401/400');
    expect(screen.getByTestId('team-mission-goal-error').textContent).toBe('Longo demais: 401 de 400 caracteres. Reduza o texto; nada é cortado por você.');
    type('team-mission-goal', 'Meu objetivo');
    type('team-mission-done', 'b'.repeat(450));
    expect(screen.getByTestId('team-mission-done-counter').textContent).toBe('450/400');
    expect(screen.getByTestId('team-mission-done-error').textContent).toBe('Longo demais: 450 de 400 caracteres. Reduza o texto; nada é cortado por você.');
  });

  it('names the status to look for in the Rastreador, in both languages, and the details line is interpolated', async () => {
    await setLanguage('pt-BR');
    fronts = [FRONT_PAUSED];
    const { unmount } = setup(async () => ({ ok: false, errorCode: 'invalid-request', message: 'main said "no"' }));
    const hint = await screen.findByTestId('team-mission-no-active-front');
    expect(hint.textContent).toBe('Nenhuma frente está ativa. Defina uma frente como Ativa (Active) no Rastreador para iniciar uma missão nela.');
    unmount();

    await setLanguage('en');
    setup();
    const english = await screen.findByTestId('team-mission-no-active-front');
    expect(english.textContent).toBe('No front is active. Set a front to Active in the Tracker to start a mission on it.');
  });

  it('shows the main detail as one interpolated line, in both languages, quotes intact', async () => {
    for (const [language, expected] of [['en', 'Details: main said "no"'], ['pt-BR', 'Detalhes: main said "no"']] as const) {
      await setLanguage(language);
      const { unmount } = setup(async () => ({ ok: false, errorCode: 'invalid-request', message: 'main said "no"' }));
      await ready();
      pick('tfr_active');
      type('team-mission-goal', 'Goal');
      fireEvent.click(createButton());
      await screen.findByRole('alert');
      expect(screen.getByTestId('team-mission-error-details').textContent).toBe(expected);
      unmount();
    }
  });
});

describe('arrow keys without a stable id or a current focus', () => {
  it('works for a front id that would break an attribute selector', async () => {
    const odd = { id: 'weird"]id', type: 'team-front', title: 'Odd id', status: 'active', archived: false };
    fronts = [FRONT_ACTIVE, odd];
    setup();
    await ready();
    const first = screen.getByTestId('team-mission-front-tfr_active');
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    const second = screen.getByTestId('team-mission-front-weird"]id');
    expect(document.activeElement).toBe(second);
    expect(second.getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(second, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(first);
  });

  it('with no current focus, forward goes to the first enabled front and backward to the LAST one', async () => {
    fronts = [FRONT_ACTIVE, FRONT_PAUSED, FRONT_ACTIVE_2, { id: 'tfr_active3', type: 'team-front', title: 'Third', status: 'active', archived: false }];
    setup();
    await ready();
    const group = screen.getByRole('radiogroup');
    (document.activeElement as HTMLElement).blur();
    expect(group.contains(document.activeElement)).toBe(false);
    fireEvent.keyDown(group, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByTestId('team-mission-front-tfr_active3'));

    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(group, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByTestId('team-mission-front-tfr_active'));
  });
});

describe('focus after a refusal', () => {
  it('moves back into the dialog when the browser dropped it, so Ctrl+Enter keeps working', async () => {
    const outcomes = [{ ok: false as const, errorCode: 'mission-active' as const, message: 'busy' }, { ok: true as const, sessionId: 's' }];
    const { submit, onClose } = setup(async () => {
      // A browser takes focus off the button that has just been disabled for the request.
      (document.activeElement as HTMLElement).blur();
      return outcomes.shift()!;
    });
    await ready();
    pick('tfr_active');
    type('team-mission-goal', 'Goal');
    const create = createButton();
    create.focus();
    fireEvent.click(create);
    await screen.findByRole('alert');
    expect(document.activeElement).not.toBeNull();

    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);

    fireEvent.keyDown(document.activeElement!, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
