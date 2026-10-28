/**
 * NewTeamMissionDialog - Centered modal that starts a Team mode MISSION (F1 S5).
 *
 * A mission is a Team mode root that works for a front (a `team-front` tracker
 * item) toward a goal. The user picks the front, writes the goal and, if they
 * want, how they will know it is done. The dialog only collects that and hands
 * the request to `onSubmit`; the main process validates the front, the limits
 * and the one-active-mission-per-front rule again and is the only one that
 * decides (a refusal comes back with a code and is shown here, never turned into
 * a success).
 *
 * - Fronts come from the tracker read the renderer already has
 *   (`document-service:tracker-items-by-type`). Paused, closed and status-less
 *   fronts are listed but cannot be selected; their status is visible.
 * - The text is sent exactly as typed. Nothing is cut: past the limit the field
 *   reports it and the button stays off.
 * - Opening the dialog, a tracker change and a refusal that means the list was
 *   stale all reload the fronts; the typed text and the dialog stay.
 * - It is modal for the keyboard too: focus goes inside when it opens and stays inside (Tab wraps,
 *   focus that lands outside is pulled back), the fronts are one radio group moved with the arrow
 *   keys, and focus returns to what had it before the dialog opened.
 * - One create per user action: a synchronous in-flight guard plus disabled
 *   controls. While it runs, ESC, the overlay and Cancel do nothing.
 */

import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';
import {
  TEAM_MISSION_DONE_CRITERION_MAX_CHARS,
  TEAM_MISSION_GOAL_MAX_CHARS,
  type TeamMissionRequestPayload,
} from '../../../shared/teamMission';
import type { TeamMissionCreateOutcome } from '../../store/actions/sessionHistoryActions';
import { subscribeTrackerItemsChanged } from '../../store/listeners/trackerItemsChangedListeners';
import {
  TEAM_MISSION_REFRESH_CODES,
  buildTeamMissionRequest,
  fieldUsage,
  teamFrontStatusLabelKey,
  teamMissionErrorKey,
  toTeamFrontOptions,
  type TeamFrontOption,
} from './teamMissionDialog';

interface NewTeamMissionDialogProps {
  isOpen: boolean;
  /** Starts the mission; resolves with what the main answered. The dialog closes only on `ok`. */
  onSubmit: (request: TeamMissionRequestPayload) => Promise<TeamMissionCreateOutcome>;
  /** Closes the dialog (cancel, ESC, overlay, and after a successful creation). */
  onClose: () => void;
}

type LoadState = 'loading' | 'ready' | 'error';

interface SubmitError {
  code?: string;
  message?: string;
}

async function fetchFronts(): Promise<TeamFrontOption[]> {
  if (!window.electronAPI) return [];
  const items = await window.electronAPI.invoke('document-service:tracker-items-by-type', 'team-front');
  return toTeamFrontOptions(items);
}

