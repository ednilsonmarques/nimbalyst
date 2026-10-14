/**
 * ToolManifestCard
 *
 * Shown in a Team mode coordinator's transcript in place of the host's
 * stored-manifest notice (promptOrigin `tool_manifest`, Phase 1B): the
 * manifest's id, its status (draft, accepted, superseded), its confidence, the
 * architect that produced it, what it supersedes, and one action, "Open
 * manifest", which opens the stored tracker item in the existing Tracker view.
 *
 * The card reads; it never writes. The item is host-owned and the coordinator
 * accepts it through the tracker tool: there is no second path here. Where the
 * host cannot read the Tracker (or the text is not a notice) the plain notice
 * is shown instead, so nothing is ever invented.
 */

import React, { useState } from 'react';
import type { TranscriptViewMessage } from '../../../../ai/server/transcript/TranscriptProjector';
import { useTranslation } from '../../../../i18n/react';
import { MaterialSymbol } from '../../../icons/MaterialSymbol';
import { formatMessageTime } from '../../../../utils/dateUtils';
import { navigateToTrackerItem } from './trackerItemNavigation';
import { parseToolManifestNoticeId, useToolManifestCard } from './toolManifestCardState';

const STATUS_LABEL_KEYS: Record<string, string> = {
  draft: 'toolManifest.card.status.draft',
  accepted: 'toolManifest.card.status.accepted',
  superseded: 'toolManifest.card.status.superseded',
};

const STATUS_CLASSES: Record<string, string> = {
  draft: 'text-nim-muted',
  accepted: 'text-nim-success',
  superseded: 'text-[var(--nim-text-faint)]',
};

const OPEN_BUTTON = 'px-3 py-1.5 rounded-md text-[11px] font-medium cursor-pointer border-none bg-nim-primary text-nim-on-primary whitespace-nowrap transition-all duration-150 hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed';
const DETAILS_BUTTON = 'px-2 py-1.5 rounded-md text-[11px] font-medium cursor-pointer border-none bg-transparent text-nim-muted hover:text-nim';

export interface ToolManifestCardProps {
  message: TranscriptViewMessage;
  sessionId: string;
  /** What to render when the card cannot stand on its own (no host, no notice). */
  fallback: React.ReactElement | null;
}

export const ToolManifestCard: React.FC<ToolManifestCardProps> = ({ message, sessionId, fallback }) => {
  const { t } = useTranslation('ai');
  const [showDetails, setShowDetails] = useState(false);
  const manifestId = parseToolManifestNoticeId(message.text);
  const { state, data } = useToolManifestCard(sessionId, manifestId);
  // No notice id, no host that reads the Tracker, or a host that failed to: the plain notice, never an invented state.
  if (!manifestId || state === 'unsupported' || state === 'error') return fallback;

  const status = data?.status ?? null;
  const statusLabel = status ? (STATUS_LABEL_KEYS[status] ? t(STATUS_LABEL_KEYS[status]) : status) : null;
  const architectName = data?.architectTitle ?? (data?.architectSessionId ? data.architectSessionId.slice(0, 8) : null);
  const notice = (message.text ?? '').replace(/`([^`]+)`/g, '$1').trim();
  const superseded = status === 'superseded';

  return (
    <div
      data-testid="tool-manifest-card"
      data-manifest-id={manifestId}
      data-state={data ? status ?? 'draft' : state}
      className={`tool-manifest-card ml-6 mb-2 rounded-lg border border-nim bg-nim-secondary overflow-hidden ${superseded ? 'opacity-85' : ''}`}
    >
      <div className="flex items-center gap-2 py-2.5 px-3 border-b border-nim bg-nim-tertiary">
        <MaterialSymbol icon="architecture" size={16} className="shrink-0 text-nim-primary" />
        <span data-testid="tool-manifest-title" className="text-sm font-semibold text-nim flex-1 min-w-0 truncate">
          {t('toolManifest.card.title', { id: manifestId })}
        </span>
        {statusLabel && (
          <span
            data-testid="tool-manifest-status"
            data-status={status}
            className={`shrink-0 rounded-full border border-current px-2 py-0.5 text-[11px] font-medium ${STATUS_CLASSES[status ?? ''] ?? 'text-nim-muted'}`}
          >
            {statusLabel}
          </span>
        )}
        <span className="shrink-0 text-[10px] text-[var(--nim-text-faint)]">
          {formatMessageTime(message.createdAt?.getTime() ?? 0)}
        </span>
      </div>

      <div className="p-3 flex flex-col gap-2">
        {state === 'loading' && (
          <div className="text-xs text-nim-muted">{t('toolManifest.card.loading')}</div>
        )}
        {state === 'missing' && (
          <div data-testid="tool-manifest-missing" className="text-xs text-nim-muted">{t('toolManifest.card.notFound')}</div>
        )}
        {data && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-nim-muted leading-relaxed">
            <span data-testid="tool-manifest-confidence">
              {t('toolManifest.card.confidence', { level: t(`toolManifest.card.confidenceLevel.${data.confidence ?? 'unknown'}`) })}
            </span>
            {architectName && (
              <span data-testid="tool-manifest-architect">{t('toolManifest.card.architect', { name: architectName })}</span>
            )}
            {data.supersedes.length > 0 && (
              <span data-testid="tool-manifest-supersedes">{t('toolManifest.card.supersedes', { ids: data.supersedes.join(', ') })}</span>
            )}
          </div>
        )}

        <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-nim">
          <button
            type="button"
            data-testid="tool-manifest-open"
            disabled={!data}
            title={t('toolManifest.card.openHint')}
            onClick={() => { if (data) navigateToTrackerItem(data.itemId); }}
            className={OPEN_BUTTON}
          >
            {t('toolManifest.card.open')}
          </button>
          <button
            type="button"
            data-testid="tool-manifest-details"
            aria-expanded={showDetails}
            onClick={() => setShowDetails((value) => !value)}
            className={DETAILS_BUTTON}
          >
            {t('toolManifest.card.details')}
          </button>
        </div>
        {showDetails && (
          <p data-testid="tool-manifest-notice" className="m-0 text-xs leading-relaxed text-nim-muted whitespace-normal break-words">
            {notice}
          </p>
        )}
      </div>
    </div>
  );
};
