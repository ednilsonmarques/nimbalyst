import React, { useEffect, useRef } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { Trans, useTranslation } from '@nimbalyst/runtime/i18n/react';
import { getWorktreeNameFromPath } from '../../utils/pathUtils';
import { AgentModelPicker, type AgentModelOption } from './AgentModelPicker';

interface RebaseConflictDialogProps {
  worktreePath: string;
  conflictedFiles: string[];
  conflictingCommits?: { ours: string[]; theirs: string[] };
  agentModels: AgentModelOption[];
  selectedModel: string;
  isLoadingModels: boolean;
  onModelChange: (modelId: string) => void;
  onResolveWithAgent: (modelId: string) => void;
  resolveDisabled?: boolean;
  onCancel: () => void;
}

export function RebaseConflictDialog({
  worktreePath,
  conflictedFiles,
  conflictingCommits,
  agentModels,
  selectedModel,
  isLoadingModels,
  onModelChange,
  onResolveWithAgent,
  resolveDisabled = false,
  onCancel,
}: RebaseConflictDialogProps) {
  const { t } = useTranslation('agent');
  const dialogRef = useRef<HTMLDivElement>(null);

  // Close on escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  // Focus trap
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const worktreeName = getWorktreeNameFromPath(worktreePath, 'worktree');

  // Limit commits to show (max 5 each)
  const ourCommits = conflictingCommits?.ours?.slice(0, 5) || [];
  const theirCommits = conflictingCommits?.theirs?.slice(0, 5) || [];
  const hasMoreOurCommits = (conflictingCommits?.ours?.length || 0) > 5;
  const hasMoreTheirCommits = (conflictingCommits?.theirs?.length || 0) > 5;

  return (
    <div className="merge-conflict-dialog-overlay nim-overlay" onClick={onCancel}>
      <div
        className="merge-conflict-dialog w-full max-w-[760px] max-h-[calc(100vh-2rem)] mx-4 flex flex-col rounded-xl outline-none bg-[var(--nim-bg)] shadow-[0_8px_32px_rgba(0,0,0,0.24)]"
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="merge-conflict-dialog-header shrink-0 flex items-center gap-3 px-6 pt-5 pb-4 text-[var(--nim-text)]">
          <MaterialSymbol icon="warning" size={24} className="merge-conflict-dialog-icon-warning text-[var(--nim-warning)]" />
          <h2 className="m-0 text-lg font-semibold">{t('gitDialogs.rebaseConflict.title')}</h2>
        </div>

        <div className="merge-conflict-dialog-body flex-1 min-h-0 overflow-y-auto px-6 pb-5">
          <p className="m-0 mb-4 text-sm leading-relaxed text-[var(--nim-text-muted)]">
            <Trans t={t} i18nKey="gitDialogs.rebaseConflict.message" values={{ name: worktreeName }} components={{ strong: <strong className="text-[var(--nim-text)] font-medium" /> }} />
          </p>

          <div className="merge-conflict-dialog-files mb-4 p-3 rounded-lg bg-[var(--nim-bg-secondary)]">
            <div className="merge-conflict-dialog-files-header flex items-center gap-2 mb-2.5 text-[13px] font-medium text-[var(--nim-text)]">
              <MaterialSymbol icon="description" size={16} />
              <span>{t('gitDialogs.conflictedFiles')}</span>
            </div>
            <ul className="merge-conflict-dialog-files-list list-none m-0 p-0 flex flex-col gap-1.5">
              {conflictedFiles.map((file) => (
                <li key={file} className="merge-conflict-dialog-file flex items-center gap-2 text-[13px] text-[var(--nim-text-muted)]">
                  <MaterialSymbol icon="error" size={14} className="merge-conflict-dialog-file-icon text-[var(--nim-error)] shrink-0" />
                  <code className="font-[var(--nim-font-mono)] text-[var(--nim-text)] bg-transparent p-0">{file}</code>
                </li>
              ))}
            </ul>
          </div>

          {conflictingCommits && (ourCommits.length > 0 || theirCommits.length > 0) && (
            <div className="grid grid-cols-2 gap-3 mb-4">
              {ourCommits.length > 0 && (
                <div className="merge-conflict-dialog-files p-3 rounded-lg bg-[var(--nim-bg-secondary)]">
                  <div className="merge-conflict-dialog-files-header flex items-center gap-2 mb-2.5 text-[13px] font-medium text-[var(--nim-primary)]">
                    <MaterialSymbol icon="commit" size={16} />
                    <span>{t('gitDialogs.rebaseConflict.ourCommits')}</span>
                  </div>
                  <ul className="merge-conflict-dialog-files-list list-none m-0 p-0 flex flex-col gap-1.5 max-h-[150px] overflow-y-auto">
                    {ourCommits.map((commit, idx) => (
                      <li key={idx} className="merge-conflict-dialog-file flex items-center gap-2 text-[var(--nim-text-muted)]">
                        <MaterialSymbol icon="arrow_forward" size={14} />
                        <span className="text-xs">{commit}</span>
                      </li>
                    ))}
                    {hasMoreOurCommits && (
                      <li className="merge-conflict-dialog-file flex items-center gap-2 text-[var(--nim-text-muted)] italic opacity-70">
                        <MaterialSymbol icon="more_horiz" size={14} />
                        <span className="text-xs">
                          {t('gitDialogs.rebaseConflict.moreCommits', { count: (conflictingCommits?.ours?.length || 0) - 5 })}
                        </span>
                      </li>
                    )}
                  </ul>
                </div>
              )}

              {theirCommits.length > 0 && (
                <div className="merge-conflict-dialog-files p-3 rounded-lg bg-[var(--nim-bg-secondary)]">
                  <div className="merge-conflict-dialog-files-header flex items-center gap-2 mb-2.5 text-[13px] font-medium text-[var(--nim-success)]">
                    <MaterialSymbol icon="commit" size={16} />
                    <span>{t('gitDialogs.rebaseConflict.theirCommits')}</span>
                  </div>
                  <ul className="merge-conflict-dialog-files-list list-none m-0 p-0 flex flex-col gap-1.5 max-h-[150px] overflow-y-auto">
                    {theirCommits.map((commit, idx) => (
                      <li key={idx} className="merge-conflict-dialog-file flex items-center gap-2 text-[var(--nim-text-muted)]">
                        <MaterialSymbol icon="arrow_forward" size={14} />
                        <span className="text-xs">{commit}</span>
                      </li>
                    ))}
                    {hasMoreTheirCommits && (
                      <li className="merge-conflict-dialog-file flex items-center gap-2 text-[var(--nim-text-muted)] italic opacity-70">
                        <MaterialSymbol icon="more_horiz" size={14} />
                        <span className="text-xs">
                          {t('gitDialogs.rebaseConflict.moreCommits', { count: (conflictingCommits?.theirs?.length || 0) - 5 })}
                        </span>
                      </li>
                    )}
                  </ul>
                </div>
              )}
            </div>
          )}

          <div className="merge-conflict-dialog-info flex items-start gap-2.5 p-3 mb-4 rounded-lg bg-[var(--nim-info-light)] text-[var(--nim-info)] text-[13px] leading-snug">
            <MaterialSymbol icon="info" size={16} />
            <p className="m-0 text-[var(--nim-info)]">
              {t('gitDialogs.rebaseConflict.info')}
            </p>
          </div>

          <div className="merge-conflict-dialog-suggestion flex items-start gap-2.5 p-3 mb-4 rounded-lg bg-[var(--nim-success-light)] text-[var(--nim-success)] text-[13px] leading-snug">
            <MaterialSymbol icon="smart_toy" size={16} />
            <p className="m-0 text-[var(--nim-success)]">
              {t('gitDialogs.agentCanResolveConflicts')}
            </p>
          </div>

          <AgentModelPicker
            models={agentModels}
            selectedModel={selectedModel}
            onModelChange={onModelChange}
            isLoading={isLoadingModels}
          />

          <div className="merge-conflict-dialog-manual flex flex-col gap-2 p-3 rounded-lg bg-[var(--nim-bg-secondary)] text-[13px]">
            <p className="m-0 flex items-center gap-2 text-[var(--nim-text-muted)]">
              <MaterialSymbol icon="terminal" size={16} />
              {t('gitDialogs.worktreeLocation')}
            </p>
            <code className="merge-conflict-dialog-path block font-[var(--nim-font-mono)] text-xs text-[var(--nim-text)] bg-[var(--nim-bg-tertiary)] px-2 py-1.5 rounded break-all">{worktreePath}</code>
          </div>
        </div>

        <div className="merge-conflict-dialog-footer shrink-0 flex justify-end gap-2 px-6 pt-4 pb-5 border-t border-[var(--nim-border)]">
          <button
            type="button"
            className="merge-conflict-dialog-button merge-conflict-dialog-button--secondary nim-btn-secondary"
            onClick={onCancel}
          >
            {t('gitDialogs.close')}
          </button>
          <button
            type="button"
            className="merge-conflict-dialog-button merge-conflict-dialog-button--primary nim-btn-primary"
            onClick={() => onResolveWithAgent(selectedModel)}
            disabled={resolveDisabled}
          >
            <MaterialSymbol icon="smart_toy" size={16} />
            <span>{t('gitDialogs.resolveWithAgent')}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export default RebaseConflictDialog;
