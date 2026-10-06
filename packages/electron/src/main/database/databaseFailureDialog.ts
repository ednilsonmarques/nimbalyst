/**
 * Wording for the dialog shown when the database will not start.
 *
 * Pure and separate from `index.ts` for one reason: this text is safety-
 * critical and must be assertable. The previous version ended with
 *
 *     3. If the problem persists, delete the database folder:
 *        <path>
 *
 * Users followed it. Because the project list lives in electron-store rather
 * than in the database, the app then came back up looking healthy with every
 * session and all document history gone, so the instruction did not even look
 * like it had done damage (#1347).
 *
 * The invariant the tests hold: this dialog never tells anyone to delete their
 * data, and it only promises recoverable data when some actually exists.
 */

import * as os from 'os';
import { t } from '@nimbalyst/runtime/i18n';
import { buildDatabaseInitializationErrorProperties } from './DatabaseErrorTelemetry';
import type { CutoverJournal } from './sqlite/cutoverJournal';
import type { RestorableBackup } from './sqlite/recoveryArtifacts';
import { formatBytes } from './sqlite/recoveryArtifacts';

/**
 * Button labels in the current UI language. Resolved when the dialog is built
 * and again in `actionForChoice`, which dispatches on the label the user read.
 * `rollback` is the one destructive choice here: it discards everything saved
 * since the switch.
 */
function buttonLabels() {
  return {
    retry: t('dialogs:databaseFailure.buttons.retryStartup'),
    restore: t('dialogs:databaseFailure.buttons.restoreBackup'),
    reveal: t('dialogs:databaseFailure.buttons.showBackups'),
    rollback: t('dialogs:databaseFailure.buttons.restorePreMigration'),
    diagnostics: t('dialogs:databaseFailure.buttons.copyDiagnostics'),
    quit: t('dialogs:databaseFailure.buttons.quit'),
  };
}

/**
 * Replace the two paths that carry the account name with placeholders.
 *
 * `buildDatabaseFailureDiagnostics` keeps paths out of the copied text by
 * only ever emitting bounded codes, so there was nothing to reuse: the raw
 * engine error still went on screen verbatim, and a database init failure
 * names the database path. Users photograph this dialog for support.
 */
export function redactAccountPaths(text: string, userDataPath?: string): string {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let redacted = text;
  // Longest first: the userData path normally sits under the home directory.
  for (const [value, placeholder] of [
    [userDataPath, '<app data>'],
    [os.homedir(), '<home>'],
  ] as const) {
    if (value) redacted = redacted.replace(new RegExp(escape(value), 'g'), placeholder);
  }
  return redacted;
}

export interface DatabaseFailureDialogContent {
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  /**
   * Backup to reveal if the user picks Show Backups, or `null` when there is
   * nothing to show and the only button is Quit.
   */
  revealPath: string | null;
  /**
   * The copies the primary Restore button may act on, richest first, and empty
   * when there is nothing to restore from.
   *
   * A list rather than a single entry because this used to be `backups[0]` in
   * slot order. If `current` was a small valid copy of nothing and `previous`
   * held the user's history, Restore picked the unusable one, failed, and quit
   * — and picked the same one on every launch afterwards, forever. The backup
   * services already fall through to the next copy on a pre-swap failure; the
   * dialog is the surface where not doing so is permanent.
   *
   * Restoring goes through the recovery transaction, which verifies the copy
   * and keeps the displaced database — see
   * `database/recovery/recoveryTransaction.ts`.
   */
  restoreCandidates: RestorableBackup[];
  rollbackSource?: RestorableBackup;
  diagnostics?: string;
  retryStartup?: boolean;
}

