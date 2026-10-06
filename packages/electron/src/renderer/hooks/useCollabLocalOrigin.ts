import { useCallback, useEffect, useMemo, useState } from 'react';
import { requestConfirmation } from '../dialogs/requestConfirmation';
import { errorNotificationService } from '../services/ErrorNotificationService';
import { t as translate } from '@nimbalyst/runtime/i18n';
import { DocumentModelRegistry } from '../services/document-model/DocumentModelRegistry';
import { getTeamSyncProviderForScopeKey } from '../store/atoms/collabDocuments';
import { teamMemberDisplayName } from '../utils/teamMemberDisplayName';

export type CollabLocalOriginBinding = NonNullable<
  Awaited<ReturnType<typeof window.electronAPI.documentSync.getLocalOrigin>>['binding']
>;

type ReuploadResult = Awaited<
  ReturnType<typeof window.electronAPI.documentSync.reuploadLocalOrigin>
>;

type PullResult = Awaited<
  ReturnType<typeof window.electronAPI.documentSync.pullLocalOrigin>
>;

type RendererReuploadResult =
  | { status: 'uploaded'; binding: CollabLocalOriginBinding | null }
  | { status: 'noop'; binding: CollabLocalOriginBinding | null }
  | { status: 'conflict'; result: ReuploadResult }
  | { status: 'error'; message: string };

async function hashText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 0) return translate('dialogs:collabOrigin.relativeTime.justNow');
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 1) return translate('dialogs:collabOrigin.relativeTime.justNow');
  if (minutes < 60) return translate('dialogs:collabOrigin.relativeTime.minutesAgo', { minutes });
  if (hours < 24) return translate('dialogs:collabOrigin.relativeTime.hoursAgo', { hours });
  if (days < 7) return translate('dialogs:collabOrigin.relativeTime.daysAgo', { days });
  return new Date(ms).toLocaleDateString();
}

/**
 * Resolve a room-authed userId to a human label. Falls back to null when the
 * editor isn't in the roster (e.g. it was the local user on another device,
 * or a since-removed member).
 */
function resolveEditorLabel(workspacePath: string, userId: string | null | undefined): string | null {
  if (!userId) return null;
  try {
    const members = getTeamSyncProviderForScopeKey(workspacePath)?.getTeamState()?.members ?? [];
    const member = members.find((candidate) => candidate.userId === userId);
    return member ? teamMemberDisplayName(member) : null;
  } catch {
    return null;
  }
}

/**
 * Describe who/when last edited the shared copy so the overwrite confirm can
 * tell the user what their push is about to clobber. Sourced from the
 * DocumentRoom's last *content* update (NIM-953 / NIM-955), delivered on the
 * conflict result. Returns null when neither who nor when is known.
 */
function describeSharedChange(
  result: { lastEditedAt?: number | null; lastEditorId?: string | null },
  workspacePath: string,
): string | null {
  const at = result.lastEditedAt ?? null;
  const who = resolveEditorLabel(workspacePath, result.lastEditorId);
  const when = at ? `${formatRelativeTime(at)} (${new Date(at).toLocaleString()})` : null;
  if (who && when) return translate('dialogs:collabOrigin.sharedChange.whoAndWhen', { who, when });
  if (who) return translate('dialogs:collabOrigin.sharedChange.who', { who });
  if (when) return translate('dialogs:collabOrigin.sharedChange.when', { when });
  return null;
}

function buildConflictPrompt(result: ReuploadResult, workspacePath: string): string {
  let kind: string;
  switch (result.conflictKind) {
    case 'missing-baseline':
      kind = translate('dialogs:collabOrigin.conflict.missingBaselineSource');
      break;
    case 'shared-ahead':
      kind = translate('dialogs:collabOrigin.conflict.sharedAhead');
      break;
    case 'diverged':
      kind = translate('dialogs:collabOrigin.conflict.diverged');
      break;
    default:
      kind = '';
      break;
  }
  const context = describeSharedChange(result, workspacePath);
  const action = translate('dialogs:collabOrigin.conflict.pushAction');
  return [context, kind, action].filter(Boolean).join(' ');
}

