import React, { memo } from 'react';
import { useAtomValue } from 'jotai';
import type { SessionMeta } from '@nimbalyst/runtime';
import { ProviderIcon } from '@nimbalyst/runtime/ui/icons/ProviderIcons';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';
import {
  sessionHasPendingInteractivePromptAtom,
  sessionOrChildProcessingAtom,
  sessionPendingPromptAtom,
  sessionUnreadAtom,
  sessionWakeupAtom,
} from '../../store/atoms/sessions';
import { sessionAgentWakePendingAtom } from '../../store/atoms/teamInbox';
import { SessionStatusIndicator } from '../AgenticCoding/SessionListItem';
import { displayModel } from '../AgenticCoding/SessionAttentionRow';
import { WorktreeIcon } from '../common/WorktreeIcon';
import { getProviderDisplayName } from '../../utils/modelUtils';
import type { TeamWorktreeInfo } from './teamDataSource';
import { isTeamRoot, teamMemberRole } from './teamMembership';

export type AgentTeamNodeStatus =
  | 'awaitingYou'
  | 'running'
  | 'messagePending'
  | 'queued'
  | 'scheduled'
  | 'unread'
  | 'idle';

/**
 * Text status from the same live atoms, in the same priority, as the
 * SessionStatusIndicator icon next to it, so the two never disagree. Only states
 * the runtime actually reports; no error/paused/blocked.
 */
function useNodeStatus(sessionId: string): AgentTeamNodeStatus {
  const awaitingYou = useAtomValue(sessionHasPendingInteractivePromptAtom(sessionId));
  const running = useAtomValue(sessionOrChildProcessingAtom(sessionId));
  const messagePending = useAtomValue(sessionAgentWakePendingAtom(sessionId));
  const queued = useAtomValue(sessionPendingPromptAtom(sessionId));
  const wakeup = useAtomValue(sessionWakeupAtom(sessionId));
  const unread = useAtomValue(sessionUnreadAtom(sessionId));
  if (awaitingYou) return 'awaitingYou';
  if (running) return 'running';
  if (messagePending) return 'messagePending';
  if (queued) return 'queued';
  if (wakeup) return 'scheduled';
  if (unread) return 'unread';
  return 'idle';
}

const STATUS_TEXT_CLASS: Record<AgentTeamNodeStatus, string> = {
  awaitingYou: 'text-[var(--nim-warning)]',
  running: 'text-[var(--nim-primary)]',
  messagePending: 'text-[var(--nim-warning)]',
  queued: 'text-[var(--nim-warning)]',
  scheduled: 'text-[var(--nim-primary)]',
  unread: 'text-[var(--nim-primary)]',
  idle: 'text-[var(--nim-text-faint)]',
};

export interface AgentTeamNodeProps {
  session: SessionMeta;
  worktree?: TeamWorktreeInfo;
  creatorOutsideView?: boolean;
  onOpen: (sessionId: string) => void;
  /** Root of a team tree: the coordinator, drawn apart from its members. */
  isRoot?: boolean;
}

