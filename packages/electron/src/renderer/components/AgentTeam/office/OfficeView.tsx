/**
 * OfficeView - alternative presentation of the Team view (POC F1, alpha flag
 * `agent-team-view`, same as the Tree).
 *
 * Presentation only. It reads the delegation forest the Team view already
 * built, the per-session atoms the sidebar already uses and activeSessionIdAtom;
 * it calls no IPC, keeps no state of its own and has no action besides the
 * caller's `onSessionOpen`, the same select action the Tree and the kanban use.
 * The derivation rules live in officeModel.ts.
 */

import React, { useMemo } from 'react';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';
import { displayModel } from '../../AgenticCoding/SessionAttentionRow';
import { getProviderDisplayName } from '../../../utils/modelUtils';
import type { TeamTreeNode } from '../agentTeamGraph';
import { type OfficeMemberView, type OfficeRoomView } from './officeModel';
import { useOfficeRooms } from './useOfficeRooms';
import './OfficeView.css';

export interface OfficeViewProps {
  teams: TeamTreeNode[];
  onSessionOpen: (sessionId: string) => void;
}

const ROLE_INITIAL: Record<NonNullable<OfficeMemberView['role']>, string> = {
  coordinator: 'C',
  explorer: 'E',
  implementer: 'I',
  reviewer: 'R',
  architect: 'A',
  advisor: 'CI',
  other: 'M',
};

