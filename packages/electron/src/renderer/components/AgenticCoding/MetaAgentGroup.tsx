/**
 * MetaAgentGroup - Displays a meta-agent session and its child sessions in the session history.
 * A Team mode root uses the same group: its members nest under it, the header
 * says "Team" with the member and active counts (or "Solo"), and each member
 * row carries its role.
 *
 * Follows the same visual patterns as SuperLoopGroup and BlitzGroup:
 * - Flat list item (no card/border)
 * - Parent-controlled expand/collapse
 * - Active session highlighting
 * - Child session rows
 */

import React, { memo, useCallback, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { ProviderIcon } from '@nimbalyst/runtime/ui/icons/ProviderIcons';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';
import {
  groupSessionStatusAtom,
  sessionProcessingAtom,
  sessionUnreadAtom,
  sessionPendingPromptAtom,
  type SessionMeta,
} from '../../store';
import { SessionRelativeTime } from './SessionRelativeTime';
import { SessionContextMenu } from './SessionContextMenu';
import { sessionAgentWakePendingAtom } from '../../store/atoms/teamInbox';
import { isTeamRoot, teamMemberRole } from '../AgentTeam/teamMembership';
import { TeamSummaryLine } from '../AgentTeam/TeamSummaryLine';

interface MetaAgentGroupProps {
  metaSession: SessionMeta;
  childSessions: SessionMeta[];
  /** Whole team for the summary line, when `childSessions` is narrowed by a search. */
  summaryMembers?: SessionMeta[];
  isExpanded: boolean;
  isActive: boolean;
  isSelected?: boolean;
  onToggle: () => void;
  onMultiSelect?: (e: React.MouseEvent) => void;
  activeSessionId: string | null;
  onSessionSelect: (sessionId: string, e: Pick<React.MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>) => void;
  onSessionArchive?: (sessionId: string) => void;
  onSessionUnarchive?: (sessionId: string) => void;
  onSessionDelete?: (sessionId: string) => void;
  onMetaSessionArchive?: (sessionId: string) => void;
  onMetaSessionUnarchive?: (sessionId: string) => void;
  onMetaSessionDelete?: (sessionId: string) => void;
  onSessionPinToggle?: (sessionId: string, isPinned: boolean) => void;
  onSessionBranch?: (sessionId: string) => void;
  onWorktreeArchive?: (worktreeId: string) => void;
}

const UntitledSessionLabel: React.FC = () => {
  const { t } = useTranslation('agent');
  return <>{t('sessionItem.untitled')}</>;
};

/**
 * Aggregate status indicator for the meta-agent group header.
 */
const MetaAgentGroupStatus: React.FC<{ sessionIds: string[] }> = memo(({ sessionIds }) => {
  const sessionIdsKey = useMemo(() => JSON.stringify([...sessionIds].sort()), [sessionIds]);
  const groupStatus = useAtomValue(groupSessionStatusAtom(sessionIdsKey));
  const { t } = useTranslation('agent');

  if (groupStatus.hasProcessing) {
    return (
      <div className="flex items-center justify-center text-[var(--nim-primary)]" title={t('sessionItem.processingShort')}>
        <MaterialSymbol icon="progress_activity" size={12} className="animate-spin" />
      </div>
    );
  }
  if (groupStatus.hasPendingPrompt) {
    return (
      <div className="flex items-center justify-center text-[var(--nim-warning)] animate-pulse" title={t('sessionItem.waitingForResponse')}>
        <MaterialSymbol icon="help" size={12} />
      </div>
    );
  }
  if (groupStatus.hasUnread) {
    return (
      <div className="flex items-center justify-center text-[var(--nim-primary)]" title={t('sessionItem.unread')}>
        <MaterialSymbol icon="circle" size={6} fill />
      </div>
    );
  }
  return null;
});

/**
 * Per-session status indicator for child session rows.
 */
const ChildSessionStatus: React.FC<{ sessionId: string }> = memo(({ sessionId }) => {
  const isProcessing = useAtomValue(sessionProcessingAtom(sessionId));
  const hasPendingPrompt = useAtomValue(sessionPendingPromptAtom(sessionId));
  const hasAgentWakePending = useAtomValue(sessionAgentWakePendingAtom(sessionId));
  const hasUnread = useAtomValue(sessionUnreadAtom(sessionId));
  const { t } = useTranslation('agent');

  if (isProcessing) {
    return (
      <div className="flex items-center justify-center text-[var(--nim-primary)] animate-spin" title={t('sessionItem.processing')}>
        <MaterialSymbol icon="progress_activity" size={12} />
      </div>
    );
  }
  if (hasAgentWakePending) {
    return <MaterialSymbol icon="hourglass_top" size={12} />;
  }
  if (hasPendingPrompt) {
    return (
      <div className="flex items-center justify-center text-[var(--nim-warning)]" title={t('sessionItem.waitingForResponse')}>
        <MaterialSymbol icon="help" size={12} />
      </div>
    );
  }
  if (hasUnread) {
    return (
      <div className="flex items-center justify-center text-[var(--nim-primary)]" title={t('sessionItem.unread')}>
        <MaterialSymbol icon="circle" size={6} fill />
      </div>
    );
  }
  return null;
});

/**
 * Child session row matching SuperIterationRow / BlitzSessionRow style.
 */
const MetaAgentChildRow: React.FC<{
  session: SessionMeta;
  isActive: boolean;
  onSelect: (e: Pick<React.MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  /** Team member role label; absent for meta-agent children. */
  roleLabel?: string;
}> = memo(({ session, isActive, onSelect, onContextMenu, roleLabel }) => (
  <div
    className={`meta-agent-child-item flex items-center gap-2 py-1.5 px-3 mr-2 mb-0.5 cursor-pointer rounded transition-colors duration-150 select-none ${
      isActive ? 'bg-[var(--nim-bg-selected)]' : 'hover:bg-[var(--nim-bg-hover)]'
    } focus:outline-2 focus:outline-[var(--nim-border-focus)] focus:outline-offset-[-2px]`}
    onClick={onSelect}
    onContextMenu={onContextMenu}
    role="button"
    tabIndex={0}
    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(e); } }}
    aria-label={roleLabel ? `${roleLabel}: ${session.title}` : session.title}
    aria-current={isActive ? 'page' : undefined}
    data-team-role={session.teamRole}
  >
    <div className={`shrink-0 flex items-center justify-center ${
      isActive ? 'text-[var(--nim-primary)]' : 'text-[var(--nim-text-muted)]'
    }`}>
      <ProviderIcon provider={session.provider || 'claude-code'} size={14} />
    </div>
    {roleLabel && (
      <span className="shrink-0 text-[0.625rem] px-1.5 py-[0.0625rem] rounded bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)] font-medium" data-testid="team-member-role">
        {roleLabel}
      </span>
    )}
    <span className={`flex-1 text-xs text-[var(--nim-text)] whitespace-nowrap overflow-hidden text-ellipsis ${
      isActive ? 'font-medium' : ''
    }`}>
      {session.title || <UntitledSessionLabel />}
    </span>
    <span className="shrink-0 text-[0.6875rem] text-[var(--nim-text-faint)] ml-2">
      <SessionRelativeTime sessionId={session.id} fallbackTimestamp={session.updatedAt || session.createdAt} />
    </span>
    <div className="shrink-0 flex items-center">
      <ChildSessionStatus sessionId={session.id} />
    </div>
  </div>
));

