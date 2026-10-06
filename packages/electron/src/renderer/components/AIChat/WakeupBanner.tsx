import React, { useCallback, useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { sessionWakeupAtom, type SessionWakeupView } from '../../store/atoms/sessions';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';
import { t as translate } from '@nimbalyst/runtime/i18n';

interface WakeupBannerProps {
  sessionId?: string | null;
}

function formatRelativeFireAt(fireAt: number): string {
  const ms = fireAt - Date.now();
  if (ms <= 0) return translate('ai:wakeup.relative.now');
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return translate('ai:wakeup.relative.seconds', { seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return translate('ai:wakeup.relative.minutes', { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return translate('ai:wakeup.relative.hours', { hours, minutes: minutes % 60 });
  const days = Math.floor(hours / 24);
  return translate('ai:wakeup.relative.days', { days, hours: hours % 24 });
}

function formatAbsoluteFireAt(fireAt: number): string {
  return new Date(fireAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function statusLabel(wakeup: SessionWakeupView): string {
  switch (wakeup.status) {
    case 'pending':
      return translate('ai:wakeup.scheduled', { relative: formatRelativeFireAt(wakeup.fireAt), absolute: formatAbsoluteFireAt(wakeup.fireAt) });
    case 'firing':
      return translate('ai:wakeup.resuming');
    case 'waiting_for_workspace':
      return translate('ai:wakeup.waitingForWorkspace');
    case 'overdue': {
      const hoursAgo = Math.max(0, Math.floor((Date.now() - wakeup.fireAt) / 3_600_000));
      return hoursAgo > 0
        ? translate('ai:wakeup.overdueHours', { hours: hoursAgo })
        : translate('ai:wakeup.overdueClosed');
    }
    default:
      return '';
  }
}

export function WakeupBanner({ sessionId }: WakeupBannerProps) {
  const { t } = useTranslation('ai');
  const effectiveSessionId = sessionId || '__no_session__';
  const wakeup = useAtomValue(sessionWakeupAtom(effectiveSessionId));
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);

  // Re-render every 30s so the relative time stays fresh.
  useEffect(() => {
    if (!wakeup || wakeup.status !== 'pending') return;
    const interval = setInterval(() => setTick(n => n + 1), 30_000);
    return () => clearInterval(interval);
  }, [wakeup]);

  const handleCancel = useCallback(async () => {
    if (!wakeup || busy) return;
    setBusy(true);
    try {
      await window.electronAPI.invoke('wakeup:cancel', wakeup.id);
    } catch (error) {
      console.error('[WakeupBanner] cancel failed', error);
    } finally {
      setBusy(false);
    }
  }, [wakeup, busy]);

  const handleRunNow = useCallback(async () => {
    if (!wakeup || busy) return;
    setBusy(true);
    try {
      await window.electronAPI.invoke('wakeup:run-now', wakeup.id);
    } catch (error) {
      console.error('[WakeupBanner] run-now failed', error);
    } finally {
      setBusy(false);
    }
  }, [wakeup, busy]);

  if (!sessionId) return null;
  if (!wakeup) return null;

  const isOverdue = wakeup.status === 'overdue';
  const containerClass = isOverdue
    ? 'flex items-center justify-between gap-3 px-3 py-2 bg-amber-400/10 border-b border-amber-400/30'
    : 'flex items-center justify-between gap-3 px-3 py-2 bg-blue-400/10 border-b border-blue-400/30';
  const textClass = isOverdue
    ? 'text-xs font-medium text-nim-warning truncate'
    : 'text-xs font-medium text-nim-primary truncate';
  const iconColor = isOverdue ? 'text-nim-warning' : 'text-nim-primary';

  return (
    <div className={containerClass} data-testid="wakeup-banner">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <MaterialSymbol icon="schedule" size={16} className={iconColor} />
        <span className={textClass}>
          {statusLabel(wakeup)}
          {wakeup.reason ? <span className="opacity-80"> — {wakeup.reason}</span> : null}
        </span>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {(wakeup.status === 'pending' || wakeup.status === 'overdue') && (
          <button
            type="button"
            onClick={handleRunNow}
            disabled={busy}
            className="flex items-center gap-1 px-2.5 py-1 bg-transparent border border-current rounded text-[11px] font-medium cursor-pointer transition-all duration-200 hover:enabled:bg-current/10 disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="wakeup-banner-run-now"
            title={t('wakeup.fireNowTitle')}
          >
            <MaterialSymbol icon="bolt" size={14} />
            {t('wakeup.fireNow')}
          </button>
        )}
        <button
          type="button"
          onClick={handleCancel}
          disabled={busy}
          className="flex items-center gap-1 px-2.5 py-1 bg-transparent border border-nim-border rounded text-nim-text-muted text-[11px] font-medium cursor-pointer transition-all duration-200 hover:enabled:bg-nim-bg-secondary disabled:opacity-50 disabled:cursor-not-allowed"
          data-testid="wakeup-banner-cancel"
          title={t('wakeup.cancelTitle')}
        >
          <MaterialSymbol icon="cancel" size={14} />
          {t('wakeup.cancel')}
        </button>
      </div>
    </div>
  );
}
