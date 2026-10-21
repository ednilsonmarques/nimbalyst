// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { setLanguage } from '@nimbalyst/runtime/i18n';
import { UnsavedChangesDialog } from '../UnsavedChangesDialog';
import { useUnsavedChangesDialog, type UnsavedAttempt, type UnsavedChoice } from '../../../hooks/useUnsavedChangesDialog';

afterEach(async () => {
  cleanup();
  await setLanguage('en');
});

const api: { current: ReturnType<typeof useUnsavedChangesDialog> | null } = { current: null };

function Harness() {
  const dialog = useUnsavedChangesDialog();
  api.current = dialog;
  return (
    <UnsavedChangesDialog
      isOpen={dialog.isOpen}
      isSaving={dialog.isSaving}
      onSave={dialog.onSave}
      onDiscard={dialog.onDiscard}
      onCancel={dialog.onCancel}
    />
  );
}

async function openDialog() {
  const onChoice = vi.fn();
  render(<Harness />);
  let attempt: UnsavedAttempt | null = null;
  await act(async () => { attempt = api.current!.ask(); });
  attempt!.choice.then(onChoice);
  return { onChoice, attempt: attempt! as UnsavedAttempt };
}

describe('UnsavedChangesDialog (N1)', () => {
  it('has Cancel, Don\'t save and Save, each resolving to its own answer', async () => {
    for (const [label, expected] of [['Cancel', 'cancel'], ['Don\'t Save', 'discard'], ['Save', 'save']] as const) {
      const { onChoice } = await openDialog();
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: label })); });
      expect(onChoice).toHaveBeenCalledWith(expected);
      cleanup();
    }
  });

  it('Esc and a click on the overlay keep editing: they never resolve to discard', async () => {
    let { onChoice } = await openDialog();
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }); });
    expect(onChoice).toHaveBeenCalledTimes(1);
    expect(onChoice).toHaveBeenCalledWith('cancel');
    cleanup();

    ({ onChoice } = await openDialog());
    await act(async () => { fireEvent.click(screen.getByTestId('unsaved-changes-overlay')); });
    expect(onChoice).toHaveBeenCalledTimes(1);
    expect(onChoice).toHaveBeenCalledWith('cancel');
  });

  it('is localised in pt-BR with a Cancelar button', async () => {
    await setLanguage('pt-BR');
    await openDialog();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Não salvar' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Salvar' })).toBeTruthy();
  });
});

describe('the dialog covers the whole attempt (A2)', () => {
  it('after Save the dialog stays open in a saving state where only Cancel is available', async () => {
    const { onChoice } = await openDialog();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    expect(onChoice).toHaveBeenCalledWith('save');
    expect(screen.getByText('Saving…')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Don\'t Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('Cancel while saving invalidates the attempt, so a late success is not current and cannot finish it', async () => {
    const { attempt } = await openDialog();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    expect(attempt.isCurrent()).toBe(true);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
    expect(attempt.isCurrent()).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
    let finished = true;
    await act(async () => { finished = api.current!.finish(attempt); });
    expect(finished).toBe(false);
  });

  it('a finished attempt closes the dialog and a new one can start', async () => {
    const { attempt } = await openDialog();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    let finished = false;
    await act(async () => { finished = api.current!.finish(attempt); });
    expect(finished).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    let next: UnsavedAttempt | null = null;
    await act(async () => { next = api.current!.ask(); });
    expect(next).not.toBeNull();
  });
});

describe('useUnsavedChangesDialog (N4)', () => {
  it('ignores a second request while an attempt is open (asking or saving) and still resolves the first', async () => {
    const { result } = renderHook(() => useUnsavedChangesDialog());
    let first: UnsavedAttempt | null = null;
    await act(async () => { first = result.current.ask(); });
    expect(first).not.toBeNull();
    let second: UnsavedAttempt | null | undefined;
    await act(async () => { second = result.current.ask(); });
    expect(second).toBeNull();
    await act(async () => { result.current.onSave(); });
    await expect(first!.choice).resolves.toBe('save');
    // still open (saving): a request now is ignored too
    await act(async () => { second = result.current.ask(); });
    expect(second).toBeNull();
    expect(result.current.isOpen).toBe(true);
    await act(async () => { result.current.finish(first!); });
    expect(result.current.isOpen).toBe(false);
    let third: UnsavedAttempt | null = null;
    await act(async () => { third = result.current.ask(); });
    expect(third).not.toBeNull();
    await act(async () => { result.current.onCancel(); });
    await expect((third as unknown as UnsavedAttempt).choice).resolves.toBe('cancel' as UnsavedChoice);
  });

  it('answers a pending question as cancel when the owner unmounts', async () => {
    const { result, unmount } = renderHook(() => useUnsavedChangesDialog());
    let pending: UnsavedAttempt | null = null;
    await act(async () => { pending = result.current.ask(); });
    unmount();
    await expect((pending as unknown as UnsavedAttempt).choice).resolves.toBe('cancel');
  });
});

describe('cancel notifies its owner so the main process can drop the attempt (blocker, advisor 44ee9298)', () => {
  it('cancel while saving reports the attempt id', async () => {
    const onCancelled = vi.fn();
    const { result } = renderHook(() => useUnsavedChangesDialog({ onCancelled }));
    let attempt: UnsavedAttempt | null = null;
    await act(async () => { attempt = result.current.ask(); });
    await act(async () => { result.current.onSave(); });
    expect(onCancelled).not.toHaveBeenCalled();
    await act(async () => { result.current.onCancel(); });
    expect(onCancelled).toHaveBeenCalledTimes(1);
    expect(onCancelled).toHaveBeenCalledWith((attempt as unknown as UnsavedAttempt).id);
    expect((attempt as unknown as UnsavedAttempt).isCurrent()).toBe(false);
  });

  it('cancel while asking reports it too; discard, finish and a cancel with nothing open do not', async () => {
    const onCancelled = vi.fn();
    const { result } = renderHook(() => useUnsavedChangesDialog({ onCancelled }));
    let a: UnsavedAttempt | null = null;
    await act(async () => { a = result.current.ask(); });
    await act(async () => { result.current.onCancel(); });
    expect(onCancelled).toHaveBeenCalledTimes(1);
    await act(async () => { result.current.onCancel(); }); // nothing open
    expect(onCancelled).toHaveBeenCalledTimes(1);

    await act(async () => { a = result.current.ask(); });
    await act(async () => { result.current.onDiscard(); });
    await act(async () => { a = result.current.ask(); });
    await act(async () => { result.current.onSave(); });
    await act(async () => { result.current.finish(a as unknown as UnsavedAttempt); });
    expect(onCancelled).toHaveBeenCalledTimes(1);
  });
});
