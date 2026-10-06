import React from "react";
import { HistoryMigrationWarning } from "./GlobalSettings/panels/database/MigrationProgressViews";
import { useAtomValue } from "jotai";
import { useTranslation } from "@nimbalyst/runtime/i18n/react";
import { dbMigrationOperationAtom } from "../store/atoms/dbMigration";

/** Mounted once per window; cutover closes the database for every window. */
export function DatabaseMaintenanceNotice(): React.ReactElement | null {
  const { t } = useTranslation("onboarding");
  const operation = useAtomValue(dbMigrationOperationAtom);
  if (!operation?.requiresRestart) return null;
  const response = operation.response as
    | {
        result?: { historyRowsQuarantined?: number };
        summary?: { historyRowsQuarantined?: number };
      }
    | undefined;
  const ready = operation.status === "awaiting-restart";
  const rollback = operation.kind === "rollback";
  return (
    <div
      className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label={t("databaseMaintenance.ariaLabel")}
    >
      <div className="max-w-md rounded-lg p-6 bg-[var(--nim-bg-primary)] text-[var(--nim-text)] shadow-xl">
        <h2 className="text-lg font-semibold mb-2">
          {ready
            ? t("databaseMaintenance.readyTitle")
            : t("databaseMaintenance.finishingTitle")}
        </h2>
        <p>
          {ready
            ? rollback
              ? t("databaseMaintenance.readyRollback")
              : t("databaseMaintenance.readyMigration")
            : rollback
              ? t("databaseMaintenance.pausedRollback")
              : t("databaseMaintenance.pausedMigration")}
        </p>
        <HistoryMigrationWarning
          count={
            response?.result?.historyRowsQuarantined ??
            response?.summary?.historyRowsQuarantined
          }
        />
        {ready && (
          <button
            className="setting-button mt-4"
            type="button"
            autoFocus
            onClick={() => {
              void window.electronAPI?.invoke("db:migration:restart");
            }}
          >
            {t("databaseMaintenance.restart")}
          </button>
        )}
      </div>
    </div>
  );
}
