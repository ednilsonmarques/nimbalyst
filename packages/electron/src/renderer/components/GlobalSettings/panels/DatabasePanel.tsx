/**
 * DatabasePanel
 *
 * Settings → Database. Shows the current storage backend, lets users dry-run
 * and run the PGLite → SQLite migration by hand, and surfaces everything the
 * database layer is holding on their behalf: databases set aside by an earlier
 * failure, PGLite copies a migration preserved, and any durable refusal to
 * migrate automatically.
 *
 * Automatic migration is off in this build. Nothing on this panel moves data
 * unless the user starts it here.
 *
 * IPC contract (see main/ipc/MigrationHandlers.ts and main/ipc/RecoveryHandlers.ts):
 *   - db:migration:get-status   -> { activeBackend, pgliteDirExists, sqliteDirExists, migratedDirs, migrationBlocked, runningDryRun }
 *   - db:migration:dry-run      -> { success, result: DryRunResult } | { success: false, error }
 *   - db:migration:start        -> runs the migration
 *   - db:migration:rollback     -> restores pglite-db/ from a preserved sibling
 *   - db:migration:clear-block  -> clears a durable refusal
 *   - db:migration:progress/phase/complete/failed (events) -> live updates
 *   - db:recovery:*             -> set-aside databases and preserved copies
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAtom } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { useTranslation, Trans } from '@nimbalyst/runtime/i18n/react';
import {
  dbMigrationOperationAtom,
  dbMigrationFailureAtom,
  dbMigrationPhaseAtom,
  dbMigrationProgressAtom,
  dbMigrationRunningAtom,
  dbMigrationSummaryAtom,
  type MigrationFailure,
  type MigrationPhaseEvent as PhaseEvent,
  type MigrationProgressEvent as ProgressEvent,
  type MigrationSummary,
} from '../../../store/atoms/dbMigration';
import type { MigrationOperationSnapshot } from '../../../../shared/migrationOperation';
import { hydrateMigrationOperation, refreshDbRecoveryState } from '../../../store/listeners/dbMigrationListeners';
import { requestConfirmation } from '../../../dialogs/requestConfirmation';
import { errorNotificationService } from '../../../services/ErrorNotificationService';
import { HistoryMigrationWarning, Stat, DryRunResultCard, DryRunProgress, AdoptDryRunSection, type DryRunResult } from './database/MigrationProgressViews';
import { formatBytes, formatDuration } from './database/dbFormat';
import { RecoverySection } from './database/RecoverySection';
import {
  MigratedCopiesSection,
  MigrationBlockedSection,
} from './database/MigrationStateSections';

type Backend = 'pglite' | 'sqlite';

interface MigrationStatus {
  operation?: MigrationOperationSnapshot | null;
  dryRunAvailable?: { completedAt: string; totalRows: number; historyRowsQuarantined?: number } | null;
  activeBackend: Backend;
  historyRowsQuarantined?: number;
  pgliteDirExists: boolean;
  sqliteDirExists: boolean;
  migratedDirs: string[];
  running: boolean;
  runningDryRun: boolean;
}


interface PreflightResult {
  ok: boolean;
  reason?: string;
  pgliteDirBytes: number;
  freeBytes: number;
  requiredBytes: number;
}

export function DatabasePanel(): React.ReactElement {
  const { t } = useTranslation('settings');
  const [operation] = useAtom(dbMigrationOperationAtom);
  const [status, setStatus] = useState<MigrationStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [dryRunResult, setDryRunResult] = useState<DryRunResult | null>(null);
  const [dryRunError, setDryRunError] = useState<string | null>(null);
  const [dryRunRunning, setDryRunRunning] = useState(false);
  // Migration progress lives in atoms fed by dbMigrationListeners, so it
  // survives the settings dialog being closed mid-run.
  const [phase, setPhase] = useAtom(dbMigrationPhaseAtom);
  const [progress, setProgress] = useAtom(dbMigrationProgressAtom);
  const [showMigrationModal, setShowMigrationModal] = useState(false);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [migrationRunning, setMigrationRunning] = useAtom(dbMigrationRunningAtom);
  const [migrationSummary, setMigrationSummary] = useAtom(dbMigrationSummaryAtom);
  const [migrationFailure, setMigrationFailure] = useAtom(dbMigrationFailureAtom);
  const [dryRunAvailable, setDryRunAvailable] = useState<{
    completedAt: string;
    totalRows: number;
    historyRowsQuarantined?: number;
  } | null>(null);
  const [adoptRunning, setAdoptRunning] = useState(false);
  const [adoptError, setAdoptError] = useState<string | null>(null);
  const [adoptResult, setAdoptResult] = useState<{
    historyRowsQuarantined?: number;
    rowsAdded: number;
    durationMs: number;
  } | null>(null);

  useEffect(() => {
    if (!operation) return;
    const running = operation.status === 'running' || operation.status === 'cancelling';
    const response = operation.response as { success: boolean; result?: DryRunResult & { rowsAdded: number; durationMs: number; historyRowsQuarantined?: number }; error?: string; summary?: MigrationSummary } | undefined;
    setDryRunRunning(operation.kind === 'dry-run' && running);
    setAdoptRunning(operation.kind === 'adoption' && running);
    setMigrationRunning(operation.kind === 'migration' && running);
    if (operation.kind === 'dry-run') {
      setDryRunError(response && !response.success ? response.error ?? null : null);
      if (response?.success && response.result) {
        setDryRunResult(response.result);
        setDryRunAvailable({ completedAt: new Date().toISOString(), totalRows: response.result.summary.totalRowsCopied, historyRowsQuarantined: response.result.summary.historyRowsQuarantined });
      }
    }
    if (operation.kind === 'adoption') {
      if (running) setDryRunAvailable(previous => previous ?? { completedAt: new Date().toISOString(), totalRows: 0 });
      setAdoptError(response && !response.success ? response.error ?? null : null);
      if (response?.success && response.result) setAdoptResult(response.result);
    }
    if (operation.kind === 'migration' && response?.success && response.summary) setMigrationSummary(response.summary);
  }, [operation, setMigrationRunning, setMigrationSummary]);

  const loadStatus = useCallback(async () => {
    if (!window.electronAPI) return;
    try {
      const resp = (await window.electronAPI.invoke('db:migration:get-status')) as
        | (MigrationStatus & { success: true })
        | { success: false; error: string };
      if (!resp.success) {
        setStatusError(resp.error);
        return;
      }
      if (hydrateMigrationOperation(resp.operation)) setDryRunAvailable(resp.dryRunAvailable ?? null);
      setStatusError(null);
      setStatus({
        activeBackend: resp.activeBackend,
        historyRowsQuarantined: resp.historyRowsQuarantined,
        pgliteDirExists: resp.pgliteDirExists,
        sqliteDirExists: resp.sqliteDirExists,
        migratedDirs: resp.migratedDirs,
        running: resp.running,
        runningDryRun: resp.runningDryRun,
      });
    } catch (err) {
      setStatusError(String((err as Error).message ?? err));
    }

    // Set-aside databases, preserved copies, and any durable refusal. Lives in
    // atoms so the sections below stay in step with the startup pull.
    await refreshDbRecoveryState();
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const startDryRun = useCallback(async () => {
    if (
      !window.electronAPI
      || dryRunRunning
      || status?.activeBackend !== 'pglite'
    ) return;
    setDryRunRunning(true);
    setDryRunError(null);
    setDryRunResult(null);
    setPhase(null);
    setProgress(null);
    try {
      const resp = (await window.electronAPI.invoke('db:migration:dry-run')) as
        | { success: true; result: DryRunResult }
        | { success: false; error: string };
      if (!resp.success) {
        setDryRunError(resp.error);
      } else {
        setDryRunResult(resp.result);
      }
    } catch (err) {
      setDryRunError(String((err as Error).message ?? err));
    } finally {
      setDryRunRunning(false);
      void loadStatus();
    }
  }, [dryRunRunning, loadStatus, status?.activeBackend]);

  const adoptDryRun = useCallback(async () => {
    if (!window.electronAPI || adoptRunning) return;
    const ageHrs = dryRunAvailable
      ? (Date.now() - new Date(dryRunAvailable.completedAt).getTime()) / 3_600_000
      : 0;
    const ageBlurb = ageHrs < 1
      ? t('database.adoptConfirm.lessThanAnHour')
      : t('database.adoptConfirm.aboutHours', { count: Math.round(ageHrs) });
    const ok = await requestConfirmation({
      title: t('database.adoptConfirm.title'),
      message: t('database.adoptConfirm.message', { age: ageBlurb }),
      confirmLabel: t('database.adoptConfirm.confirmLabel'),
    });
    if (!ok) return;
    setAdoptRunning(true);
    setAdoptError(null);
    setAdoptResult(null);
    setPhase(null);
    setProgress(null);
    try {
      const resp = (await window.electronAPI.invoke('db:migration:adopt-dry-run')) as
        | { success: true; result: { rowsAdded: number; durationMs: number; historyRowsQuarantined?: number } }
        | { success: false; error: string };
      if (!resp.success) {
        setAdoptError(resp.error);
      } else {
        setAdoptResult({
          historyRowsQuarantined: resp.result.historyRowsQuarantined,
          rowsAdded: resp.result.rowsAdded,
          durationMs: resp.result.durationMs,
        });
        setDryRunAvailable(null);
        setDryRunResult(null);
      }
    } catch (err) {
      setAdoptError(String((err as Error).message ?? err));
    } finally {
      setAdoptRunning(false);
      void loadStatus();
    }
  }, [adoptRunning, dryRunAvailable, loadStatus, t]);

  const rollback = useCallback(async () => {
    if (!window.electronAPI) return;
    const ok = await requestConfirmation({
      title: t('database.rollbackConfirm.title'),
      message: t('database.rollbackConfirm.message'),
      confirmLabel: t('database.rollbackConfirm.confirmLabel'),
      destructive: true,
    });
    if (!ok) return;
    const resp = (await window.electronAPI.invoke('db:migration:rollback')) as
      | { success: true; restoredFrom: string }
      | { success: false; error: string };
    if (!resp.success) {
      errorNotificationService.showError(t('database.rollbackConfirm.failedTitle'), t('database.rollbackConfirm.failedMessage', { error: resp.error }));
    } else {
      errorNotificationService.showInfo(
        t('database.rollbackConfirm.restoredTitle'),
        t('database.rollbackConfirm.restoredMessage', { restoredFrom: resp.restoredFrom }),
        { duration: 0 },
      );
    }
    void loadStatus();
  }, [loadStatus, t]);

  const openMigrationModal = useCallback(async () => {
    if (!window.electronAPI) return;
    setShowMigrationModal(true);
    setPreflight(null);
    setPreflightError(null);
    setMigrationFailure(null);
    setMigrationSummary(null);
    setPhase(null);
    setProgress(null);
    try {
      const resp = (await window.electronAPI.invoke('db:migration:preflight')) as
        | ({ success: true } & PreflightResult)
        | { success: false; error: string };
      if (!resp.success) {
        setPreflightError(resp.error);
        return;
      }
      setPreflight(resp);
    } catch (err) {
      setPreflightError(String((err as Error).message ?? err));
    }
  }, []);

  const startMigration = useCallback(async () => {
    if (!window.electronAPI || migrationRunning || !preflight?.ok) return;
    setMigrationRunning(true);
    setMigrationFailure(null);
    setMigrationSummary(null);
    try {
      const resp = (await window.electronAPI.invoke('db:migration:start')) as
        | { success: true; summary: MigrationSummary }
        | { success: false; error: string };
      if (!resp.success) {
        setMigrationRunning(false);
        setMigrationFailure({ phase: phase?.phase ?? 'start', message: resp.error });
      } else {
        setMigrationSummary(resp.summary);
        setMigrationRunning(false);
        void loadStatus();
      }
    } catch (err) {
      setMigrationRunning(false);
      setMigrationFailure({
        phase: phase?.phase ?? 'start',
        message: String((err as Error).message ?? err),
      });
    }
  }, [loadStatus, migrationRunning, phase?.phase, preflight?.ok]);

  const copyDiagnosticInfo = useCallback(async () => {
    const diagnostic = JSON.stringify({
      preflight,
      phase,
      progress,
      failure: migrationFailure,
    }, null, 2);
    await navigator.clipboard.writeText(diagnostic);
  }, [migrationFailure, phase, preflight, progress]);

  const backendLabel = useMemo(() => {
    if (!status) return t('common:loading');
    return status.activeBackend === 'pglite' ? t('database.backend.pgliteCurrent') : t('database.backend.sqliteNew');
  }, [status, t]);

  return (
    <div className="provider-panel flex flex-col">
      {operation?.status === 'awaiting-restart' && (
        <div role="status" className="p-3 mb-4 border rounded-md">
          {t('database.restartRequired')}
          <button type="button" className="setting-button ml-2" onClick={() => { void window.electronAPI?.invoke('db:migration:restart'); }}>{t('database.restartButton')}</button>
        </div>
      )}
      <div className="provider-panel-header mb-6 pb-4 border-b border-[var(--nim-border)]">
        <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-2 text-[var(--nim-text)]">
          {t('database.title')}
        </h3>
        <p className="provider-panel-description text-sm leading-relaxed text-[var(--nim-text-muted)]">
          {t('database.description')}
        </p>
      </div>

      {/* Current backend section ----------------------------------------- */}
      <div className="provider-panel-section mb-6">
        <h4 className="provider-panel-section-title text-base font-semibold mb-2 text-[var(--nim-text)]">
          {t('database.backend.title')}
        </h4>
        {statusError ? (
          <div className="p-3 rounded-md bg-[rgba(220,38,38,0.1)] border border-[rgba(220,38,38,0.3)] text-sm text-[var(--nim-text)]">
            {t('database.backend.statusError', { error: statusError })}
          </div>
        ) : (
          <div className="setting-item py-2 flex items-center justify-between gap-4 nim-database-status">
            <div className="flex flex-col gap-0 min-w-0">
              <span className="setting-name text-sm font-medium text-[var(--nim-text)]">
                {backendLabel}
              </span>
              <span className="setting-description text-xs leading-snug text-[var(--nim-text-muted)]">
                {status?.pgliteDirExists && status?.sqliteDirExists
                  ? t('database.backend.bothDirs')
                  : status?.pgliteDirExists
                    ? t('database.backend.pgliteDirOnly')
                    : status?.sqliteDirExists
                      ? t('database.backend.sqliteDirOnly')
                      : t('database.backend.noDirs')}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Recovery and preserved copies ----------------------------------- */}
      <RecoverySection onRefresh={() => { void loadStatus(); }} />
      <MigrationBlockedSection onCleared={() => { void loadStatus(); }} />

      {/* Dry run section ------------------------------------------------- */}
      {status?.activeBackend === 'pglite' && (
        <div className="provider-panel-section mb-6">
          <h4 className="provider-panel-section-title text-base font-semibold mb-2 text-[var(--nim-text)]">
            {t('database.dryRun.title')}
          </h4>
          <p className="provider-panel-hint text-sm text-[var(--nim-text-muted)] mb-3">
            {t('database.dryRun.description')}
          </p>

          <button
            type="button"
            onClick={startDryRun}
            disabled={dryRunRunning || adoptRunning || migrationRunning || operation?.status === 'awaiting-restart'}
            className="nim-database-dry-run-button setting-button inline-flex items-center gap-2 py-1.5 px-3 rounded-md text-sm font-medium bg-[var(--nim-primary)] text-white border-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[var(--nim-primary-hover)]"
          >
            <MaterialSymbol icon={dryRunRunning ? 'sync' : 'play_arrow'} size={16} />
            {dryRunRunning ? t('database.dryRun.running') : t('database.dryRun.run')}
          </button>

          {dryRunRunning && operation?.kind === 'dry-run' && (
            <button type="button" className="setting-button ml-2" disabled={operation.status === 'cancelling'}
              onClick={() => { void window.electronAPI?.invoke('db:migration:cancel-dry-run', operation.id); }}>
              {operation.status === 'cancelling' ? t('database.dryRun.cancelling') : t('database.dryRun.cancel')}
            </button>
          )}

          {(dryRunRunning && (phase || progress)) && (
            <DryRunProgress phase={phase} progress={progress} />
          )}

          {dryRunError && (
            <div className="mt-3 p-3 rounded-md bg-[rgba(220,38,38,0.1)] border border-[rgba(220,38,38,0.3)] text-sm text-[var(--nim-text)] nim-database-dry-run-error">
              {operation?.status === 'cancelled' ? t('database.dryRun.cancelledError', { error: dryRunError }) : t('database.dryRun.failedError', { error: dryRunError })}
            </div>
          )}

          {dryRunResult && (
            <div className="mt-3 nim-database-dry-run-result">
              <DryRunResultCard result={dryRunResult} />
            </div>
          )}

          {dryRunAvailable && (
            <AdoptDryRunSection
              available={dryRunAvailable}
              running={adoptRunning}
              phase={phase}
              progress={progress}
              error={adoptError}
              result={adoptResult}
              onAdopt={() => { void adoptDryRun(); }}
            />
          )}
        </div>
      )}

      {/* Migrate (gated) section ----------------------------------------- */}
      {status?.activeBackend === 'pglite' && (
        <div className="provider-panel-section mb-6">
          <h4 className="provider-panel-section-title text-base font-semibold mb-2 text-[var(--nim-text)]">
            {t('database.migrate.title')}
          </h4>
          <p className="provider-panel-hint text-sm text-[var(--nim-text-muted)] mb-3">
            <Trans t={t} i18nKey="database.migrate.description" values={{ dir: 'pglite-db.migrated-<timestamp>/' }} components={{ code: <code className="px-1 py-0.5 rounded bg-[var(--nim-bg-tertiary)] text-xs" /> }} />
          </p>

          <button
            type="button"
            onClick={() => { void openMigrationModal(); }}
            className="setting-button inline-flex items-center gap-2 py-1.5 px-3 rounded-md text-sm font-medium bg-[var(--nim-primary)] text-white border-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[var(--nim-primary-hover)]"
          >
            <MaterialSymbol icon="upgrade" size={16} />
            {t('database.migrate.button')}
          </button>
        </div>
      )}

      <HistoryMigrationWarning count={status?.historyRowsQuarantined} />
      {status?.activeBackend === 'sqlite' && (
        <div className="provider-panel-section mb-6 nim-database-already-migrated">
          <h4 className="provider-panel-section-title text-base font-semibold mb-2 text-[var(--nim-text)]">
            {t('database.migrated.title')}
          </h4>
          <p className="provider-panel-hint text-sm text-[var(--nim-text-muted)] flex items-start gap-2">
            <MaterialSymbol icon="check_circle" size={16} />
            <span>
              {t('database.migrated.description')}
            </span>
          </p>
        </div>
      )}

      {/* Rollback section (only visible if a migrated dir exists) -------- */}
      {status && status.migratedDirs.length > 0 && (
        <div className="provider-panel-section mb-6">
          <h4 className="provider-panel-section-title text-base font-semibold mb-2 text-[var(--nim-text)]">
            {t('database.restore.title')}
          </h4>
          <p className="provider-panel-hint text-sm text-[var(--nim-text-muted)] mb-3">
            {t('database.restore.description')}
          </p>
          <button
            type="button"
            onClick={rollback}
            className="setting-button inline-flex items-center gap-2 py-1.5 px-3 rounded-md text-sm font-medium bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] border border-[var(--nim-border)] cursor-pointer hover:bg-[var(--nim-hover)]"
          >
            <MaterialSymbol icon="restore" size={16} />
            {t('database.restore.button')}
          </button>
        </div>
      )}

      <MigratedCopiesSection onChanged={() => { void loadStatus(); }} />

      {showMigrationModal && (
        <MigrationModal
          preflight={preflight}
          preflightError={preflightError}
          phase={phase}
          progress={progress}
          running={migrationRunning}
          summary={migrationSummary}
          failure={migrationFailure}
          onClose={() => {
            if (migrationRunning) return;
            setShowMigrationModal(false);
            void loadStatus();
          }}
          onStart={() => { void startMigration(); }}
          onCopyDiagnostic={() => { void copyDiagnosticInfo(); }}
        />
      )}
    </div>
  );
}

