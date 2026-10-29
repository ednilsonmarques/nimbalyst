/**
 * TeamFrontProposalWidget
 *
 * Shown in a Team mode root's transcript when its coordinator proposes fronts
 * (team_front_propose, F1.1). The user approves, edits or rejects each item and
 * sends ONE decision; the host then writes what was approved. The decision goes
 * through InteractiveWidgetHost.teamFrontProposalDecide (its own host channel),
 * never through the interactive-prompt answer path, so no session can approve a
 * proposal on the user's behalf.
 *
 * Every string the coordinator wrote (titles, descriptions, mission names) is
 * rendered as plain text: React text nodes and form values only, never markdown
 * or HTML.
 *
 * Message format (nimbalyst_tool_use, written by the host):
 * {
 *   type: 'nimbalyst_tool_use',
 *   id: 'team-front-proposal-<proposalId>',
 *   name: 'TeamFrontProposal',
 *   input: { proposalId, rootSessionId, items: [{ action: 'create', title, description, status }
 *                                                | { action: 'status', frontId, frontTitle, fromStatus, status, activeMission }] }
 * }
 * Result once decided: { decided: true, results: [{ index, action, label, result, id?, status?, code?, syncWarning? }] }
 */

import React, { useState } from 'react';
import type { CustomToolWidgetProps } from './index';
import { useTranslation } from '../../../../i18n/react';
import {
  TEAM_FRONT_DESCRIPTION_MAX,
  TEAM_FRONT_STATUS_VALUES,
  TEAM_FRONT_TITLE_MAX,
  effectiveItem,
  itemProblem,
  readTeamFrontProposalCard,
  useTeamFrontProposal,
  type CardItem,
  type ItemDecision,
  type ItemEdits,
} from './teamFrontProposalState';
import type { TeamFrontItemOutcome } from './InteractiveWidgetHost';

const KNOWN_REFUSAL_CODES = [
  'duplicate-title', 'front-not-found', 'front-not-changeable', 'no-change',
  'close-with-active-mission', 'mission-started-after-card', 'write-failed',
];

const buttonBase = 'px-3 py-1.5 rounded-md text-[11px] font-medium cursor-pointer whitespace-nowrap transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed';
const primaryButton = `${buttonBase} border-none bg-nim-primary text-nim-on-primary hover:opacity-90`;
const quietButton = `${buttonBase} border border-nim bg-nim-secondary text-nim hover:bg-nim-tertiary`;