export function buildDatabaseFailureDialog(
  backups: RestorableBackup[],
  options: {
    rollbackSource?: RestorableBackup;
    diagnostics?: string;
    reason?: string;
    retryStartup?: boolean;
    /** Redacted out of `reason`, along with the home directory. */
    userDataPath?: string;
  } = {},
): DatabaseFailureDialogContent {
  const hasBackups = backups.length > 0;
  const labels = buttonLabels();

  const recovery = hasBackups
    ? t('dialogs:databaseFailure.recoveryWithBackups', {
        backups: backups.map((b) => `   - ${b.name} (${formatBytes(b.bytes)})`).join('\n'),
      }) + '\n\n'
    : t('dialogs:databaseFailure.recoveryNoBackups') + '\n\n';

  const steps = hasBackups
    ? t('dialogs:databaseFailure.stepsWithBackups') + '\n\n'
    : t('dialogs:databaseFailure.stepsNoBackups') + '\n\n';

  // Cheapest and least destructive first. Rolling back to the pre-migration
  // store comes after both, because it is the only choice here that leaves
  // the user without work they have already done.
  const actions = [
    ...(options.retryStartup ? [labels.retry] : []),
    ...(hasBackups ? [labels.restore, labels.reveal] : []),
    ...(options.rollbackSource ? [labels.rollback] : []),
    ...(options.diagnostics ? [labels.diagnostics] : []),
  ];
  // Index 0 is the slot the platform paints as primary, so the rollback may
  // not hold it even when it is the only action on offer -- Quit takes the
  // first slot in that case rather than the last.
  const buttons = actions[0] === labels.rollback ? [labels.quit, ...actions] : [...actions, labels.quit];

  return {
    title: t('dialogs:databaseFailure.title'),
    message: t('dialogs:databaseFailure.message'),
    detail: (options.reason ? `${redactAccountPaths(options.reason, options.userDataPath)}\n\n` : '') + recovery +
      (options.rollbackSource
        ? t('dialogs:databaseFailure.rollbackDetail', { name: options.rollbackSource.name }) + '\n\n'
        : '') +
      steps + t('dialogs:databaseFailure.quitNotice'),
    buttons,
    // Retry first -- a transient failure costs nothing to re-run. Then the
    // rolling backup, which the recovery transaction verifies and which keeps
    // the displaced database. Never the rollback, and never a bare Quit while
    // something recoverable is on offer (#1347).
    defaultId: options.retryStartup
      ? buttons.indexOf(labels.retry)
      : hasBackups
        ? buttons.indexOf(labels.restore)
        : buttons.findIndex((button) => button !== labels.rollback),
    // Escape lands on Quit, never on an action that touches the database.
    cancelId: buttons.indexOf(labels.quit),
    // `findRestorableBackups` returns richest-first, so this is the copy the
    // Restore button starts with and the one Show Backups reveals.
    revealPath: hasBackups ? backups[0].path : null,
    restoreCandidates: backups,
    rollbackSource: options.rollbackSource,
    diagnostics: options.diagnostics,
    retryStartup: options.retryStartup,
  };
}

export type DatabaseFailureDialogAction = 'restore' | 'rollback' | 'diagnostics' | 'retry' | 'reveal' | 'quit';

/**
 * What the button index the user picked actually means. Kept next to the
 * button list so adding a button cannot silently re-point the caller's
 * `choice === 0` at a different action — which is exactly the sort of
 * off-by-one that turns "Show Backups" into something destructive.
 */
export function actionForChoice(
  content: DatabaseFailureDialogContent,
  choice: number,
): DatabaseFailureDialogAction {
  const labels = buttonLabels();
  switch (content.buttons[choice]) {
    case labels.rollback:
      return 'rollback';
    case labels.retry:
      return 'retry';
    case labels.diagnostics:
      return 'diagnostics';
    case labels.restore:
      return 'restore';
    case labels.reveal:
      return 'reveal';
    default:
      return 'quit';
  }
}

export interface DatabaseFailureRestoreResult {
  ok: boolean;
  /** Shown to the user on failure. Never sent to analytics. */
  message?: string;
  /**
   * Whether the next copy may be tried. False once the attempt has left
   * recovery state that startup has to resolve first — see
   * `mayTryAnotherCandidate`. Defaults to true, because the failures that
   * cannot be followed by another attempt are the ones a caller has to opt
   * into reporting; a caller that says nothing has not moved anything.
   */
  canTryAnother?: boolean;
}

