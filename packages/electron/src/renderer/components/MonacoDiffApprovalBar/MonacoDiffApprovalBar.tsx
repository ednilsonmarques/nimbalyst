/**
 * MonacoDiffApprovalBar - Approval UI for Monaco diff mode
 *
 * This component provides Accept All / Reject All buttons when
 * Monaco editor is in diff mode, showing AI-generated changes.
 *
 * Kept separate from the Lexical DiffApprovalBar to avoid coupling.
 */

import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { HelpTooltip } from '../../help';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';
import { t as translate } from '@nimbalyst/runtime/i18n';

export interface SessionInfo {
  sessionId: string;
  sessionTitle?: string;
  editedAt?: number;
}

export interface MonacoDiffApprovalBarProps {
  onAcceptAll: () => void;
  onRejectAll: () => void;
  fileName?: string;
  sessionInfo?: SessionInfo;
  onGoToSession?: (sessionId: string) => void;
}

/**
 * Format a timestamp as a relative time string (e.g., "2 hours ago")
 */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return translate('editor:diff.relativeTime.daysAgo', { count: days });
  }
  if (hours > 0) {
    return translate('editor:diff.relativeTime.hoursAgo', { count: hours });
  }
  if (minutes > 0) {
    return translate('editor:diff.relativeTime.minutesAgo', { count: minutes });
  }
  return translate('editor:diff.relativeTime.justNow');
}

export const MonacoDiffApprovalBar: React.FC<MonacoDiffApprovalBarProps> = ({
  onAcceptAll,
  onRejectAll,
  fileName,
  sessionInfo,
  onGoToSession,
}) => {
  const { t } = useTranslation('editor');
  const handleAcceptClick = () => {
    try {
      onAcceptAll();
    } catch (error) {
      console.error('[MonacoDiffApprovalBar] Error calling onAcceptAll:', error);
    }
  };

  const handleRejectClick = () => {
    onRejectAll();
  };

  const handleGoToSession = () => {
    if (sessionInfo?.sessionId && onGoToSession) {
      onGoToSession(sessionInfo.sessionId);
    }
  };

  // Render session-aware label if session info is provided
  const renderLabel = () => {
    if (sessionInfo?.sessionTitle) {
      return (
        <div className="monaco-diff-approval-bar-session flex items-center gap-2">
          <MaterialSymbol icon="smart_toy" size={18} className="monaco-diff-approval-bar-session-icon text-[var(--nim-primary)]" />
          <div className="monaco-diff-approval-bar-session-details flex flex-col gap-0.5">
            <span className="monaco-diff-approval-bar-label text-[13px] font-medium text-[var(--nim-text)]">
              <span className="monaco-diff-approval-bar-session-name font-semibold text-[var(--nim-primary)]">{sessionInfo.sessionTitle}</span>
              {' '}{t('diff.sessionEdited', { fileName: fileName || t('diff.fileFallback') })}
            </span>
            {sessionInfo.editedAt && (
              <span className="monaco-diff-approval-bar-timestamp text-[11px] text-[var(--nim-text-faint)]">
                {formatRelativeTime(sessionInfo.editedAt)}
              </span>
            )}
          </div>
        </div>
      );
    }

    // Fallback to original simple label
    return (
      <span className="monaco-diff-approval-bar-label text-[13px] font-medium text-[var(--nim-text)]">
        {t('diff.aiChangesTo', { fileName: fileName || t('diff.fileFallback') })}
      </span>
    );
  };

  return (
    <div className="monaco-diff-approval-bar sticky top-0 left-0 right-0 z-[100] bg-[var(--nim-bg-secondary)] border-b border-[var(--nim-border)] shadow-[0_2px_4px_rgba(0,0,0,0.1)] dark:shadow-[0_2px_4px_rgba(0,0,0,0.3)]">
      <div className="monaco-diff-approval-bar-content flex items-center justify-between px-4 py-2 gap-4">
        <div className="monaco-diff-approval-bar-info flex items-center gap-3">
          {renderLabel()}
          {sessionInfo?.sessionId && onGoToSession && (
            <button
              className="monaco-diff-approval-bar-goto flex items-center gap-1 px-2.5 py-1 bg-transparent border border-[var(--nim-border)] rounded text-[var(--nim-text-muted)] text-xs font-medium cursor-pointer transition-all duration-150 font-inherit whitespace-nowrap hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)] hover:border-[var(--nim-primary)]"
              onClick={handleGoToSession}
              type="button"
              title={t('diff.goToSessionTooltip')}
            >
              <MaterialSymbol icon="open_in_new" size={14} />
              {t('diff.goToSession')}
            </button>
          )}
        </div>
        <div className="monaco-diff-approval-bar-actions flex items-center gap-2">
          <HelpTooltip testId="diff-revert-all-button">
            <button
              className="monaco-diff-approval-bar-button monaco-diff-approval-bar-button-reject px-4 py-1.5 rounded text-[13px] font-medium cursor-pointer transition-all duration-150 border border-[var(--nim-border)] bg-[var(--nim-bg)] text-[var(--nim-text)] hover:opacity-85 hover:bg-[var(--nim-bg-hover)] active:scale-[0.98]"
              onClick={handleRejectClick}
              type="button"
              data-testid="diff-revert-all-button"
            >
              {t('diff.rejectAll')}
            </button>
          </HelpTooltip>
          <HelpTooltip testId="diff-keep-all-button">
            <button
              className="monaco-diff-approval-bar-button monaco-diff-approval-bar-button-accept px-4 py-1.5 rounded text-[13px] font-medium cursor-pointer transition-all duration-150 border border-[var(--nim-primary)] bg-[var(--nim-primary)] text-white hover:opacity-90 active:scale-[0.98]"
              onClick={handleAcceptClick}
              type="button"
              data-testid="diff-keep-all-button"
            >
              {t('diff.acceptAll')}
            </button>
          </HelpTooltip>
        </div>
      </div>
    </div>
  );
};
