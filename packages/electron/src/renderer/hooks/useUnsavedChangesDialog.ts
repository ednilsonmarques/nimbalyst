import { useCallback, useEffect, useRef, useState } from 'react';

export type UnsavedChoice = 'save' | 'discard' | 'cancel';

/** One pass through the dialog: asking, then (if the user picks Save) saving. */
export interface UnsavedAttempt {
  id: string;
  /** Resolves with the user's decision. Save keeps the dialog open (it shows the saving state). */
  choice: Promise<UnsavedChoice>;
  /** False once the user cancelled (or anything newer replaced this attempt). */
  isCurrent(): boolean;
}

/**
 * State for the "unsaved changes" close dialog (NIB.97). Three explicit answers; dismissing the
 * dialog (Esc, overlay) is `cancel`, never `discard`.
 *
 * The dialog stays open for the whole attempt, including the save, so:
 *  - `ask()` returns `null` while an attempt is open (a second `confirm-close-unsaved` is ignored and
 *    can never open a second dialog or leave a promise nobody can resolve);
 *  - Cancel during the save invalidates the attempt: its late success is not reported as success.
 * A pending attempt is answered `cancel` if the owner unmounts.
 */
export function useUnsavedChangesDialog(options: { onCancelled?: (attemptId: string) => void } = {}) {
  // Called for every cancel of an open attempt (asking or saving), with that attempt's id, so the owner can
  // tell the main process: a cancel during the save is otherwise invisible to it.
  const onCancelledRef = useRef(options.onCancelled);
  onCancelledRef.current = options.onCancelled;
  const [phase, setPhase] = useState<'idle' | 'asking' | 'saving'>('idle');
  const phaseRef = useRef<'idle' | 'asking' | 'saving'>('idle');
  const currentIdRef = useRef<string | null>(null);
  const counterRef = useRef(0);
  const resolverRef = useRef<((choice: UnsavedChoice) => void) | null>(null);

  const setPhaseBoth = useCallback((next: 'idle' | 'asking' | 'saving') => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const ask = useCallback((): UnsavedAttempt | null => {
    if (phaseRef.current !== 'idle') return null;
    const id = `attempt-${Date.now()}-${++counterRef.current}`;
    currentIdRef.current = id;
    setPhaseBoth('asking');
    const choice = new Promise<UnsavedChoice>((resolve) => {
      resolverRef.current = resolve;
    });
    return { id, choice, isCurrent: () => currentIdRef.current === id };
  }, [setPhaseBoth]);

  const resolveChoice = useCallback((choice: UnsavedChoice) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    resolve?.(choice);
  }, []);

  const onSave = useCallback(() => {
    if (phaseRef.current !== 'asking') return;
    setPhaseBoth('saving'); // the dialog stays open and shows the saving state
    resolveChoice('save');
  }, [resolveChoice, setPhaseBoth]);

  const onDiscard = useCallback(() => {
    if (phaseRef.current !== 'asking') return;
    currentIdRef.current = null;
    setPhaseBoth('idle');
    resolveChoice('discard');
  }, [resolveChoice, setPhaseBoth]);

  const onCancel = useCallback(() => {
    if (phaseRef.current === 'idle') return;
    const cancelledId = currentIdRef.current;
    currentIdRef.current = null; // invalidates an attempt that is saving
    setPhaseBoth('idle');
    resolveChoice('cancel');
    if (cancelledId) onCancelledRef.current?.(cancelledId);
  }, [resolveChoice, setPhaseBoth]);

  /** The attempt is over (saved, or failed and reported). Closes the dialog only for the current attempt. */
  const finish = useCallback((attempt: UnsavedAttempt): boolean => {
    if (!attempt.isCurrent()) return false;
    currentIdRef.current = null;
    setPhaseBoth('idle');
    return true;
  }, [setPhaseBoth]);

  useEffect(() => () => {
    currentIdRef.current = null;
    phaseRef.current = 'idle';
    resolveChoice('cancel');
  }, [resolveChoice]);

  return {
    isOpen: phase !== 'idle',
    isSaving: phase === 'saving',
    ask,
    finish,
    onSave,
    onDiscard,
    onCancel,
  };
}
