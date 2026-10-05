import React from "react";
import { MaterialSymbol } from "@nimbalyst/runtime/ui/icons/MaterialSymbol";
import { useTranslation } from "@nimbalyst/runtime/i18n/react";
import type {
  MigrationPhaseEvent as PhaseEvent,
  MigrationProgressEvent as ProgressEvent,
} from "../../../../store/atoms/dbMigration";
import { formatBytes, formatDuration } from "./dbFormat";

export interface DryRunResult {
  summary: {
    historyRowsQuarantined?: number;
    tablesCopied: Array<{ name: string; rows: number }>;
    totalRowsCopied: number;
    durationMs: number;
    foreignKeyViolations: number;
    integrityCheck: string;
    spotCheckCount: number;
  };
  dryRunDir: string;
  sqliteFileBytes: number;
  pgliteDirBytes: number;
}

export function DryRunResultCard({
  result,
}: {
  result: DryRunResult;
}): React.ReactElement {
  const { t } = useTranslation("settings");
  const sizeChange = result.sqliteFileBytes - result.pgliteDirBytes;
  const sizeChangePct =
    result.pgliteDirBytes > 0
      ? ((sizeChange / result.pgliteDirBytes) * 100).toFixed(1)
      : "0";
  return (
    <div className="p-3 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)]">
      <div className="grid grid-cols-2 gap-3 text-sm mb-3">
        <Stat
          label={t("migration.dryRunResult.rowsCopied")}
          value={result.summary.totalRowsCopied.toLocaleString()}
        />
        <Stat
          label={t("migration.dryRunResult.tables")}
          value={String(result.summary.tablesCopied.length)}
        />
        <Stat
          label={t("migration.dryRunResult.duration")}
          value={formatDuration(result.summary.durationMs)}
        />
        <Stat
          label={t("migration.dryRunResult.fkViolations")}
          value={String(result.summary.foreignKeyViolations)}
          ok={result.summary.foreignKeyViolations === 0}
        />
        <Stat
          label={t("migration.dryRunResult.integrity")}
          value={result.summary.integrityCheck}
          ok={result.summary.integrityCheck === "ok"}
        />
        <Stat
          label={t("migration.dryRunResult.onDisk")}
          value={t("migration.dryRunResult.onDiskValue", { sqliteSize: formatBytes(result.sqliteFileBytes), pgliteSize: formatBytes(
            result.pgliteDirBytes
          ), change: `${sizeChange >= 0 ? "+" : ""}${sizeChangePct}` })}
        />
      </div>

      <HistoryMigrationWarning count={result.summary.historyRowsQuarantined} />
      <details className="mt-2 nim-database-dry-run-per-table">
        <summary className="cursor-pointer text-xs text-[var(--nim-text-muted)] hover:text-[var(--nim-text)]">
          {t("migration.dryRunResult.perTableBreakdown", { tableCount: result.summary.tablesCopied.length })}
        </summary>
        <table className="w-full mt-2 text-xs">
          <thead>
            <tr className="text-left text-[var(--nim-text-muted)] border-b border-[var(--nim-border)]">
              <th className="py-1 pr-2">{t("migration.dryRunResult.table")}</th>
              <th className="py-1 text-right">{t("migration.dryRunResult.rowsCopied")}</th>
            </tr>
          </thead>
          <tbody>
            {result.summary.tablesCopied.map((t) => (
              <tr
                key={t.name}
                className="border-b border-[var(--nim-border)] last:border-b-0"
              >
                <td className="py-1 pr-2 text-[var(--nim-text)] font-mono">
                  {t.name}
                </td>
                <td className="py-1 text-right text-[var(--nim-text)]">
                  {t.rows.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

export function Stat({
  label,
  value,
  ok,
}: {
  label: string;
  value: string;
  ok?: boolean;
}): React.ReactElement {
  const colorClass =
    ok === false ? "text-[var(--nim-error)]" : "text-[var(--nim-text)]";
  return (
    <div className="flex flex-col gap-0">
      <span className="text-xs text-[var(--nim-text-muted)]">{label}</span>
      <span className={`text-sm font-medium ${colorClass}`}>{value}</span>
    </div>
  );
}

export function DryRunProgress({
  phase,
  progress,
}: {
  phase: PhaseEvent | null;
  progress: ProgressEvent | null;
}): React.ReactElement {
  const { t } = useTranslation("settings");
  const phaseKey = phase?.phase ?? progress?.phase ?? "preparing";
  const phaseLabel = PHASE_LABELS[phaseKey] ? t(PHASE_LABELS[phaseKey]) : phaseKey;
  const currentTable = progress?.currentTable ?? phase?.info?.currentTable;
  const tableRowsCopied = progress?.tableRowsCopied ?? 0;
  const tableRowsExpected = progress?.tableRowsExpected ?? 0;
  const rowsCopied = progress?.rowsCopied ?? 0;
  const rowsExpected = progress?.rowsExpected ?? 0;
  const tablesCompleted = progress?.tablesCompleted ?? 0;
  const tablesTotal = progress?.tablesTotal ?? 0;
  const percent = progress?.percentOfTotal ?? 0;
  const elapsed = progress?.elapsedMs ?? 0;
  const isCopying = phaseKey === "copying";

  return (
    <div className="mt-3 space-y-2 rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-3 text-xs nim-database-dry-run-progress">
      <div className="flex items-baseline justify-between gap-3">
        <div className="font-medium text-[var(--nim-text)]">{phaseLabel}</div>
        {currentTable && (
          <div className="text-[var(--nim-text-muted)]">{currentTable}</div>
        )}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-[var(--nim-bg-primary)]">
        <div
          className="h-full bg-[var(--nim-primary)] transition-all"
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </div>
      <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-[var(--nim-text-muted)]">
        <span>
          {t("migration.progress.tables", { completed: tablesCompleted, total: tablesTotal })}
        </span>
        <span>
          {rowsExpected > 0
            ? t("migration.progress.rowsWithExpected", { copied: rowsCopied.toLocaleString(), expected: rowsExpected.toLocaleString() })
            : t("migration.progress.rows", { copied: rowsCopied.toLocaleString() })}
        </span>
        <span>{t("migration.progress.elapsed", { elapsed: formatDuration(elapsed) })}</span>
      </div>
      {isCopying && tableRowsExpected > 0 && (
        <div className="text-[var(--nim-text-muted)]">
          {t("migration.progress.thisTable", { copied: tableRowsCopied.toLocaleString(), expected: tableRowsExpected.toLocaleString() })}
        </div>
      )}
    </div>
  );
}

export function AdoptDryRunSection({
  available,
  running,
  phase,
  progress,
  error,
  result,
  onAdopt,
}: {
  available: {
    completedAt: string;
    totalRows: number;
    historyRowsQuarantined?: number;
  };
  running: boolean;
  phase: PhaseEvent | null;
  progress: ProgressEvent | null;
  error: string | null;
  result: {
    rowsAdded: number;
    durationMs: number;
    historyRowsQuarantined?: number;
  } | null;
  onAdopt: () => void;
}): React.ReactElement {
  const { t } = useTranslation("settings");
  const ageHrs =
    (Date.now() - new Date(available.completedAt).getTime()) / 3_600_000;
  const ageBlurb =
    ageHrs < 1
      ? t("migration.adopt.lessThanAnHourAgo")
      : ageHrs < 24
      ? t("migration.adopt.hoursAgo", { count: Math.round(ageHrs) })
      : t("migration.adopt.daysAgo", { count: Math.round(ageHrs / 24) });
  return (
    <div className="mt-4 p-4 rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] nim-database-adopt-dry-run">
      <div className="text-sm font-medium text-[var(--nim-text)] mb-1">
        {t("migration.adopt.title")}
      </div>
      <p className="text-xs text-[var(--nim-text-muted)] mb-3">
        {t("migration.adopt.description", { age: ageBlurb, rows: available.totalRows.toLocaleString() })}
      </p>
      <HistoryMigrationWarning
        count={
          result?.historyRowsQuarantined ?? available.historyRowsQuarantined
        }
      />
      <button
        type="button"
        onClick={onAdopt}
        disabled={running}
        className="setting-button inline-flex items-center gap-2 py-1.5 px-3 rounded-md text-sm font-medium bg-[var(--nim-primary)] text-white border-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[var(--nim-primary-hover)] nim-database-adopt-button"
      >
        <MaterialSymbol icon={running ? "sync" : "swap_horiz"} size={16} />
        {running ? t("migration.adopt.switching") : t("migration.adopt.switchButton")}
      </button>

      {running && (phase || progress) && (
        <DryRunProgress phase={phase} progress={progress} />
      )}

      {error && (
        <div className="mt-3 p-3 rounded-md bg-[rgba(220,38,38,0.1)] border border-[rgba(220,38,38,0.3)] text-sm text-[var(--nim-text)]">
          {t("migration.adopt.switchFailed", { error })}
        </div>
      )}

      {result && (
        <div className="mt-3 p-3 rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-primary)] text-sm text-[var(--nim-text)]">
          {t("migration.adopt.switched", { count: result.rowsAdded, rows: result.rowsAdded.toLocaleString(), duration: formatDuration(result.durationMs) })}
        </div>
      )}
    </div>
  );
}

const PHASE_LABELS: Record<string, string> = {
  preparing: "migration.phases.preparing",
  copying: "migration.phases.copying",
  "rebuilding-fts": "migration.phases.rebuildingFts",
  "verifying-counts": "migration.phases.verifyingCounts",
  "verifying-spot-check": "migration.phases.verifyingSpotCheck",
  "verifying-integrity": "migration.phases.verifyingIntegrity",
  "verifying-foreign-keys": "migration.phases.verifyingForeignKeys",
  finalizing: "migration.phases.finalizing",
};

export function HistoryMigrationWarning({
  count,
}: {
  count?: number;
}): React.ReactElement | null {
  const { t } = useTranslation("settings");
  if (!count) return null;
  return (
    <div
      role="status"
      className="my-3 p-3 rounded-md border border-[var(--nim-border)] text-sm"
    >
      {t("migration.historyWarning", { count, formattedCount: count.toLocaleString() })}
    </div>
  );
}
