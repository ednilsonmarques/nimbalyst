import { t } from '@nimbalyst/runtime/i18n';

interface TrackerActivityLike {
  action: string;
  field?: string;
  oldValue?: string;
  newValue?: string;
}

function quoted(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  const bounded = compact.length > 80 ? `${compact.slice(0, 77)}…` : compact;
  return `“${bounded}”`;
}

function changed(label: string, entry: TrackerActivityLike): string {
  if (entry.oldValue !== undefined && entry.newValue !== undefined) {
    return t('tracker:activity.changedFromTo', { field: label, from: quoted(entry.oldValue), to: quoted(entry.newValue) });
  }
  if (entry.newValue !== undefined) return t('tracker:activity.changedTo', { field: label, to: quoted(entry.newValue) });
  return t('tracker:activity.updated', { field: label });
}

export function formatTrackerActivity(entry: TrackerActivityLike): string {
  if (entry.action === 'created') return t('tracker:activity.created');
  if (entry.action === 'commented') return t('tracker:activity.commented');
  if (entry.action === 'comment_updated') {
    if (entry.oldValue !== undefined && entry.newValue !== undefined) {
      return t('tracker:activity.commentEditedFromTo', { from: quoted(entry.oldValue), to: quoted(entry.newValue) });
    }
    return t('tracker:activity.commentEdited');
  }
  if (entry.action === 'comment_deleted') {
    return entry.oldValue !== undefined ? t('tracker:activity.commentDeletedValue', { value: quoted(entry.oldValue) }) : t('tracker:activity.commentDeleted');
  }
  if (entry.action === 'archived') {
    return entry.newValue === 'true' ? t('tracker:activity.archived') : t('tracker:activity.unarchived');
  }
  if (entry.action === 'status_changed') return changed(t('tracker:activity.field.status'), entry);
  if (entry.action === 'type_changed') return changed(t('tracker:activity.field.type'), entry);
  if (entry.field) return changed(entry.field, entry);
  return entry.action.replace(/_/g, ' ');
}
