/**
 * CustomEditorAIEditedBar
 *
 * A simple notification bar for custom editors that don't support diff mode.
 * Shows that the file was AI-edited with a button to view the diff in history.
 */

import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import type { SessionInfo } from './DiffCapabilities';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';
import { t as translate } from '@nimbalyst/runtime/i18n';

export interface CustomEditorAIEditedBarProps {
  fileName: string;
  sessionInfo?: SessionInfo;
  onGoToSession?: (sessionId: string) => void;
  onViewHistory?: () => void;
}

/**
 * Format a timestamp as a relative time string
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

export const CustomEditorAIEditedBar: React.FC<CustomEditorAIEditedBarProps> = ({
  fileName,
  sessionInfo,
  onGoToSession,
  onViewHistory,
}) => {
  const { t } = useTranslation('editor');
  const handleGoToSession = () => {
    if (sessionInfo?.sessionId && onGoToSession) {
      onGoToSession(sessionInfo.sessionId);
    }
  };

  return (
    <div className="unified-diff-header sticky top-0 left-0 right-0 z-[100] border-b border-[var(--nim-border)] shadow-[0_2px_4px_rgba(0,0,0,0.1)] dark:shadow-[0_2px_4px_rgba(0,0,0,0.3)] bg-[var(--nim-bg-secondary)]">
      <div className="unified-diff-header-content flex items-center justify-between py-2 px-4 gap-4 min-h-[48px]">
        {/* Left section: AI edited info */}
        <div className="unified-diff-header-info flex items-center gap-3 shrink min-w-0 overflow-hidden">
          {sessionInfo?.sessionTitle ? (
            <div className="unified-diff-header-session flex items-center gap-1.5 text-[13px] text-[var(--nim-text)] min-w-0 overflow-hidden">
              <MaterialSymbol icon="smart_toy" size={18} className="unified-diff-header-session-icon shrink-0" />
              <div className="unified-diff-header-session-details flex items-center gap-1.5 min-w-0">
                <span className="unified-diff-header-label flex items-center gap-2 text-[13px] font-medium text-[var(--nim-text)]">
                  <span className="unified-diff-header-session-name font-semibold text-[var(--nim-primary)] overflow-hidden text-ellipsis whitespace-nowrap">{sessionInfo.sessionTitle}</span>
                  {' '}{t('diff.sessionEdited', { fileName: fileName || t('diff.fileFallback') })}
                </span>
                {sessionInfo.editedAt && (
                  <span className="unified-diff-header-timestamp text-[var(--nim-text-faint)] shrink-0 before:content-['\00b7'] before:mr-1.5">
                    {formatRelativeTime(sessionInfo.editedAt)}
                  </span>
                )}
              </div>
            </div>
          ) : (
            <span className="unified-diff-header-label flex items-center gap-2 text-[13px] font-medium text-[var(--nim-text)]">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="unified-diff-header-sparkle shrink-0">
                <path d="M8 1L9 5L13 6L9 7L8 11L7 7L3 6L7 5L8 1Z" fill="currentColor"/>
              </svg>
              {t('diff.aiEdited', { fileName: fileName || t('diff.fileFallback') })}
            </span>
          )}
          {sessionInfo?.sessionId && onGoToSession && (
            <button
              className="unified-diff-header-goto flex items-center gap-1 px-2 py-1 bg-transparent border-none rounded text-[13px] text-[var(--nim-text-muted)] cursor-pointer transition-colors duration-150 hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
              onClick={handleGoToSession}
              type="button"
              title={t('diff.goToSessionTooltip')}
            >
              <MaterialSymbol icon="open_in_new" size={14} />
              {t('diff.goToSession')}
            </button>
          )}
        </div>

        {/* Right section: View History button */}
        <div className="unified-diff-header-actions flex items-center gap-2 ml-auto shrink-0">
          {onViewHistory && (
            <button
              className="unified-diff-header-button unified-diff-header-button-accept py-1.5 px-3 rounded-md text-[13px] font-medium cursor-pointer transition-all duration-150 border border-[var(--nim-primary)] flex items-center gap-1.5 whitespace-nowrap bg-[var(--nim-primary)] text-white hover:enabled:opacity-90 active:enabled:scale-[0.98]"
              onClick={onViewHistory}
              type="button"
              title={t('diff.viewHistoryTooltip')}
            >
              <MaterialSymbol icon="history" size={16} />
              {t('diff.viewHistory')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