export const MetaAgentGroup: React.FC<MetaAgentGroupProps> = memo(({
  metaSession,
  childSessions,
  summaryMembers,
  isExpanded,
  isActive,
  isSelected,
  onToggle,
  onMultiSelect,
  activeSessionId,
  onSessionSelect,
  onSessionArchive,
  onSessionUnarchive,
  onSessionDelete,
  onMetaSessionArchive,
  onMetaSessionUnarchive,
  onMetaSessionDelete,
  onSessionPinToggle,
  onSessionBranch,
  onWorktreeArchive,
}) => {
  const { t } = useTranslation('agent');
  const [contextMenuSession, setContextMenuSession] = useState<SessionMeta | null>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });

  const allSessionIds = useMemo(
    () => [metaSession.id, ...childSessions.map(s => s.id)],
    [metaSession.id, childSessions]
  );

  const openContextMenu = useCallback((session: SessionMeta, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenuSession(session);
    setContextMenuPosition({ x: e.clientX, y: e.clientY });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenuSession(null);
  }, []);

  const isTeam = isTeamRoot(metaSession);
  // The group root (meta-agent or Team mode root) is archived, restored and
  // deleted together with its group.
  const isGroupRoot = useCallback((session: SessionMeta) => session.id === metaSession.id, [metaSession.id]);

  const handleArchive = useCallback((session: SessionMeta) => {
    if (isGroupRoot(session)) {
      onMetaSessionArchive?.(session.id);
      return;
    }
    if (session.worktreeId && onWorktreeArchive) {
      onWorktreeArchive(session.worktreeId);
      return;
    }
    onSessionArchive?.(session.id);
  }, [isGroupRoot, onMetaSessionArchive, onSessionArchive, onWorktreeArchive]);

  const handleUnarchive = useCallback((session: SessionMeta) => {
    if (isGroupRoot(session)) {
      onMetaSessionUnarchive?.(session.id);
      return;
    }
    onSessionUnarchive?.(session.id);
  }, [isGroupRoot, onMetaSessionUnarchive, onSessionUnarchive]);

  const handleDelete = useCallback((session: SessionMeta) => {
    if (isGroupRoot(session)) {
      onMetaSessionDelete?.(session.id);
      return;
    }
    onSessionDelete?.(session.id);
  }, [isGroupRoot, onMetaSessionDelete, onSessionDelete]);

  return (
    <div
      data-testid="meta-agent-group"
      data-meta-session-id={metaSession.id}
      data-group-kind={isTeam ? 'team' : 'metaAgent'}
    >
      {/* Group header */}
      <div
        className={`meta-agent-group-header flex items-center gap-1.5 py-1.5 px-2 mr-2 cursor-pointer rounded transition-colors duration-150 select-none ${
          isActive ? 'bg-[var(--nim-bg-selected)]' : isSelected ? 'bg-[var(--nim-bg-selected)]' : 'hover:bg-[var(--nim-bg-hover)]'
        }`}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey) {
            onMultiSelect?.(e);
          } else {
            onSessionSelect(metaSession.id, e);
          }
        }}
        onContextMenu={(e) => openContextMenu(metaSession, e)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSessionSelect(metaSession.id, e);
          }
        }}
        aria-expanded={isExpanded}
        data-testid="meta-agent-group-header"
      >
        {/* Expand/collapse chevron */}
        <button
          className={`shrink-0 flex items-center justify-center w-4 h-4 bg-transparent border-none text-[var(--nim-text-muted)] cursor-pointer p-0 ${
            isTeam && childSessions.length === 0 ? 'invisible' : ''
          }`}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          aria-label={isExpanded ? t('common.collapse') : t('common.expand')}
        >
          <MaterialSymbol
            icon="chevron_right"
            size={14}
            className={`transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
          />
        </button>

        {/* Hub icon */}
        <div className={`shrink-0 flex items-center justify-center ${
          isActive ? 'text-[var(--nim-primary)]' : 'text-[var(--nim-text-muted)]'
        }`}>
          <MaterialSymbol icon={isTeam ? 'groups' : 'hub'} size={16} fill={isActive} />
        </div>

        {/* Title (a team also says what it is: members and how many are active, or Solo) */}
        <div className="flex min-w-0 flex-1 flex-col">
          <span className={`text-xs whitespace-nowrap overflow-hidden text-ellipsis ${
            isActive ? 'font-medium text-[var(--nim-text)]' : 'text-[var(--nim-text)]'
          }`}>
            {metaSession.title || (isTeam ? t('sessionItem.untitled') : t('metaAgent.defaultTitle'))}
          </span>
          {isTeam && (
            <TeamSummaryLine
              members={summaryMembers ?? childSessions}
              className="text-[0.625rem] leading-tight text-[var(--nim-text-faint)] whitespace-nowrap overflow-hidden text-ellipsis"
            />
          )}
        </div>

        {/* Child count badge (a team states its count in the summary line) */}
        {!isTeam && childSessions.length > 0 && (
          <span className="shrink-0 text-[0.5625rem] px-1.5 py-[0.0625rem] rounded-[0.625rem] bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)] font-medium">
            {childSessions.length}
          </span>
        )}

        {/* Timestamp */}
        <span className="shrink-0 text-[0.6875rem] text-[var(--nim-text-faint)]">
          <SessionRelativeTime sessionId={metaSession.id} fallbackTimestamp={metaSession.updatedAt || metaSession.createdAt} />
        </span>

        {/* Aggregate status */}
        <div className="shrink-0 flex items-center">
          <MetaAgentGroupStatus sessionIds={allSessionIds} />
        </div>
      </div>

      {/* Child sessions */}
      {isExpanded && childSessions.length > 0 && (
        <div className="pl-5" data-testid="meta-agent-children">
          {childSessions.map((session) => (
            <MetaAgentChildRow
              key={session.id}
              session={session}
              isActive={activeSessionId === session.id}
              onSelect={(e) => onSessionSelect(session.id, e)}
              onContextMenu={(e) => openContextMenu(session, e)}
              roleLabel={isTeam ? t(`agentTeam.roles.${teamMemberRole(session)}`) : undefined}
            />
          ))}
        </div>
      )}

      {contextMenuSession && (
        <SessionContextMenu
          sessionId={contextMenuSession.id}
          title={contextMenuSession.title || t('sessionItem.untitled')}
          position={contextMenuPosition}
          onClose={closeContextMenu}
          isArchived={contextMenuSession.isArchived}
          isPinned={contextMenuSession.isPinned}
          phase={contextMenuSession.phase}
          parentSessionId={contextMenuSession.parentSessionId}
          onPinToggle={onSessionPinToggle ? (isPinned) => onSessionPinToggle(contextMenuSession.id, isPinned) : undefined}
          onBranch={contextMenuSession.agentRole === 'meta-agent' ? undefined : onSessionBranch ? () => onSessionBranch(contextMenuSession.id) : undefined}
          onArchive={!contextMenuSession.isArchived ? () => handleArchive(contextMenuSession) : undefined}
          onUnarchive={contextMenuSession.isArchived ? () => handleUnarchive(contextMenuSession) : undefined}
          onDelete={
            (isGroupRoot(contextMenuSession) && onMetaSessionDelete)
            || (!isGroupRoot(contextMenuSession) && onSessionDelete)
              ? () => handleDelete(contextMenuSession)
              : undefined
          }
        />
      )}
    </div>
  );
});