function MigrationModal(props: {
  preflight: PreflightResult | null;
  preflightError: string | null;
  phase: PhaseEvent | null;
  progress: ProgressEvent | null;
  running: boolean;
  summary: MigrationSummary | null;
  failure: MigrationFailure | null;
  onClose: () => void;
  onStart: () => void;
  onCopyDiagnostic: () => void;
}): React.ReactElement {
  const { preflight, preflightError, phase, progress, running, summary, failure, onClose, onStart, onCopyDiagnostic } = props;
  const { t } = useTranslation('settings');
  const currentTable = progress?.currentTable ?? progress?.table ?? t('migration.phases.preparing');
  const isVerifying = phase?.phase?.startsWith('verifying') ?? false;
  const isCutover = phase?.phase === 'finalizing';

  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/45 px-4">
      <div className="w-full max-w-2xl rounded-xl border border-[var(--nim-border)] bg-[var(--nim-bg-primary)] p-6 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h4 className="text-lg font-semibold text-[var(--nim-text)]">{t('database.migrate.title')}</h4>
            <p className="mt-1 text-sm text-[var(--nim-text-muted)]">
              {t('database.modal.description')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="rounded-md px-2 py-1 text-sm text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-secondary)] disabled:opacity-40"
          >
            {t('common:close')}
          </button>
        </div>

        {preflightError && (
          <div className="rounded-md border border-[rgba(220,38,38,0.3)] bg-[rgba(220,38,38,0.1)] p-3 text-sm text-[var(--nim-text)]">
            {t('database.modal.preflightFailed', { error: preflightError })}
          </div>
        )}

        {!running && !summary && !failure && preflight && (
          <div className="space-y-4">
            <div className="rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-4 text-sm">
              <div className="mb-2 font-medium text-[var(--nim-text)]">{t('database.modal.preflight')}</div>
              <div className="space-y-2 text-[var(--nim-text-muted)]">
                <div>{preflight.ok ? t('database.modal.diskSpaceOk', { free: formatBytes(preflight.freeBytes), required: formatBytes(preflight.requiredBytes) }) : t('database.modal.diskSpaceFail', { free: formatBytes(preflight.freeBytes), required: formatBytes(preflight.requiredBytes) })}</div>
                <div>{t('database.modal.pgliteSize', { size: formatBytes(preflight.pgliteDirBytes) })}</div>
                {!preflight.ok && preflight.reason && <div className="text-[var(--nim-error)]">{preflight.reason}</div>}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className="rounded-md border border-[var(--nim-border)] px-3 py-2 text-sm text-[var(--nim-text)]">
                {t('common:cancel')}
              </button>
              <button
                type="button"
                onClick={onStart}
                disabled={!preflight.ok}
                className="rounded-md bg-[var(--nim-primary)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {t('database.modal.startMigration')}
              </button>
            </div>
          </div>
        )}

        {running && (
          <div className="space-y-4">
            <div>
              <div className="text-sm font-medium text-[var(--nim-text)]">
                {isCutover ? t('database.modal.switching') : isVerifying ? t('database.modal.verifying') : t('database.modal.migrating')}
              </div>
              <div className="mt-1 text-sm text-[var(--nim-text-muted)]">
                {isCutover ? t('database.modal.cutoverDetail') : isVerifying ? t('database.modal.phase', { phase: phase?.phase }) : `${currentTable}: ${progress?.tableRowsCopied ?? 0} / ${progress?.tableRowsExpected ?? 0}`}
              </div>
            </div>
            <div className="space-y-2">
              <div className="h-2 overflow-hidden rounded-full bg-[var(--nim-bg-secondary)]">
                <div className="h-full bg-[var(--nim-primary)]" style={{ width: `${progress?.percentOfTotal ?? 0}%` }} />
              </div>
              <div className="flex justify-between text-xs text-[var(--nim-text-muted)]">
                <span>{t('migration.progress.tables', { completed: progress?.tablesCompleted ?? 0, total: progress?.tablesTotal ?? 0 })}</span>
                <span>{Math.round(progress?.percentOfTotal ?? 0)}%</span>
              </div>
              <div className="text-xs text-[var(--nim-text-muted)]">
                {t('database.modal.rowsAndElapsed', { rows: (progress?.totalRowsCopied ?? 0).toLocaleString(), elapsed: formatDuration(progress?.elapsedMs ?? 0) })}
              </div>
            </div>
          </div>
        )}

        {summary && (
          <div className="space-y-4">
            <div className="rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-4">
              <div className="text-sm font-medium text-[var(--nim-text)]">{t('database.modal.complete')}</div>
              <HistoryMigrationWarning count={summary.historyRowsQuarantined} />
              <div className="mt-2 grid grid-cols-2 gap-3 text-sm">
                <Stat label={t('database.modal.rowsTransferred')} value={summary.totalRowsCopied.toLocaleString()} />
                <Stat label={t('database.modal.tablesMigrated')} value={String(summary.tablesCopied.length)} />
                <Stat label={t('migration.dryRunResult.duration')} value={formatDuration(summary.durationMs)} />
                <Stat label={t('migration.dryRunResult.integrity')} value={summary.integrityCheck} ok={summary.integrityCheck === 'ok'} />
              </div>
            </div>
            <div className="flex justify-end">
              <button type="button" onClick={onClose} className="rounded-md bg-[var(--nim-primary)] px-3 py-2 text-sm font-medium text-white">
                {t('common:continue')}
              </button>
            </div>
          </div>
        )}

        {failure && (
          <div className="space-y-4">
            <div className="rounded-md border border-[rgba(220,38,38,0.3)] bg-[rgba(220,38,38,0.1)] p-4 text-sm text-[var(--nim-text)]">
              <div className="font-medium">{t('database.modal.failed')}</div>
              <div className="mt-2">{t('database.modal.phase', { phase: failure.phase })}</div>
              <div className="mt-1">{failure.message}</div>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onCopyDiagnostic} className="rounded-md border border-[var(--nim-border)] px-3 py-2 text-sm text-[var(--nim-text)]">
                {t('database.modal.copyDiagnostic')}
              </button>
              <button type="button" onClick={onClose} className="rounded-md bg-[var(--nim-primary)] px-3 py-2 text-sm font-medium text-white">
                {t('database.modal.continueWithPglite')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