export interface DatabaseFailureDialogHandlers {
  restore(candidate: RestorableBackup): Promise<DatabaseFailureRestoreResult>;
  rollback?(candidate: RestorableBackup): Promise<DatabaseFailureRestoreResult>;
  copyDiagnostics?(text: string): void;
  retryStartup?(): void;
  reveal(revealPath: string): void;
  /** Called with the text to put in front of the user when a restore fails. */
  onRestoreFailed?(message: string): void;
}

export interface DatabaseFailureChoiceOutcome {
  action: DatabaseFailureDialogAction;
  /** Bounded analytics value; one of a fixed set. */
  reportedAction: 'restore_succeeded' | 'restore_failed' | 'show_backups' | 'copy_diagnostics' | 'retry_startup' | 'quit';
  /** True when the app should relaunch onto the restored database. */
  restored: boolean;
}

/**
 * Carry out whatever the user picked.
 *
 * This lives here rather than inline in `index.ts` because the branch it
 * replaces was the bug: `index.ts` kept reading `content.revealPath !== null &&
 * choice === 0` after the button list grew a Restore entry at index 0, so the
 * primary action of the dialog performed a reveal and quit. `actionForChoice`
 * existed and was tested and had no production caller. Putting the decision and
 * its consequences in one testable function is what stops that recurring: a
 * test here fails if Restore stops restoring, whereas a test of the button
 * labels alone passed happily throughout.
 */
export async function applyDatabaseFailureChoice(
  content: DatabaseFailureDialogContent,
  choice: number,
  handlers: DatabaseFailureDialogHandlers,
): Promise<DatabaseFailureChoiceOutcome> {
  const action = actionForChoice(content, choice);

  if (action === 'retry' && content.retryStartup && handlers.retryStartup) {
    handlers.retryStartup();
    return { action, reportedAction: 'retry_startup', restored: true };
  }

  if (action === 'rollback' && content.rollbackSource && handlers.rollback) {
    let result: DatabaseFailureRestoreResult;
    try { result = await handlers.rollback(content.rollbackSource); } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    if (!result.ok) handlers.onRestoreFailed?.(result.message ?? t('dialogs:databaseFailure.rollbackIncomplete'));
    return { action, reportedAction: result.ok ? 'restore_succeeded' : 'restore_failed', restored: result.ok };
  }
  if (action === 'diagnostics' && content.diagnostics) {
    handlers.copyDiagnostics?.(content.diagnostics);
    return { action, reportedAction: 'copy_diagnostics', restored: false };
  }

  if (action === 'restore' && content.restoreCandidates.length > 0) {
    const failures: string[] = [];
    for (const candidate of content.restoreCandidates) {
      let result: DatabaseFailureRestoreResult;
      try {
        result = await handlers.restore(candidate);
      } catch (err) {
        result = { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
      if (result.ok) return { action, reportedAction: 'restore_succeeded', restored: true };
      failures.push(`${candidate.name}: ${result.message ?? t('dialogs:databaseFailure.restoreIncomplete')}`);
      // Same rule as the backup sweeps: once an attempt has moved something,
      // trying the next copy would write over the record of where it went.
      if (result.canTryAnother === false) break;
    }
    handlers.onRestoreFailed?.(
      t('dialogs:databaseFailure.restoreFailedSummary', { failures: failures.join('\n') }),
    );
    return { action, reportedAction: 'restore_failed', restored: false };
  }

  if (action === 'reveal' && content.revealPath !== null) {
    handlers.reveal(content.revealPath);
    return { action, reportedAction: 'show_backups', restored: false };
  }

  return { action: 'quit', reportedAction: 'quit', restored: false };
}


/** Shareable diagnosis: bounded codes and lifecycle state, never paths or row IDs. */
export function buildDatabaseFailureDiagnostics(args: {
  version: string;
  backend: 'sqlite' | 'pglite';
  error: unknown;
  cutover?: CutoverJournal;
}): string {
  return JSON.stringify({
    version: args.version,
    ...buildDatabaseInitializationErrorProperties(args.error, args.backend),
    cutover: args.cutover ? { operation: args.cutover.operation, phase: args.cutover.phase, reconcileAttempts: args.cutover.reconcileAttempts } : null,
  }, null, 2);
}
