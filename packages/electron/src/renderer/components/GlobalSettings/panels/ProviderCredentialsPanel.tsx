import React, { useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import {
  providerCredentialsAtom,
  providerCredentialErrorAtom,
  refreshProviderCredentials,
  changeProviderCredential,
} from "../../../store/providerCredentials";
import {
  cancelPendingProviderKey,
  flushPendingAIProviderPersist,
} from "../../../store/atoms/appSettings";
import { useTranslation } from "@nimbalyst/runtime/i18n/react";

/** Saved entries stay reachable even when their provider is disabled/uninstalled. */
export function ProviderCredentialsPanel({
  name,
  compact = false,
}: {
  name?: string;
  compact?: boolean;
}) {
  const { t } = useTranslation("settings");
  const snapshot = useAtomValue(providerCredentialsAtom);
  const error = useAtomValue(providerCredentialErrorAtom);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    void refreshProviderCredentials();
  }, []);
  const entries =
    snapshot?.credentials.filter(
      (c) => !name || (c.name === name && !c.workspacePath)
    ) ?? [];
  const clear = async (credential: (typeof entries)[number]) => {
    const id = JSON.stringify([credential.name, credential.workspacePath]);
    setBusy(id);
    if (!credential.workspacePath) cancelPendingProviderKey(credential.name);
    try {
      await changeProviderCredential(credential.name, null, {
        workspacePath: credential.workspacePath,
      });
      setNotice(
        credential.name === "openai" && !credential.workspacePath
          ? t("providers.credentials.clearedOpenAi")
          : t("providers.credentials.cleared")
      );
    } catch {
      /* The shared error atom exposes the failure. */
    } finally {
      setBusy(null);
    }
  };
  if (
    compact &&
    !entries.length &&
    !error &&
    !notice &&
    snapshot?.state === "available"
  )
    return null;
  return (
    <section className="provider-credentials-panel mb-5 rounded border border-[var(--nim-border)] p-4">
      <h3 className="font-semibold text-[var(--nim-text)]">
        {compact ? t("providers.credentials.savedKey") : t("providers.credentials.savedKeys")}
      </h3>
      {!compact && (
        <p className="mt-2 text-sm text-[var(--nim-text-muted)]">
          {t("providers.credentials.manageDescription")}
        </p>
      )}
      {(error || snapshot?.message) && (
        <p role="alert" className="my-2 text-sm text-[var(--nim-error)]">
          {error || snapshot?.message}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-2 text-sm text-[var(--nim-text-muted)]">
          {notice}
        </p>
      )}
      {(error || snapshot?.state !== "available") && (
        <button
          type="button"
          className="nim-button mt-2"
          onClick={() => {
            void refreshProviderCredentials().then(() =>
              flushPendingAIProviderPersist()
            );
          }}
        >
          {t("providers.credentials.retrySecureStorage")}
        </button>
      )}
      {entries.map((credential) => {
        const id = JSON.stringify([credential.name, credential.workspacePath]);
        return (
          <div
            key={id}
            className="saved-provider-credential flex items-center justify-between gap-4 py-3"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {t("providers.credentials.keySaved", { name: credential.name })}
              </p>
              <p className="break-all text-xs text-[var(--nim-text-muted)]">
                {credential.workspacePath
                  ? t("providers.credentials.workspaceKey", { path: credential.workspacePath })
                  : t("providers.credentials.globalKey")}
              </p>
            </div>
            <button
              type="button"
              disabled={busy !== null}
              className="nim-button shrink-0"
              onClick={() => {
                void clear(credential);
              }}
            >
              {busy === id ? t("providers.credentials.clearing") : t("providers.credentials.clearKey")}
            </button>
          </div>
        );
      })}
      {!compact && snapshot?.state === "available" && !entries.length && (
        <p className="mt-3 text-sm text-[var(--nim-text-muted)]">
          {t("providers.credentials.noKeys")}
        </p>
      )}
    </section>
  );
}
