import type { ConfirmDialogOptions } from '../../../contexts/DialogContext.types';
import type { TrackerSharing } from '@nimbalyst/runtime';
import { t } from '@nimbalyst/runtime/i18n';

export const LOCAL_TRACKER_CONFIG_LOCATION = '.nimbalyst/trackers/*.yaml';
export const SHARED_TRACKER_CONFIG_LOCATION = 'the shared Cloudflare-hosted tracker database';

export function isTeamTrackerSharing(sharing: TrackerSharing): boolean {
  return sharing === 'team';
}

export function requiresTrackerSharingConfirmation(
  currentSharing: TrackerSharing,
  nextSharing: TrackerSharing,
): boolean {
  return currentSharing === 'personal' && isTeamTrackerSharing(nextSharing);
}

export function canChangeTrackerSharing(
  currentSharing: TrackerSharing,
  nextSharing: TrackerSharing,
  isAdmin: boolean,
): boolean {
  return !requiresTrackerSharingConfirmation(currentSharing, nextSharing) || isAdmin;
}

export function getTrackerStorageCopy(): string {
  return t('settings:trackerConfigUpgrade.storageCopy', { localLocation: LOCAL_TRACKER_CONFIG_LOCATION });
}

export function buildTrackerSharingConfirmOptions(
  trackerDisplayNamePlural: string,
  _nextSharing: TrackerSharing,
): ConfirmDialogOptions {
  return {
    title: t('settings:trackerConfigUpgrade.confirmTitle', { trackers: trackerDisplayNamePlural }),
    message: t('settings:trackerConfigUpgrade.confirmMessage', { trackers: trackerDisplayNamePlural, localLocation: LOCAL_TRACKER_CONFIG_LOCATION }),
    confirmLabel: t('settings:trackerConfigUpgrade.confirmLabel'),
    cancelLabel: t('common:cancel'),
  };
}