export function OfficeView({ teams, onSessionOpen }: OfficeViewProps) {
  const { t } = useTranslation('agent');
  const untitled = t('sessionItem.untitled');

  const rooms = useOfficeRooms(teams, untitled);
  const titleById = useMemo(() => {
    const titles = new Map<string, string>();
    for (const room of rooms) for (const member of room.members) titles.set(member.sessionId, member.title);
    return titles;
  }, [rooms]);
  const attention = rooms.flatMap((room) =>
    room.members
      .filter((member) => member.waitingUser !== null || member.principal === 'error')
      .map((member) => ({ room, member })),
  );

  if (rooms.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-[var(--nim-border)] px-4 py-6 text-center" data-testid="office-empty">
        <p className="m-0 text-sm text-[var(--nim-text)]">{t('agentTeam.emptyTeamsTitle')}</p>
        <p className="m-0 mt-1 text-xs text-[var(--nim-text-muted)]">{t('agentTeam.emptyTeamsHint')}</p>
      </div>
    );
  }

  return (
    <div className="office-view flex flex-col gap-4" data-testid="office-view">
      <section
        className={`office-attention rounded-md border px-4 py-3 ${attention.length > 0 ? 'border-[var(--nim-warning)]' : 'border-[var(--nim-border)]'}`}
        data-testid="office-attention"
      >
        <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-[var(--nim-text-muted)]">
          {t('agentTeam.office.attentionHeading', { total: attention.length })}
        </h3>
        {attention.length === 0 ? (
          <p className="m-0 mt-1 text-sm text-[var(--nim-text-muted)]" data-testid="office-attention-none">
            {t('agentTeam.office.attentionNone')}
          </p>
        ) : (
          <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
            {attention.map(({ room, member }) => (
              <li key={member.sessionId}>
                <button
                  type="button"
                  className="office-attention-item flex w-full cursor-pointer items-center gap-2 rounded border-none bg-transparent px-1 py-0.5 text-left text-sm text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                  data-testid={`office-attention-${member.sessionId}`}
                  title={t('agentTeam.openSession', { title: member.title })}
                  onClick={() => onSessionOpen(member.sessionId)}
                >
                  <span className="font-medium">{member.title}</span>
                  <span className="text-[var(--nim-text-faint)]">· {room.title}</span>
                  <span className="ml-auto shrink-0 text-xs text-[var(--nim-warning)]">
                    {member.waitingUser
                      ? member.waitingUser.map((kind) => t(`agentTeam.office.waiting.${kind}`)).join(', ')
                      : t('agentTeam.office.state.error')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {rooms.map((room) => (
        <OfficeRoom key={room.rootId} room={room} titleById={titleById} onSessionOpen={onSessionOpen} />
      ))}

      <p className="m-0 text-[11px] text-[var(--nim-text-faint)]" data-testid="office-scope-note">
        {t('agentTeam.office.scopeNote')}
      </p>
    </div>
  );
}

function OfficeRoom({
  room,
  titleById,
  onSessionOpen,
}: {
  room: OfficeRoomView;
  titleById: ReadonlyMap<string, string>;
  onSessionOpen: (sessionId: string) => void;
}) {
  const { t } = useTranslation('agent');
  const [root, ...members] = room.members;
  return (
    <section
      className="office-room rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-4"
      data-testid={`office-room-${room.rootId}`}
    >
      <header className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="m-0 truncate text-sm font-semibold text-[var(--nim-text)]" title={room.title}>
          {room.title}
        </h3>
        <span className="text-[11px] text-[var(--nim-text-muted)]" data-testid="office-room-summary">
          {[
            t('agentTeam.office.summary.working', { count: room.workingCount }),
            t('agentTeam.office.summary.waitingUser', { count: room.waitingUserCount }),
            room.errorCount > 0 ? t('agentTeam.office.summary.error', { count: room.errorCount }) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </header>
      <div className="office-desks flex flex-wrap gap-3">
        <OfficeDesk member={root} onSessionOpen={onSessionOpen} />
        {members.length > 0 && <span aria-hidden className="office-desks-divider" />}
        {members.map((member) => (
          <OfficeDesk
            key={member.sessionId}
            member={member}
            creatorTitle={member.createdBySessionId ? titleById.get(member.createdBySessionId) : undefined}
            onSessionOpen={onSessionOpen}
          />
        ))}
      </div>
    </section>
  );
}

function OfficeDesk({
  member,
  creatorTitle,
  onSessionOpen,
}: {
  member: OfficeMemberView;
  creatorTitle?: string;
  onSessionOpen: (sessionId: string) => void;
}) {
  const { t } = useTranslation('agent');
  const roleLabel = member.role ? t(`agentTeam.roles.${member.role}`) : null;
  // Same principal state, worded for an open turn that is stopped on the user.
  const stoppedOnYou = member.principal === 'working' && member.waitingUser !== null;
  const stateLabel = stoppedOnYou
    ? t('agentTeam.office.state.workingStoppedOnYou')
    : t(`agentTeam.office.state.${member.principal}`);
  const tooltip = [
    t('agentTeam.openSession', { title: member.title }),
    creatorTitle ? t('agentTeam.office.createdBy', { title: creatorTitle }) : null,
    member.isActiveSession ? t('agentTeam.office.activeSession') : null,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <button
      type="button"
      className={`office-desk flex w-[200px] cursor-pointer flex-col gap-1.5 rounded-md border bg-[var(--nim-bg)] px-3 py-2 text-left transition-colors hover:bg-[var(--nim-bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--nim-primary)] ${member.waitingUser ? 'border-[var(--nim-warning)] border-2' : member.isActiveSession ? 'border-[var(--nim-primary)]' : 'border-[var(--nim-border)]'} ${member.isActiveSession ? 'office-desk--active' : ''}`}
      aria-current={member.isActiveSession ? 'true' : undefined}
      data-testid={`office-desk-${member.sessionId}`}
      data-principal={member.principal}
      data-waiting-user={member.waitingUser ? member.waitingUser.join(',') : undefined}
      data-active-session={member.isActiveSession ? 'true' : undefined}
      data-role={member.role ?? undefined}
      title={tooltip}
      onClick={() => onSessionOpen(member.sessionId)}
    >
      <div className="flex w-full items-center gap-2">
        <span
          aria-hidden
          className={`office-avatar office-avatar--${member.role ?? 'none'} office-avatar--${member.principal}`}
        >
          {member.role ? ROLE_INITIAL[member.role] : '·'}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-[var(--nim-text)]">{member.title}</span>
          {roleLabel && <span className="block truncate text-[11px] text-[var(--nim-text-muted)]">{roleLabel}</span>}
        </span>
      </div>
      <div className="flex items-center gap-1.5 text-[11px]" data-testid="office-desk-state">
        <span
          aria-hidden
          className={`office-state-dot office-state-dot--${member.principal} ${stoppedOnYou ? 'office-state-dot--stopped' : ''}`}
        />
        <span className={`office-state-label office-state-label--${member.principal} ${stoppedOnYou ? 'office-state-label--stopped' : ''} font-medium`}>
          {stateLabel}
        </span>
      </div>
      {/* Mission as stored by the host, two lines at most; the whole text in the
          tooltip, same key as the Tree. Omitted when the session has none. */}
      {member.mission && (
        <div
          className="line-clamp-2 text-[11px] leading-snug text-[var(--nim-text-muted)]"
          title={t('agentTeam.missionTitle', { mission: member.mission })}
          data-testid="office-desk-mission"
        >
          {member.mission}
        </div>
      )}
      {member.waitingUser && (
        <div
          className="rounded bg-[var(--nim-bg-tertiary)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--nim-warning)]"
          data-testid="office-desk-waiting"
        >
          {t('agentTeam.office.waitingUser')}: {member.waitingUser.map((kind) => t(`agentTeam.office.waiting.${kind}`)).join(', ')}
        </div>
      )}
      <div className="truncate text-[10px] text-[var(--nim-text-faint)]" title={member.model ?? undefined}>
        {[getProviderDisplayName(member.provider), displayModel(member.model, member.provider), member.effortLevel]
          .filter(Boolean)
          .join(' · ')}
      </div>
    </button>
  );
}