function confirmOverwriteShared(message: string): Promise<boolean> {
  return requestConfirmation({
    title: translate('dialogs:collabOrigin.overwriteShared.title'),
    message,
    confirmLabel: translate('dialogs:collabOrigin.overwriteShared.confirm'),
    destructive: true,
  });
}

function buildPullConflictPrompt(result: PullResult, workspacePath: string): string {
  let kind: string;
  switch (result.conflictKind) {
    case 'missing-baseline':
      kind = translate('dialogs:collabOrigin.conflict.missingBaselineFile');
      break;
    case 'local-ahead':
      kind = translate('dialogs:collabOrigin.conflict.localAhead');
      break;
    case 'diverged':
      kind = translate('dialogs:collabOrigin.conflict.diverged');
      break;
    default:
      kind = '';
      break;
  }
  const context = describeSharedChange(result, workspacePath);
  const action = translate('dialogs:collabOrigin.conflict.pullAction');
  return [context, kind, action].filter(Boolean).join(' ');
}

/**
 * Fallback when main reports 'unsupported' (no main-process collab adapter for
 * this document type): external structured editors (mindmap) register a
 * RENDERER codec instead, so read the linked local file here and push it into
 * the room headlessly (wipe-and-reseed via the codec + flush-with-ack).
 * Performs the same baseline/noop/conflict checks as the main adapter path
 * before writing, then refreshes the saved local-origin hashes.
 */