export const TeamFrontProposalWidget: React.FC<CustomToolWidgetProps> = ({ message, sessionId }) => {
  const card = readTeamFrontProposalCard(message.toolCall);
  const { t } = useTranslation('ai');
  const state = useTeamFrontProposal(sessionId, card);
  const [editing, setEditing] = useState<ReadonlySet<number>>(new Set());
  if (!card) return null;

  const status = (value: string | null) => {
    if (!value) return t('teamFrontProposal.noStatus');
    // Any status outside active/paused/closed is shown as unknown, never as the raw value.
    return (TEAM_FRONT_STATUS_VALUES as readonly string[]).includes(value) ? t(`teamFrontProposal.status.${value}`) : t('teamFrontProposal.status.unknown');
  };
  const outcome = card.outcome ?? state.results;

  if (outcome) {
    return (
      <div data-testid="team-front-proposal-widget" data-state="decided" className="team-front-proposal-widget rounded-lg bg-nim-secondary border border-nim overflow-hidden opacity-90">
        <div className="flex items-center gap-2 py-3 px-4 bg-nim-tertiary">
          <span className="text-sm font-semibold text-nim flex-1">{t('teamFrontProposal.decidedTitle')}</span>
        </div>
        <ul className="p-3 flex flex-col gap-1.5 list-none m-0">
          {outcome.map((entry) => (
            <li key={entry.index} data-testid={`team-front-proposal-result-${entry.index}`} data-result={entry.result} className="text-xs text-nim leading-relaxed">
              <ResultLine entry={entry} t={t} status={status} />
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (state.remote === 'expired') {
    return (
      <div data-testid="team-front-proposal-widget" data-state="expired" className="team-front-proposal-widget rounded-lg bg-nim-secondary border border-nim overflow-hidden opacity-85">
        <div className="py-3 px-4 bg-nim-tertiary text-sm font-semibold text-nim">{t('teamFrontProposal.title')}</div>
        <div data-testid="team-front-proposal-expired" className="p-3 text-xs text-nim-muted leading-relaxed">{t('teamFrontProposal.expired')}</div>
      </div>
    );
  }

  const toggleEditing = (index: number) =>
    setEditing((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  const allDecided = state.decisions.every((d) => d !== null);
  const anyApprovedProblem = card.items.some((item, index) => state.decisions[index] === 'approve' && itemProblem(item, state.edits[index]) !== null);

  return (
    <div data-testid="team-front-proposal-widget" data-state="pending" className="team-front-proposal-widget rounded-lg overflow-hidden border border-nim-primary bg-nim-secondary">
      <div className="flex items-center gap-2 py-3 px-4 border-b border-nim bg-nim-tertiary">
        <span className="text-sm font-semibold text-nim flex-1">{t('teamFrontProposal.title')}</span>
      </div>

      <div className="p-3 flex flex-col gap-3">
        <div className="text-xs text-nim-muted leading-relaxed">{t('teamFrontProposal.intro', { count: card.items.length })}</div>

        {card.items.map((item, index) => (
          <ProposalItem
            key={index}
            index={index}
            item={item}
            decision={state.decisions[index]}
            edits={state.edits[index]}
            editing={editing.has(index)}
            disabled={state.isSubmitting || state.remote !== 'pending'}
            onDecide={(value) => state.decide(index, value)}
            onEdit={(patch) => state.edit(index, patch)}
            onToggleEdit={() => toggleEditing(index)}
            status={status}
            t={t}
          />
        ))}

        {state.failure && (
          <div data-testid="team-front-proposal-error" className="text-[11px] text-nim-error">
            {t(`teamFrontProposal.failure.${state.failure}`)}
          </div>
        )}

        {state.remote === 'unsupported' ? (
          <div data-testid="team-front-proposal-desktop-only" className="text-[11px] text-nim-muted bg-nim-tertiary border border-nim rounded px-2 py-1.5">
            {t('teamFrontProposal.desktopOnly')}
          </div>
        ) : (
          <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-nim">
            <button type="button" data-testid="team-front-proposal-approve-all" className={quietButton} disabled={state.isSubmitting || state.remote !== 'pending'} onClick={() => state.decideAll('approve')}>
              {t('teamFrontProposal.approveAll')}
            </button>
            <button type="button" data-testid="team-front-proposal-reject-all" className={quietButton} disabled={state.isSubmitting || state.remote !== 'pending'} onClick={() => state.decideAll('reject')}>
              {t('teamFrontProposal.rejectAll')}
            </button>
            <span className="flex-1" />
            {!allDecided && <span data-testid="team-front-proposal-hint" className="text-[11px] text-nim-muted">{t('teamFrontProposal.decideEach')}</span>}
            {allDecided && anyApprovedProblem && <span data-testid="team-front-proposal-hint" className="text-[11px] text-nim-error">{t('teamFrontProposal.fixEdits')}</span>}
            <button type="button" data-testid="team-front-proposal-submit" className={primaryButton} disabled={!state.canSubmit} onClick={state.submit}>
              {state.isSubmitting ? t('teamFrontProposal.submitting') : t('teamFrontProposal.submit')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

const ResultLine: React.FC<{ entry: TeamFrontItemOutcome; t: Translate; status: (value: string | null) => string }> = ({ entry, t, status }) => {
  const label = entry.label || t('teamFrontProposal.unnamed');
  if (entry.result === 'written') {
    return (
      <>
        <span className="text-nim-success">{t('teamFrontProposal.result.written', { title: label, status: status(entry.status ?? null) })}</span>
        {entry.followUpWarning ? <span data-testid="team-front-proposal-follow-up-warning" className="block text-nim-muted">{t('teamFrontProposal.result.followUpWarning')}</span> : null}
        {entry.syncWarning ? <span data-testid="team-front-proposal-sync-warning" className="block text-nim-muted">{t('teamFrontProposal.result.syncWarning')}</span> : null}
      </>
    );
  }
  if (entry.result === 'rejected') return <span className="text-nim-muted">{t('teamFrontProposal.result.rejected', { title: label })}</span>;
  // The write may or may not have persisted: say so, never the English detail.
  if (entry.result === 'unconfirmed') return <span data-testid="team-front-proposal-unconfirmed" className="text-nim-error">{t('teamFrontProposal.result.unconfirmed', { title: label })}</span>;
  // A code this build does not know gets a neutral reason, not a wrong specific one.
  // An unknown code of a failed write is still a failed write; an unknown refusal gets the neutral text.
  const unknownReason = entry.result === 'failed' ? 'write-failed' : 'refused';
  const reason = entry.code && KNOWN_REFUSAL_CODES.includes(entry.code) ? t(`teamFrontProposal.reason.${entry.code}`) : t(`teamFrontProposal.reason.${unknownReason}`);
  return <span className="text-nim-error">{t(`teamFrontProposal.result.${entry.result}`, { title: label, reason })}</span>;
};

interface ProposalItemProps {
  index: number;
  item: CardItem;
  decision: ItemDecision;
  edits: ItemEdits | undefined;
  editing: boolean;
  disabled: boolean;
  onDecide: (value: ItemDecision) => void;
  onEdit: (patch: ItemEdits) => void;
  onToggleEdit: () => void;
  status: (value: string | null) => string;
  t: Translate;
}

const ProposalItem: React.FC<ProposalItemProps> = ({ index, item, decision, edits, editing, disabled, onDecide, onEdit, onToggleEdit, status, t }) => {
  const effective = effectiveItem(item, edits);
  const problem = itemProblem(item, edits);
  const edited = !!edits && JSON.stringify(effective) !== JSON.stringify(item);
  const pausing = effective.action === 'status' && effective.status === 'paused' && effective.activeMission !== null;
  const closingWithMission = problem === 'blocked';

  return (
    <div data-testid={`team-front-proposal-item-${index}`} data-decision={decision ?? 'none'} className="rounded-md border border-nim bg-nim p-2.5 flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wide text-nim-muted">
          {item.action === 'create' ? t('teamFrontProposal.kind.create') : t('teamFrontProposal.kind.status')}
        </span>
        {edited && <span data-testid={`team-front-proposal-edited-${index}`} className="text-[10px] text-nim-primary">{t('teamFrontProposal.edited')}</span>}
      </div>

      {effective.action === 'create' ? (
        <>
          <div data-testid={`team-front-proposal-title-${index}`} className="text-sm font-semibold text-nim break-words">{effective.title}</div>
          <div data-testid={`team-front-proposal-description-${index}`} className="text-xs text-nim-muted whitespace-pre-wrap break-words max-h-40 overflow-auto">{effective.description}</div>
          <div className="text-xs text-nim">{t('teamFrontProposal.suggestedStatus', { status: status(effective.status) })}</div>
        </>
      ) : (
        <>
          <div data-testid={`team-front-proposal-title-${index}`} className="text-sm font-semibold text-nim break-words">{effective.frontTitle}</div>
          <div className="text-xs text-nim">{t('teamFrontProposal.statusChange', { from: status(effective.fromStatus), to: status(effective.status) })}</div>
          {pausing && (
            <div data-testid={`team-front-proposal-warning-${index}`} className="text-[11px] text-nim bg-nim-tertiary border border-nim rounded px-2 py-1.5">
              {effective.activeMission?.title
                ? t('teamFrontProposal.pauseWarning', { mission: effective.activeMission.title })
                : t('teamFrontProposal.pauseWarningNoTitle')}
            </div>
          )}
          {closingWithMission && (
            <div data-testid={`team-front-proposal-blocked-${index}`} className="text-[11px] text-nim-error">{t('teamFrontProposal.closeBlocked')}</div>
          )}
        </>
      )}

      {editing && (
        <div data-testid={`team-front-proposal-editor-${index}`} className="flex flex-col gap-1.5 pt-1">
          {item.action === 'create' && (
            <>
              <label className="flex flex-col gap-0.5 text-[11px] text-nim-muted">
                {t('teamFrontProposal.field.title')}
                <input
                  data-testid={`team-front-proposal-input-title-${index}`}
                  type="text"
                  value={effective.action === 'create' ? effective.title : ''}
                  maxLength={TEAM_FRONT_TITLE_MAX}
                  disabled={disabled}
                  onChange={(event) => onEdit({ title: event.target.value })}
                  className="px-2 py-1 rounded border border-nim bg-nim text-nim text-xs"
                />
              </label>
              <label className="flex flex-col gap-0.5 text-[11px] text-nim-muted">
                {t('teamFrontProposal.field.description')}
                <textarea
                  data-testid={`team-front-proposal-input-description-${index}`}
                  value={effective.action === 'create' ? effective.description : ''}
                  maxLength={TEAM_FRONT_DESCRIPTION_MAX}
                  rows={5}
                  disabled={disabled}
                  onChange={(event) => onEdit({ description: event.target.value })}
                  className="px-2 py-1 rounded border border-nim bg-nim text-nim text-xs"
                />
              </label>
            </>
          )}
          <label className="flex flex-col gap-0.5 text-[11px] text-nim-muted">
            {t('teamFrontProposal.field.status')}
            <select
              data-testid={`team-front-proposal-input-status-${index}`}
              value={effective.status}
              disabled={disabled}
              onChange={(event) => onEdit({ status: event.target.value as ItemEdits['status'] })}
              className="px-2 py-1 rounded border border-nim bg-nim text-nim text-xs"
            >
              {TEAM_FRONT_STATUS_VALUES.map((value) => (
                <option key={value} value={value}>{t(`teamFrontProposal.status.${value}`)}</option>
              ))}
            </select>
          </label>
          {(problem === 'title' || problem === 'description') && decision === 'approve' && (
            <div data-testid={`team-front-proposal-problem-${index}`} className="text-[11px] text-nim-error">
              {t(`teamFrontProposal.problem.${problem}`, { max: problem === 'title' ? TEAM_FRONT_TITLE_MAX : TEAM_FRONT_DESCRIPTION_MAX })}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button type="button" data-testid={`team-front-proposal-approve-${index}`} aria-pressed={decision === 'approve'} disabled={disabled || closingWithMission} onClick={() => onDecide('approve')}
          className={`${decision === 'approve' ? primaryButton : quietButton}`}>
          {decision === 'approve' ? t('teamFrontProposal.approved') : t('teamFrontProposal.approve')}
        </button>
        <button type="button" data-testid={`team-front-proposal-reject-${index}`} aria-pressed={decision === 'reject'} disabled={disabled} onClick={() => onDecide('reject')}
          className={`${decision === 'reject' ? primaryButton : quietButton}`}>
          {decision === 'reject' ? t('teamFrontProposal.rejected') : t('teamFrontProposal.reject')}
        </button>
        <button type="button" data-testid={`team-front-proposal-edit-${index}`} disabled={disabled} onClick={onToggleEdit} className={quietButton}>
          {editing ? t('teamFrontProposal.doneEditing') : t('teamFrontProposal.edit')}
        </button>
      </div>
    </div>
  );
};