export const AgentTeamNode = memo(function AgentTeamNode({
  session,
  worktree,
  creatorOutsideView,
  onOpen,
  isRoot,
}: AgentTeamNodeProps) {
  const { t } = useTranslation('agent');
  const status = useNodeStatus(session.id);
  const title = session.title || t('sessionItem.untitled');
  const provider = session.provider;
  const worktreeLabel = worktree ? worktree.branch || worktree.displayName || worktree.name : null;
  // Role comes from the session's own team metadata, never from its title.
  const isCoordinator = !!isRoot && isTeamRoot(session);
  const roleKey = isCoordinator ? 'coordinator' : session.teamRole ? teamMemberRole(session) : null;
  // A team member without a stored scope has full tools; outside a team the scope is not shown.
  const scopeKey = session.toolScope ?? (session.teamRole ? 'full' : null);
  const scopeLabel = scopeKey && ['read', 'review', 'write', 'full'].includes(scopeKey)
    ? t(`agentTeam.scope.${scopeKey}`)
    : scopeKey;

  return (
    <button
      type="button"
      className={`agent-team-node flex w-[240px] flex-col gap-1 rounded-md border bg-[var(--nim-bg-secondary)] px-3 py-2 text-left cursor-pointer transition-colors hover:bg-[var(--nim-bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--nim-primary)] ${status === 'awaitingYou' ? 'border-[var(--nim-warning)]' : isCoordinator ? 'border-[var(--nim-primary)] border-2' : 'border-[var(--nim-border)] hover:border-[var(--nim-primary)]'}`}
      data-testid={`agent-team-node-${session.id}`}
      data-status={status}
      data-team-role={roleKey ?? undefined}
      // No aria-label: the card's own text (title, status, model, branch) is its
      // accessible name; the open hint stays a tooltip.
      title={t('agentTeam.openSession', { title })}
      onClick={() => onOpen(session.id)}
    >
      <div className="flex w-full items-center gap-2">
        {/* Icons are decorative here: their ligature text would otherwise leak into
            the button's accessible name, and the status is spelled out below. */}
        <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--nim-text-muted)]">
          <ProviderIcon provider={provider} size={14} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--nim-text)]" title={title}>
          {title}
        </span>
        <span aria-hidden className="flex shrink-0">
          <SessionStatusIndicator sessionId={session.id} />
        </span>
      </div>

      <div className="flex w-full items-center gap-1.5 text-[11px]">
        <span className={`agent-team-node-status font-medium ${STATUS_TEXT_CLASS[status]}`}>
          {t(`agentTeam.status.${status}`)}
        </span>
        {roleKey ? (
          <span
            className={`agent-team-node-role ml-auto shrink-0 rounded px-1.5 py-px text-[10px] font-medium ${isCoordinator ? 'bg-[var(--nim-primary)] text-[var(--nim-on-primary,#fff)]' : 'bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)]'}`}
            data-testid="agent-team-node-role"
          >
            {t(`agentTeam.roles.${roleKey}`)}
          </span>
        ) : session.agentRole === 'meta-agent' && (
          <span className="ml-auto shrink-0 rounded bg-[var(--nim-bg-tertiary)] px-1.5 py-px text-[10px] text-[var(--nim-text-muted)]">
            {t('agentTeam.metaAgentRole')}
          </span>
        )}
      </div>

      <div className="flex w-full min-w-0 items-center gap-1 text-[11px] text-[var(--nim-text-faint)]">
        <span className="truncate" title={session.model ?? undefined}>
          {displayModel(session.model, provider)}
        </span>
        {session.effortLevel && (
          <>
            <span aria-hidden>·</span>
            <span className="shrink-0" title={t('agentTeam.effortTitle', { effort: session.effortLevel })} data-testid="agent-team-node-effort">
              {session.effortLevel}
            </span>
          </>
        )}
        {scopeKey && (
          <>
            <span aria-hidden>·</span>
            <span className="shrink-0" title={t('agentTeam.scopeTitle', { scope: scopeLabel })} data-testid="agent-team-node-scope">
              {scopeLabel}
            </span>
          </>
        )}
        {!session.effortLevel && !scopeKey && (
          <>
            <span aria-hidden>·</span>
            <span className="shrink-0">{getProviderDisplayName(provider)}</span>
          </>
        )}
      </div>

      {/* The member's mission (teamChild.mission): one truncated line, the whole
          text in the tooltip. Display only; the role and scope above are the policy. */}
      {roleKey && !isCoordinator && session.teamMission && (
        <div
          className="flex w-full min-w-0 items-center gap-1 text-[11px] text-[var(--nim-text-muted)]"
          title={t('agentTeam.missionTitle', { mission: session.teamMission })}
          data-testid="agent-team-node-mission"
        >
          <span aria-hidden className="flex shrink-0"><MaterialSymbol icon="flag" size={12} /></span>
          <span className="truncate">{session.teamMission}</span>
        </div>
      )}

      {session.worktreeId && worktreeLabel && (
        <div className="flex w-full min-w-0 items-center gap-1 text-[11px] text-[var(--nim-text-faint)]" title={worktreeLabel}>
          <span aria-hidden className="flex shrink-0"><WorktreeIcon size={12} /></span>
          <span className="truncate">{worktreeLabel}</span>
        </div>
      )}

      {creatorOutsideView && (
        <div className="flex w-full items-center gap-1 text-[10px] text-[var(--nim-text-faint)]">
          <span aria-hidden className="flex shrink-0"><MaterialSymbol icon="call_received" size={12} /></span>
          <span className="truncate">{t('agentTeam.creatorOutsideView')}</span>
        </div>
      )}
    </button>
  );
});