export function NewTeamMissionDialog({ isOpen, onSubmit, onClose }: NewTeamMissionDialogProps) {
  const { t } = useTranslation('agent');
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [fronts, setFronts] = useState<TeamFrontOption[]>([]);
  const [selectedFront, setSelectedFront] = useState<string>('');
  const [frontGone, setFrontGone] = useState(false);
  const [goal, setGoal] = useState('');
  const [doneCriterion, setDoneCriterion] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<SubmitError | null>(null);

  // Everything the previous session left behind is cleared in the render that opens the dialog
  // (state adjusted during render, not in an effect), so no frame ever shows a stale form.
  const [wasOpen, setWasOpen] = useState(false);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) {
      setLoadState('loading');
      setFronts([]);
      setSelectedFront('');
      setFrontGone(false);
      setGoal('');
      setDoneCriterion('');
      setIsSubmitting(false);
      setSubmitError(null);
    }
  }

  const dialogRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const initialFocusDoneRef = useRef(false);
  // Synchronous guard: state updates are batched, two fast clicks could both read `false`.
  const submittingRef = useRef(false);
  // Drops the answer of a load that a newer load (or closing) has made obsolete.
  const loadSeqRef = useRef(0);
  const selectedRef = useRef('');
  selectedRef.current = selectedFront;

  const loadFronts = useCallback(async (reason: 'open' | 'change' | 'refusal') => {
    const seq = ++loadSeqRef.current;
    if (reason === 'open') setLoadState('loading');
    try {
      const options = await fetchFronts();
      if (seq !== loadSeqRef.current) return;
      setFronts(options);
      setLoadState('ready');
      const current = selectedRef.current;
      if (current && !options.some((o) => o.id === current && o.selectable)) {
        setSelectedFront('');
        // After a refusal the error message already says it; a quiet change deserves the note.
        setFrontGone(reason === 'change');
      }
    } catch (error) {
      if (seq !== loadSeqRef.current) return;
      console.error('[NewTeamMissionDialog] Failed to load fronts:', error);
      // A failed refresh keeps the list the user already sees; only the first load has nothing to show.
      if (reason === 'open') setLoadState('error');
    }
  }, []);

  // Every time the dialog opens: re-arm the send guard and load the fronts (the form was cleared in render).
  useEffect(() => {
    if (!isOpen) {
      loadSeqRef.current += 1;
      return;
    }
    submittingRef.current = false;
    initialFocusDoneRef.current = false;
    void loadFronts('open');
    // A front paused, closed or renamed in the Tracker while the dialog is open.
    const unsubscribe = subscribeTrackerItemsChanged(() => {
      void loadFronts('change');
    });
    return () => {
      loadSeqRef.current += 1;
      unsubscribe();
    };
  }, [isOpen, loadFronts]);

  // Focus: inside the dialog as soon as it opens; back to what had it when it closes.
  useEffect(() => {
    if (!isOpen) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => {
      if (previous && previous.isConnected) previous.focus();
    };
  }, [isOpen]);

  // Once the fronts are there, focus the one to pick (the chosen one, or the first selectable) --
  // but only if the user has not already moved on to another control.
  useEffect(() => {
    if (!isOpen || loadState !== 'ready' || initialFocusDoneRef.current) return;
    initialFocusDoneRef.current = true;
    const dialog = dialogRef.current;
    const active = document.activeElement;
    if (!dialog || (active !== dialog && dialog.contains(active))) return;
    dialog.querySelector<HTMLElement>('[role="radio"][tabindex="0"]')?.focus();
  }, [isOpen, loadState, fronts]);

  // aria-modal: focus that lands outside the open dialog is pulled back in.
  useEffect(() => {
    if (!isOpen) return;
    const onFocusIn = (event: FocusEvent) => {
      const dialog = dialogRef.current;
      if (dialog && event.target instanceof Node && !dialog.contains(event.target)) dialog.focus();
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, [isOpen]);

  const handleCancel = useCallback(() => {
    if (submittingRef.current) return;
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        handleCancel();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [isOpen, handleCancel]);

  const goalUsage = useMemo(() => fieldUsage(goal, TEAM_MISSION_GOAL_MAX_CHARS), [goal]);
  const doneUsage = useMemo(() => fieldUsage(doneCriterion, TEAM_MISSION_DONE_CRITERION_MAX_CHARS), [doneCriterion]);
  const firstPickableId = fronts.find((f) => f.selectable)?.id;
  const hasSelectableFront = firstPickableId !== undefined;
  const canSubmit =
    !isSubmitting &&
    loadState === 'ready' &&
    Boolean(selectedFront) &&
    !goalUsage.blank &&
    !goalUsage.over &&
    !doneUsage.over;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    setIsSubmitting(true);
    setSubmitError(null);
    setFrontGone(false);
    let outcome: TeamMissionCreateOutcome;
    try {
      outcome = await onSubmit(buildTeamMissionRequest({ front: selectedFront, goal, doneCriterion }));
    } catch (error) {
      outcome = { ok: false, message: String(error) };
    }
    if (outcome.ok) {
      // The caller's onClose unmounts the form; the guard stays set so nothing can send twice.
      onClose();
      return;
    }
    submittingRef.current = false;
    setIsSubmitting(false);
    setSubmitError({ code: outcome.errorCode, message: outcome.message });
    // The button that had focus was disabled for the request and the browser dropped focus to the
    // page: bring it back into the dialog so the keyboard (Ctrl+Enter, Tab) keeps working.
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) dialog.focus();
    if (outcome.errorCode && (TEAM_MISSION_REFRESH_CODES as readonly string[]).includes(outcome.errorCode)) {
      void loadFronts('refusal');
    }
  }, [canSubmit, doneCriterion, goal, loadFronts, onClose, onSubmit, selectedFront]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSubmit) {
        e.preventDefault();
        void handleSubmit();
        return;
      }
      if (e.key !== 'Tab') return;
      // Tab wraps inside the dialog instead of leaving it.
      const dialog = dialogRef.current;
      if (!dialog) return;
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button, textarea')).filter(
        (el) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0,
      );
      if (controls.length === 0) {
        e.preventDefault();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === dialog)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [canSubmit, handleSubmit],
  );

  // The fronts are one radio group: the arrow keys move between the ones that can be picked (and
  // pick them, as radios do); disabled fronts are skipped.
  const handleGroupKeyDown = (e: React.KeyboardEvent) => {
    const forward = e.key === 'ArrowDown' || e.key === 'ArrowRight';
    const backward = e.key === 'ArrowUp' || e.key === 'ArrowLeft';
    if (!forward && !backward) return;
    const pickable = fronts.filter((f) => f.selectable);
    if (isSubmitting || pickable.length === 0) return;
    e.preventDefault();
    const from = (e.target as HTMLElement).closest<HTMLElement>('[role="radio"]')?.dataset.frontId;
    const index = pickable.findIndex((f) => f.id === from);
    // With no radio focused yet, forward starts at the first enabled front and backward at the last.
    const nextIndex = index === -1
      ? (forward ? 0 : pickable.length - 1)
      : (index + (forward ? 1 : -1) + pickable.length) % pickable.length;
    const next = pickable[nextIndex];
    setSelectedFront(next.id);
    setFrontGone(false);
    // Found among the rendered radios, not through a selector built from the id.
    Array.from(groupRef.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])
      .find((radio) => radio.dataset.frontId === next.id)
      ?.focus();
  };

  if (!isOpen) return null;

  return (
    <div
      className="team-mission-dialog-overlay nim-overlay backdrop-blur-sm bg-black/60"
      onClick={handleCancel}
      data-testid="team-mission-dialog-overlay"
    >
      <div
        className="team-mission-dialog nim-modal w-[92%] max-w-[560px] animate-[worktree-modal-appear_0.18s_ease] flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        data-testid="team-mission-dialog"
        data-component="NewTeamMissionDialog"
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t('teamMissionDialog.title')}
        aria-busy={isSubmitting}
      >
        <div className="px-6 pt-6 pb-4 border-b border-nim">
          <h2 className="m-0 text-[18px] font-semibold text-nim">{t('teamMissionDialog.title')}</h2>
          <p className="m-0 mt-1 text-[13px] text-nim-muted">{t('teamMissionDialog.subtitle')}</p>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-5">
          <div className="flex flex-col gap-1.5" data-testid="team-mission-front-field">
            <span className="text-[12px] font-semibold text-nim uppercase tracking-wider">
              {t('teamMissionDialog.frontLabel')}
            </span>

            {loadState === 'loading' && (
              <div className="px-3 py-3 text-[12px] text-nim-muted" data-testid="team-mission-fronts-loading">
                {t('teamMissionDialog.loadingFronts')}
              </div>
            )}

            {loadState === 'error' && (
              <div className="px-3 py-3 text-[12px] flex items-center gap-3" data-testid="team-mission-fronts-error">
                <span className="text-[var(--nim-error)]">{t('teamMissionDialog.loadFailed')}</span>
                <button
                  type="button"
                  className="nim-btn-secondary px-3 py-1 text-[12px] rounded-md"
                  data-testid="team-mission-fronts-retry"
                  onClick={() => void loadFronts('open')}
                >
                  {t('teamMissionDialog.retry')}
                </button>
              </div>
            )}

            {loadState === 'ready' && fronts.length === 0 && (
              <div className="px-3 py-3 text-[12px] flex items-center gap-3" data-testid="team-mission-no-fronts-row">
                <span className="text-nim-muted" data-testid="team-mission-no-fronts">
                  {t('teamMissionDialog.noFronts')}
                </span>
                <button
                  type="button"
                  className="nim-btn-secondary px-3 py-1 text-[12px] rounded-md shrink-0"
                  data-testid="team-mission-fronts-retry"
                  onClick={() => void loadFronts('open')}
                >
                  {t('teamMissionDialog.retry')}
                </button>
              </div>
            )}

            {loadState === 'ready' && fronts.length > 0 && (
              <>
                {!hasSelectableFront && (
                  <div className="px-1 text-[12px] text-nim-muted" data-testid="team-mission-no-active-front">
                    {t('teamMissionDialog.noActiveFront')}
                  </div>
                )}
                <div
                  className="flex flex-col gap-0.5 max-h-[30vh] overflow-y-auto rounded-md border border-nim bg-nim-secondary p-1.5"
                  role="radiogroup"
                  aria-label={t('teamMissionDialog.frontLabel')}
                  ref={groupRef}
                  onKeyDown={handleGroupKeyDown}
                >
                  {fronts.map((front) => {
                    const isSelected = front.id === selectedFront;
                    const isDisabled = !front.selectable || isSubmitting;
                    // Roving tab stop: the chosen front, or the first pickable one while none is chosen.
                    const isTabStop = front.selectable && (selectedFront ? isSelected : front.id === firstPickableId);
                    return (
                      <button
                        key={front.id}
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
                        aria-disabled={isDisabled}
                        disabled={isDisabled}
                        tabIndex={isTabStop ? 0 : -1}
                        data-front-id={front.id}
                        title={front.selectable ? undefined : t('teamMissionDialog.onlyActiveHint')}
                        className={`flex items-center w-full px-2 py-1.5 text-left text-[13px] border-none gap-2 rounded-sm disabled:cursor-not-allowed ${
                          front.selectable ? 'cursor-pointer text-nim hover:bg-nim-hover' : 'opacity-50 text-nim-muted'
                        } ${isSelected ? 'bg-[var(--nim-primary)]/15' : 'bg-transparent'}`}
                        data-testid={`team-mission-front-${front.id}`}
                        data-status={front.status}
                        onClick={() => {
                          setSelectedFront(front.id);
                          setFrontGone(false);
                        }}
                      >
                        <span className="flex-1 truncate">{front.title}</span>
                        <span
                          className="text-[11px] text-nim-muted"
                          data-testid={`team-mission-front-status-${front.id}`}
                        >
                          {t(teamFrontStatusLabelKey(front.status))}
                        </span>
                        {isSelected && (
                          <span className="text-[14px] leading-none text-nim-primary" aria-hidden="true">●</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {frontGone && (
              <div className="px-1 text-[12px] text-[var(--nim-warning,var(--nim-error))]" data-testid="team-mission-front-gone" role="status">
                {t('teamMissionDialog.selectedFrontGone')}
              </div>
            )}
          </div>

          <TextField
            id="team-mission-goal"
            testId="team-mission-goal"
            label={t('teamMissionDialog.goalLabel')}
            placeholder={t('teamMissionDialog.goalPlaceholder')}
            value={goal}
            onChange={setGoal}
            max={TEAM_MISSION_GOAL_MAX_CHARS}
            usage={goalUsage}
            requiredNote={goalUsage.blank ? t('teamMissionDialog.goalRequired') : null}
            disabled={isSubmitting}
          />

          <TextField
            id="team-mission-done"
            testId="team-mission-done"
            label={t('teamMissionDialog.doneLabel')}
            placeholder={t('teamMissionDialog.donePlaceholder')}
            value={doneCriterion}
            onChange={setDoneCriterion}
            max={TEAM_MISSION_DONE_CRITERION_MAX_CHARS}
            usage={doneUsage}
            requiredNote={null}
            disabled={isSubmitting}
          />

          {submitError && (
            <div
              className="text-[12px] text-[var(--nim-error)] px-3 py-2 rounded-md border border-[var(--nim-error)] bg-[var(--nim-error)]/10 flex flex-col gap-1"
              data-testid="team-mission-submit-error"
              data-error-code={submitError.code ?? ''}
              role="alert"
            >
              <span data-testid="team-mission-error-message">{t(teamMissionErrorKey(submitError.code))}</span>
              {submitError.message && (
                <span className="text-nim-muted break-words" data-testid="team-mission-error-details">
                  {t('teamMissionDialog.detailsLine', { message: submitError.message })}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 px-6 py-4 border-t border-nim">
          <button
            type="button"
            className="nim-btn-secondary px-4 py-2 text-[13px] font-medium rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="team-mission-cancel"
            onClick={handleCancel}
            disabled={isSubmitting}
          >
            {t('teamMissionDialog.cancel')}
          </button>
          <button
            type="button"
            className="nim-btn-primary px-5 py-2 text-[13px] font-semibold rounded-lg disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
            data-testid="team-mission-create"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
          >
            {isSubmitting && (
              <span
                className="inline-block w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin"
                aria-hidden="true"
                data-testid="team-mission-spinner"
              />
            )}
            {isSubmitting ? t('teamMissionDialog.creating') : t('teamMissionDialog.create')}
          </button>
        </div>
      </div>
    </div>
  );
}

interface TextFieldProps {
  id: string;
  testId: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  max: number;
  usage: { used: number; over: boolean };
  requiredNote: string | null;
  disabled: boolean;
}

/** A multi-line field with a live counter. No `maxLength`: the text is never cut, only reported. */
function TextField({ id, testId, label, placeholder, value, onChange, max, usage, requiredNote, disabled }: TextFieldProps) {
  const { t } = useTranslation('agent');
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[12px] font-semibold text-nim uppercase tracking-wider">
        {label}
      </label>
      <textarea
        id={id}
        rows={3}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck
        className="px-3 py-2 text-[13px] rounded-md border border-nim bg-nim-secondary text-nim focus:outline-none focus:border-nim-primary disabled:opacity-50 disabled:cursor-not-allowed resize-y"
        data-testid={testId}
        aria-invalid={usage.over}
        aria-describedby={`${id}-meta`}
      />
      <div id={`${id}-meta`} className="flex items-center justify-between gap-2 text-[11px]">
        <span className={usage.over ? 'text-[var(--nim-error)]' : 'text-nim-muted'} data-testid={`${testId}-error`}>
          {usage.over
            ? t('teamMissionDialog.tooLong', { used: usage.used, max })
            : requiredNote}
        </span>
        <span
          className={usage.over ? 'text-[var(--nim-error)]' : 'text-nim-muted'}
          data-testid={`${testId}-counter`}
        >
          {t('teamMissionDialog.counter', { used: usage.used, max })}
        </span>
      </div>
    </div>
  );
}