export async function tryRendererHeadlessReupload(
  workspacePath: string,
  documentId: string,
  result: ReuploadResult,
  forceOverwriteShared = false,
): Promise<RendererReuploadResult> {
  const resolvedPath = result.binding?.resolvedPath;
  const documentType = result.binding?.documentType;
  if (!resolvedPath || !documentType || !window.electronAPI?.readFileContent) {
    return { status: 'error', message: result.message || translate('dialogs:collabOrigin.errors.sourceUnavailable') };
  }
  try {
    const fileRes = await window.electronAPI.readFileContent(resolvedPath);
    if (!fileRes?.success) {
      return { status: 'error', message: fileRes?.error || translate('dialogs:collabOrigin.errors.readSourceFailed') };
    }
    if (typeof fileRes.content !== 'string') {
      return { status: 'error', message: translate('dialogs:collabOrigin.errors.sourceNotText') };
    }

    const sourceHash = await hashText(fileRes.content);
    const baselineLocal = result.binding?.lastLocalContentHash ?? null;
    const baselineShared = result.binding?.lastCollabContentHash ?? null;
    const { exportSharedDocument, reuploadSharedDocument } = await import('../utils/documentSeedOrchestrator');
    const sharedRead = await exportSharedDocument({
      workspacePath,
      documentId,
      documentType,
    });
    if (!sharedRead.ok || typeof sharedRead.content !== 'string') {
      console.warn('[useCollabLocalOrigin] renderer-headless shared export failed:', sharedRead.error);
      return {
        status: 'error',
        message: sharedRead.error || translate('dialogs:collabOrigin.errors.readSharedFailed'),
      };
    }

    const sharedHash = await hashText(sharedRead.content);

    let conflictKind: ReuploadResult['conflictKind'] | null = null;
    if (!baselineLocal || !baselineShared) {
      conflictKind = 'missing-baseline';
    } else if (sourceHash === baselineLocal && sharedHash === baselineShared) {
      return { status: 'noop', binding: result.binding ?? null };
    } else if (sourceHash === baselineLocal && sharedHash !== baselineShared) {
      conflictKind = 'shared-ahead';
    } else if (sourceHash !== baselineLocal && sharedHash !== baselineShared) {
      conflictKind = 'diverged';
    }

    if (conflictKind && !forceOverwriteShared) {
      return {
        status: 'conflict',
        result: {
          ...result,
          success: false,
          status: 'conflict',
          conflictKind,
        },
      };
    }

    const headless = await reuploadSharedDocument({
      workspacePath,
      documentId,
      documentType,
      content: fileRes.content,
    });
    if (!headless.ok) {
      console.warn('[useCollabLocalOrigin] renderer-headless reupload failed:', headless.error);
      return {
        status: 'error',
        message: headless.error || translate('dialogs:collabOrigin.errors.writeSharedFailed'),
      };
    }

    if (window.electronAPI?.documentSync?.saveLocalOrigin) {
      const saveResult = await window.electronAPI.documentSync.saveLocalOrigin({
        workspacePath,
        documentId,
        documentType,
        sourceFilePath: resolvedPath,
        lastLocalContentHash: sourceHash,
        lastCollabContentHash: sourceHash,
      });
      if (saveResult?.success) {
        return { status: 'uploaded', binding: saveResult.binding ?? null };
      }
      console.warn('[useCollabLocalOrigin] renderer-headless baseline save failed:', saveResult?.error);
    }

    return { status: 'uploaded', binding: result.binding ?? null };
  } catch (err) {
    console.warn('[useCollabLocalOrigin] renderer-headless reupload threw:', err);
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

export function useCollabLocalOrigin(
  workspacePath: string,
  documentId: string | null | undefined,
  documentType?: string,
) {
  const [binding, setBinding] = useState<CollabLocalOriginBinding | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!workspacePath || !documentId || !window.electronAPI?.documentSync?.getLocalOrigin) {
      setBinding(null);
      return;
    }

    setLoading(true);
    try {
      const result = await window.electronAPI.documentSync.getLocalOrigin(workspacePath, documentId);
      if (result.success) {
        setBinding(result.binding ?? null);
      } else {
        setBinding(null);
      }
    } finally {
      setLoading(false);
    }
  }, [documentId, workspacePath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hasResolvedBinding = binding?.resolvedPath && binding.resolutionStatus !== 'missing';

  const openLocalSource = useCallback(async () => {
    if (!workspacePath || !binding?.resolvedPath) return false;
    await window.electronAPI.invoke('workspace:open-file', {
      workspacePath,
      filePath: binding.resolvedPath,
    });
    return true;
  }, [binding?.resolvedPath, workspacePath]);

  const relinkLocalSource = useCallback(async () => {
    if (!workspacePath || !documentId || !documentType || !window.electronAPI?.documentSync?.relinkLocalOrigin) {
      return false;
    }

    const result = await window.electronAPI.openFileDialog({
      title: translate('dialogs:collabOrigin.relinkDialog.title'),
      defaultPath: binding?.resolvedPath ?? workspacePath,
      buttonLabel: translate('dialogs:collabOrigin.relinkDialog.button'),
    });
    const selectedPath = result?.filePaths?.[0];
    if (result?.canceled || !selectedPath) {
      return false;
    }

    setBusyAction('relink');
    try {
      const relinkResult = await window.electronAPI.documentSync.relinkLocalOrigin({
        workspacePath,
        documentId,
        documentType,
        sourceFilePath: selectedPath,
      });
      if (!relinkResult.success) {
        errorNotificationService.showError(
          translate('dialogs:collabOrigin.relinkFailed.title'),
          relinkResult.error || translate('dialogs:collabOrigin.relinkFailed.message'),
        );
        return false;
      }

      setBinding(relinkResult.binding ?? null);
      errorNotificationService.showInfo(
        translate('dialogs:collabOrigin.linked.title'),
        relinkResult.binding?.relativePath || translate('dialogs:collabOrigin.linked.message'),
        { duration: 4000 },
      );
      return true;
    } finally {
      setBusyAction(null);
    }
  }, [binding?.resolvedPath, documentId, documentType, workspacePath]);

  const clearLocalSource = useCallback(async () => {
    if (!workspacePath || !documentId || !window.electronAPI?.documentSync?.clearLocalOrigin) {
      return false;
    }
    const confirmed = await requestConfirmation({
      title: translate('dialogs:collabOrigin.clear.title'),
      message: translate('dialogs:collabOrigin.clear.message'),
      confirmLabel: translate('dialogs:collabOrigin.clear.confirm'),
      destructive: true,
    });
    if (!confirmed) {
      return false;
    }

    setBusyAction('clear');
    try {
      const result = await window.electronAPI.documentSync.clearLocalOrigin(workspacePath, documentId);
      if (!result.success) {
        errorNotificationService.showError(
          translate('dialogs:collabOrigin.clearFailed.title'),
          result.error || translate('dialogs:collabOrigin.clearFailed.message'),
        );
        return false;
      }
      setBinding(null);
      errorNotificationService.showInfo(
        translate('dialogs:collabOrigin.cleared.title'),
        translate('dialogs:collabOrigin.cleared.message'),
        { duration: 3000 },
      );
      return true;
    } finally {
      setBusyAction(null);
    }
  }, [documentId, workspacePath]);

  const reuploadFromLocalSource = useCallback(async () => {
    if (!workspacePath || !documentId || !window.electronAPI?.documentSync?.reuploadLocalOrigin) {
      return false;
    }

    setBusyAction('reupload');
    try {
      let result = await window.electronAPI.documentSync.reuploadLocalOrigin({
        workspacePath,
        documentId,
      });

      if (result.status === 'conflict') {
        const confirmed = await confirmOverwriteShared(buildConflictPrompt(result, workspacePath));
        if (!confirmed) return false;
        result = await window.electronAPI.documentSync.reuploadLocalOrigin({
          workspacePath,
          documentId,
          forceOverwriteShared: true,
        });
      }

      if (result.success && result.binding !== undefined) {
        setBinding(result.binding ?? null);
      }

      if (result.status === 'unsupported' && documentId) {
        let rendererResult = await tryRendererHeadlessReupload(workspacePath, documentId, result);
        if (rendererResult.status === 'conflict') {
          const confirmed = await confirmOverwriteShared(buildConflictPrompt(rendererResult.result, workspacePath));
          if (!confirmed) return false;
          rendererResult = await tryRendererHeadlessReupload(workspacePath, documentId, result, true);
        }
        if (rendererResult.status === 'uploaded') {
          setBinding(rendererResult.binding ?? null);
          errorNotificationService.showInfo(
            translate('dialogs:collabOrigin.sharedUpdated.title'),
            translate('dialogs:collabOrigin.sharedUpdated.pushedMessage'),
            { duration: 5000 },
          );
          return true;
        }
        if (rendererResult.status === 'noop') {
          setBinding(rendererResult.binding ?? null);
          errorNotificationService.showInfo(
            translate('dialogs:collabOrigin.nothingToUpload.title'),
            translate('dialogs:collabOrigin.nothingToUpload.baselineMatchMessage'),
            { duration: 3500 },
          );
          return true;
        }
        if (rendererResult.status === 'error') {
          result = {
            ...result,
            status: 'error',
            message: rendererResult.message,
          };
        }
      }

      switch (result.status) {
        case 'uploaded': {
          const migrationSummary = result.migration && (result.migration.okCount > 0 || result.migration.failedCount > 0)
            ? ` ${result.migration.failedCount > 0
              ? translate('dialogs:collabOrigin.sharedUpdated.attachmentsUploadedWithFailures', { count: result.migration.okCount, failed: result.migration.failedCount })
              : translate('dialogs:collabOrigin.sharedUpdated.attachmentsUploaded', { count: result.migration.okCount })}`
            : '';
          errorNotificationService.showInfo(
            translate('dialogs:collabOrigin.sharedUpdated.title'),
            `${result.message || translate('dialogs:collabOrigin.sharedUpdated.uploadedMessage')}${migrationSummary}`,
            { duration: 5000 },
          );
          return true;
        }
        case 'noop':
          errorNotificationService.showInfo(
            translate('dialogs:collabOrigin.nothingToUpload.title'),
            result.message || translate('dialogs:collabOrigin.nothingToUpload.fileMatchMessage'),
            { duration: 3500 },
          );
          return true;
        case 'missing-source':
        case 'unsupported':
        case 'error':
        default:
          errorNotificationService.showError(
            translate('dialogs:collabOrigin.reuploadFailed.title'),
            result.message || translate('dialogs:collabOrigin.reuploadFailed.message'),
          );
          return false;
      }
    } finally {
      setBusyAction(null);
    }
  }, [documentId, workspacePath]);

  return useMemo(() => ({
    binding,
    busyAction,
    hasResolvedBinding: !!hasResolvedBinding,
    loading,
    refresh,
    openLocalSource,
    relinkLocalSource,
    clearLocalSource,
    reuploadFromLocalSource,
  }), [
    binding,
    busyAction,
    hasResolvedBinding,
    loading,
    refresh,
    openLocalSource,
    relinkLocalSource,
    clearLocalSource,
    reuploadFromLocalSource,
  ]);
}

export function useLocalFileSharedDocLink(
  workspacePath: string,
  sourceFilePath: string | null | undefined,
) {
  const [binding, setBinding] = useState<CollabLocalOriginBinding | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!workspacePath || !sourceFilePath || !window.electronAPI?.documentSync?.findLocalOriginLink) {
      setBinding(null);
      return;
    }

    setLoading(true);
    try {
      const result = await window.electronAPI.documentSync.findLocalOriginLink(workspacePath, sourceFilePath);
      if (result.success) {
        setBinding(result.binding ?? null);
      } else {
        setBinding(null);
      }
    } finally {
      setLoading(false);
    }
  }, [sourceFilePath, workspacePath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pullFromSharedDoc = useCallback(async () => {
    if (
      !workspacePath
      || !sourceFilePath
      || !binding?.documentId
      || !window.electronAPI?.documentSync?.pullLocalOrigin
    ) {
      return false;
    }

    setBusyAction('pull');
    try {
      const documentModel = DocumentModelRegistry.get(sourceFilePath);
      if (documentModel?.isDirty()) {
        await documentModel.flushDirtyEditors();
        if (documentModel.isDirty()) {
          errorNotificationService.showError(
            translate('dialogs:collabOrigin.pullFailed.title'),
            translate('dialogs:collabOrigin.pullFailed.saveFirstMessage'),
          );
          return false;
        }
      }

      let result = await window.electronAPI.documentSync.pullLocalOrigin({
        workspacePath,
        documentId: binding.documentId,
      });

      while (result.status === 'conflict') {
        const confirmed = await requestConfirmation({
          title: translate('dialogs:collabOrigin.overwriteLocal.title'),
          message: buildPullConflictPrompt(result, workspacePath),
          confirmLabel: translate('dialogs:collabOrigin.overwriteLocal.confirm'),
          destructive: true,
        });
        if (!confirmed) return false;
        if (!result.conflictToken) {
          errorNotificationService.showError(
            translate('dialogs:collabOrigin.pullFailed.title'),
            translate('dialogs:collabOrigin.pullFailed.changedBeforeConfirmMessage'),
          );
          return false;
        }
        result = await window.electronAPI.documentSync.pullLocalOrigin({
          workspacePath,
          documentId: binding.documentId,
          forceOverwriteLocal: true,
          conflictToken: result.conflictToken,
        });
      }

      if (result.success && result.binding !== undefined) {
        setBinding(result.binding ?? null);
      }

      switch (result.status) {
        case 'pulled':
          errorNotificationService.showInfo(
            translate('dialogs:collabOrigin.localUpdated.title'),
            translate('dialogs:collabOrigin.localUpdated.message', { name: binding.sourceBasename }),
            { duration: 5000 },
          );
          return true;
        case 'noop':
          errorNotificationService.showInfo(
            translate('dialogs:collabOrigin.upToDate.title'),
            result.message || translate('dialogs:collabOrigin.upToDate.message'),
            { duration: 3500 },
          );
          return true;
        case 'missing-source':
        case 'unsupported':
        case 'error':
        default:
          errorNotificationService.showError(
            translate('dialogs:collabOrigin.pullFailed.title'),
            result.message || translate('dialogs:collabOrigin.pullFailed.message'),
          );
          return false;
      }
    } catch (error) {
      errorNotificationService.showError(
        translate('dialogs:collabOrigin.pullFailed.title'),
        error instanceof Error ? error.message : String(error),
      );
      return false;
    } finally {
      setBusyAction(null);
    }
  }, [binding?.documentId, binding?.sourceBasename, sourceFilePath, workspacePath]);

  const reuploadToSharedDoc = useCallback(async () => {
    if (!workspacePath || !binding?.documentId || !window.electronAPI?.documentSync?.reuploadLocalOrigin) {
      return false;
    }

    setBusyAction('reupload');
    try {
      let result = await window.electronAPI.documentSync.reuploadLocalOrigin({
        workspacePath,
        documentId: binding.documentId,
      });

      if (result.status === 'conflict') {
        const confirmed = await confirmOverwriteShared(buildConflictPrompt(result, workspacePath));
        if (!confirmed) return false;
        result = await window.electronAPI.documentSync.reuploadLocalOrigin({
          workspacePath,
          documentId: binding.documentId,
          forceOverwriteShared: true,
        });
      }

      if (result.success && result.binding !== undefined) {
        setBinding(result.binding ?? null);
      }

      if (result.status === 'unsupported') {
        let rendererResult = await tryRendererHeadlessReupload(workspacePath, binding.documentId, result);
        if (rendererResult.status === 'conflict') {
          const confirmed = await confirmOverwriteShared(buildConflictPrompt(rendererResult.result, workspacePath));
          if (!confirmed) return false;
          rendererResult = await tryRendererHeadlessReupload(workspacePath, binding.documentId, result, true);
        }
        if (rendererResult.status === 'uploaded') {
          setBinding(rendererResult.binding ?? null);
          errorNotificationService.showInfo(
            translate('dialogs:collabOrigin.sharedUpdated.title'),
            translate('dialogs:collabOrigin.sharedUpdated.pushedMessage'),
            { duration: 5000 },
          );
          return true;
        }
        if (rendererResult.status === 'noop') {
          setBinding(rendererResult.binding ?? null);
          errorNotificationService.showInfo(
            translate('dialogs:collabOrigin.nothingToUpload.title'),
            translate('dialogs:collabOrigin.nothingToUpload.baselineMatchMessage'),
            { duration: 3500 },
          );
          return true;
        }
        if (rendererResult.status === 'error') {
          result = {
            ...result,
            status: 'error',
            message: rendererResult.message,
          };
        }
      }

      switch (result.status) {
        case 'uploaded': {
          const migrationSummary = result.migration && (result.migration.okCount > 0 || result.migration.failedCount > 0)
            ? ` ${result.migration.failedCount > 0
              ? translate('dialogs:collabOrigin.sharedUpdated.attachmentsUploadedWithFailures', { count: result.migration.okCount, failed: result.migration.failedCount })
              : translate('dialogs:collabOrigin.sharedUpdated.attachmentsUploaded', { count: result.migration.okCount })}`
            : '';
          errorNotificationService.showInfo(
            translate('dialogs:collabOrigin.sharedUpdated.title'),
            `${result.message || translate('dialogs:collabOrigin.sharedUpdated.uploadedMessage')}${migrationSummary}`,
            { duration: 5000 },
          );
          return true;
        }
        case 'noop':
          errorNotificationService.showInfo(
            translate('dialogs:collabOrigin.nothingToUpload.title'),
            result.message || translate('dialogs:collabOrigin.nothingToUpload.fileMatchMessage'),
            { duration: 3500 },
          );
          return true;
        case 'missing-source':
        case 'unsupported':
        case 'error':
        default:
          errorNotificationService.showError(
            translate('dialogs:collabOrigin.reuploadFailed.title'),
            result.message || translate('dialogs:collabOrigin.reuploadFailed.message'),
          );
          return false;
      }
    } finally {
      setBusyAction(null);
    }
  }, [binding?.documentId, workspacePath]);

  return useMemo(() => ({
    binding,
    busyAction,
    loading,
    refresh,
    pullFromSharedDoc,
    reuploadToSharedDoc,
  }), [
    binding,
    busyAction,
    loading,
    refresh,
    pullFromSharedDoc,
    reuploadToSharedDoc,
  ]);
}
