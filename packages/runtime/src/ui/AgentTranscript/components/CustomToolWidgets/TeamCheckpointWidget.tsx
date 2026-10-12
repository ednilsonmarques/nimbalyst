/**
 * TeamCheckpointWidget
 *
 * Shown in a Team mode root's transcript when the team has created every
 * session it is authorized to. "Continue team" is the user's authorization to
 * create more: it goes through InteractiveWidgetHost.teamContinue (its own host
 * channel), never through the interactive-prompt answer path, so no session can
 * answer it on the user's behalf.
 *
 * Message format (nimbalyst_tool_use, written by the host):
 * {
 *   type: 'nimbalyst_tool_use',
 *   id: 'team-checkpoint-<rootSessionId>-8',
 *   name: 'TeamCheckpoint',
 *   input: { rootSessionId, created: 8, authorized: 8, extension: 4, maxActive: 3 }
 * }
 * Result once continued: { continued: true, authorized: 12 }
 *
 * TeamCheckpointBar is the same action docked at the bottom of the transcript:
 * later messages scroll the card away, and the pending checkpoint must stay
 * one click away.
 */

import React from 'react';
import type { CustomToolWidgetProps } from './index';
import { useTranslation } from '../../../../i18n/react';
import { readTeamCheckpointCard, useTeamContinue, type TeamCheckpointCard } from './teamCheckpointState';

export const TeamCheckpointWidget: React.FC<CustomToolWidgetProps> = ({ message, sessionId }) => {
  const card = readTeamCheckpointCard(message.toolCall);
  const { t } = useTranslation('ai');
  const { canContinue, continueTeam, isSubmitting, failed, continuedTo } = useTeamContinue(sessionId, card);
  if (!card) return null;

  const doneAuthorized = card.continuedTo ?? continuedTo;
  if (doneAuthorized !== null) {
    return (
      <div
        data-testid="team-checkpoint-widget"
        data-state="continued"
        className="team-checkpoint-widget rounded-lg bg-nim-secondary border border-nim overflow-hidden opacity-85"
      >
        <div className="flex items-center gap-2 py-3 px-4 bg-nim-tertiary">
          <span className="w-5 h-5 shrink-0 text-nim-success">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
              <path d="M13.5 4.5L6 12l-3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </span>
          <span data-testid="team-checkpoint-continued" className="text-sm font-semibold text-nim flex-1">
            {t('teamCheckpoint.continued', { authorized: doneAuthorized })}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="team-checkpoint-widget"
      data-state="pending"
      className="team-checkpoint-widget rounded-lg overflow-hidden border border-nim-primary bg-nim-secondary"
    >
      <div className="flex items-center gap-2 py-3 px-4 border-b border-nim bg-nim-tertiary">
        <span className="w-5 h-5 shrink-0 flex items-center justify-center text-nim-primary">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M8 11V8M8 5.5h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </span>
        <span className="text-sm font-semibold text-nim flex-1">{t('teamCheckpoint.title')}</span>
      </div>

      <div className="p-3 flex flex-col gap-2">
        <div className="text-xs text-nim leading-relaxed">
          {t('teamCheckpoint.reached', { created: card.created, authorized: card.authorized })}
        </div>
        <div className="text-xs text-nim-muted leading-relaxed">
          {t('teamCheckpoint.explain', { extension: card.extension, maxActive: card.maxActive })}
        </div>

        {failed && (
          <div data-testid="team-checkpoint-error" className="text-[11px] text-nim-error">
            {t('teamCheckpoint.failed')}
          </div>
        )}

        {canContinue ? (
          <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-nim">
            <button
              type="button"
              data-testid="team-checkpoint-continue"
              onClick={continueTeam}
              disabled={isSubmitting}
              className="px-3 py-1.5 rounded-md text-[11px] font-medium cursor-pointer border-none bg-nim-primary text-nim-on-primary whitespace-nowrap transition-all duration-150 hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? t('teamCheckpoint.continuing') : t('teamCheckpoint.continue')}
            </button>
          </div>
        ) : (
          <div
            data-testid="team-checkpoint-desktop-only"
            className="text-[11px] text-nim-muted bg-nim-tertiary border border-nim rounded px-2 py-1.5"
          >
            {t('teamCheckpoint.desktopOnly')}
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * The pending checkpoint, docked under the transcript for as long as it is
 * pending. It is the same checkpoint as the card (same level, same host call),
 * not a second authorization: once the card is continued the bar is gone.
 */
export const TeamCheckpointBar: React.FC<{ sessionId: string; card: TeamCheckpointCard }> = ({ sessionId, card }) => {
  const { t } = useTranslation('ai');
  const { canContinue, continueTeam, isSubmitting, failed, continuedTo } = useTeamContinue(sessionId, card);
  // Hosts that cannot continue a team (mobile) keep the card's own note only.
  if (!canContinue || continuedTo !== null) return null;

  return (
    <div
      data-testid="team-checkpoint-bar"
      className="team-checkpoint-bar shrink-0 flex items-center gap-3 border-t border-[var(--nim-border)] bg-[var(--nim-bg)] px-3 py-2"
    >
      <span className="flex-1 min-w-0 text-xs text-[var(--nim-text-muted)]">
        {failed ? t('teamCheckpoint.failed') : t('teamCheckpoint.bar', { created: card.created })}
      </span>
      <button
        type="button"
        data-testid="team-checkpoint-bar-continue"
        onClick={continueTeam}
        disabled={isSubmitting}
        className="shrink-0 px-3 py-1.5 bg-[var(--nim-primary)] text-[var(--nim-on-primary)] rounded-md text-xs font-medium cursor-pointer border-none hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isSubmitting ? t('teamCheckpoint.continuing') : t('teamCheckpoint.continue')}
      </button>
    </div>
  );
};
