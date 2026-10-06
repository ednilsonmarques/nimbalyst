import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';

import type { InboxFilterId } from './inboxTypes';
import { inboxFilterLabel } from './inboxViewModel';

interface EmptyCopy {
  icon: string;
  title: string;
  body: string;
  actionLabel?: string;
}

/**
 * Filter-specific empty states. A generic "nothing here" teaches nobody what
 * the filter means or how to get something into it, so each one explains its
 * own rule and offers the action that resolves it.
 */
const FILTER_EMPTY: Record<InboxFilterId, EmptyCopy> = {
  all: {
    icon: 'inbox',
    title: 'inbox.empty.all.title',
    body: 'inbox.empty.all.body',
    actionLabel: 'inbox.empty.browseRooms',
  },
  mentions: {
    icon: 'alternate_email',
    title: 'inbox.empty.mentions.title',
    body: 'inbox.empty.mentions.body',
    actionLabel: 'inbox.empty.browseRooms',
  },
  assigned: {
    icon: 'assignment_ind',
    title: 'inbox.empty.assigned.title',
    body: 'inbox.empty.assigned.body',
    actionLabel: 'inbox.empty.openTrackers',
  },
  awaiting: {
    icon: 'ballot',
    title: 'inbox.empty.awaiting.title',
    body: 'inbox.empty.awaiting.body',
  },
  follows: {
    icon: 'visibility',
    title: 'inbox.empty.follows.title',
    body: 'inbox.empty.follows.body',
    actionLabel: 'inbox.empty.browseRooms',
  },
  archived: {
    icon: 'archive',
    title: 'inbox.empty.archived.title',
    body: 'inbox.empty.archived.body',
  },
};

/**
 * Read state is its own axis, so it gets its own empty copy — and it wins over
 * the reason's, because "nothing unread" is the more useful thing to hear when
 * the reason itself does have rows sitting in it.
 */
const UNREAD_EMPTY: EmptyCopy = {
  icon: 'mark_email_read',
  title: 'inbox.empty.unread.title',
  body: 'inbox.empty.unread.body',
};

export function InboxEmptyState({
  filter,
  unreadOnly = false,
  query,
  scopeActive,
  onClearFilters,
  onBrowse,
  children,
}: {
  filter: InboxFilterId;
  unreadOnly?: boolean;
  query: string;
  scopeActive: boolean;
  onClearFilters: () => void;
  /** Absent when the host has no rooms directory to send the user to. */
  onBrowse?: () => void;
  /** Slot for the `Search all messages` escalation when a query is active. */
  children?: React.ReactNode;
}) {
  const { t } = useTranslation('team');
  const copy = unreadOnly ? UNREAD_EMPTY : FILTER_EMPTY[filter];
  const narrowed = !!query || scopeActive || unreadOnly || filter !== 'all';

  return (
    <div
      className="inbox-empty-state flex flex-col items-center gap-2 px-8 py-14 text-center"
      data-testid="inbox-empty-state"
      data-filter={filter}
      data-component="InboxEmptyState"
    >
      <span className="inbox-empty-icon flex size-11 items-center justify-center rounded-full bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-faint)]">
        <MaterialSymbol icon={query ? 'search_off' : copy.icon} size={22} />
      </span>
      <h3 className="m-0 text-[14px] font-semibold text-[var(--nim-text)]">
        {query ? t('inbox.empty.noSearchMatch') : t(copy.title)}
      </h3>
      <p className="m-0 max-w-[420px] text-[12px] leading-relaxed text-[var(--nim-text-muted)]">
        {query
          ? t('inbox.empty.nothingMatches', { scope: filter === 'all' ? t('inbox.empty.yourInbox') : inboxFilterLabel(filter), query })
          : t(copy.body)}
      </p>

      <div className="inbox-empty-actions mt-1 flex items-center gap-2">
        {narrowed && (
          <button
            type="button"
            className="inbox-empty-clear rounded-md border border-[var(--nim-border)] px-2.5 py-1 text-[12px] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
            data-testid="inbox-empty-clear-filters"
            onClick={onClearFilters}
          >
            {t('inbox.clearFilters')}
          </button>
        )}
        {!query && copy.actionLabel && onBrowse && (
          <button
            type="button"
            className="inbox-empty-browse rounded-md border border-[var(--nim-border)] px-2.5 py-1 text-[12px] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
            data-testid="inbox-empty-browse"
            onClick={onBrowse}
          >
            {t(copy.actionLabel)}
          </button>
        )}
      </div>

      {children && <div className="inbox-empty-escalation mt-3">{children}</div>}
    </div>
  );
}

/** No connection and no cached rows to fall back on. */
export function InboxOfflineWithoutCache() {
  const { t } = useTranslation('team');
  return (
    <div
      className="inbox-offline-empty flex flex-col items-center gap-2 px-8 py-14 text-center"
      data-testid="inbox-offline-empty"
      data-component="InboxOfflineWithoutCache"
    >
      <span className="flex size-11 items-center justify-center rounded-full bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-faint)]">
        <MaterialSymbol icon="cloud_off" size={22} />
      </span>
      <h3 className="m-0 text-[14px] font-semibold text-[var(--nim-text)]">{t('inbox.offlineEmpty.title')}</h3>
      <p className="m-0 max-w-[420px] text-[12px] leading-relaxed text-[var(--nim-text-muted)]">
        {t('inbox.offlineEmpty.body')}
      </p>
    </div>
  );
}
