/**
 * Collapses a full sync status snapshot into the one line the account popover
 * shows, plus whether the gutter avatar should wear a warning.
 *
 * Sync used to own a gutter slot whose popover reported four counters. The
 * counters were diagnostics nobody acted on, and the slot cost a rail position
 * for every signed-in user even when everything was healthy. What is left is
 * the part a user reacts to: is it on, is it working, when did it last run.
 */

import type { SessionSyncStatus } from '../../../shared/sessionSyncStatus';
import { describePersonalSyncWriteGate, describeSkippedSyncRows } from '@nimbalyst/runtime/sync/personalSyncWriteGate';
import { t } from '@nimbalyst/runtime/i18n';

export interface SyncStatusSnapshot extends SessionSyncStatus {
  /** Sync is configured at the app level (i.e. the user is signed in). */
  appConfigured: boolean;
  projectEnabled: boolean;
  lastSyncedAt: number | null;
}

export type SyncTone = 'ok' | 'idle' | 'warning' | 'error';

export interface SyncSummary {
  tone: SyncTone;
  /** Right-hand text on the row: "Synced 5m ago", "Off for this project", … */
  detail: string;
  notice?: string | null;
  /**
   * True when the user should notice without opening the popover. Drives the
   * avatar warning, which is also what an expired sign-in uses — one
   * "your account needs attention" affordance rather than two.
   */
  needsAttention: boolean;
}

/** Relative age of the last successful sync, or null when it has never run. */
export function formatLastSync(lastSyncedAt: number | null, now: number): string | null {
  if (!lastSyncedAt) return null;
  const diffMs = now - lastSyncedAt;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return t('menu:accountMenu.sync.justNow');
  if (diffMins < 60) return t('menu:accountMenu.sync.minutesAgo', { count: diffMins });
  const diffHours = Math.floor(diffMs / 3600000);
  if (diffHours < 24) return t('menu:accountMenu.sync.hoursAgo', { count: diffHours });
  return t('menu:accountMenu.sync.daysAgo', { count: Math.floor(diffMs / 86400000) });
}

export function summarizeSyncStatus(
  status: SyncStatusSnapshot,
  now: number = Date.now(),
): SyncSummary | null {
  // Not signed in: there is nothing to report and no row to draw.
  if (!status.appConfigured) return null;

  const notice = describeSkippedSyncRows(status.skippedRowCount ?? 0);
  const advisory = notice ? { notice } : {};

  // A project the user deliberately opted out of is not a problem to flag.
  if (!status.projectEnabled) {
    return { ...advisory, tone: 'idle', detail: t('menu:accountMenu.sync.offForProject'), needsAttention: false };
  }

  if (status.error) {
    return { ...advisory, tone: 'error', detail: status.error, needsAttention: true };
  }

  const gate = status.personalSyncWriteGate;
  if (gate?.state === 'blocked') {
    return { ...advisory, tone: 'error', detail: describePersonalSyncWriteGate(gate) ?? t('menu:accountMenu.sync.paused'), needsAttention: true };
  }
  if (status.connected && gate?.state === 'unverified') {
    return { ...advisory, tone: 'idle', detail: t('menu:accountMenu.sync.checking'), needsAttention: false };
  }

  if (status.syncing) {
    return { ...advisory, tone: 'ok', detail: t('menu:accountMenu.sync.syncing'), needsAttention: false };
  }

  if (status.connected) {
    const age = formatLastSync(status.lastSyncedAt, now);
    return { ...advisory, tone: 'ok', detail: age ? t('menu:accountMenu.sync.synced', { age }) : t('menu:accountMenu.sync.connected'), needsAttention: false };
  }

  // Enabled for this project but not connected — the case the old cloud icon
  // existed to make visible, so it has to keep reaching the user somehow.
  return { ...advisory, tone: 'warning', detail: t('menu:accountMenu.sync.disconnected'), needsAttention: true };
}
