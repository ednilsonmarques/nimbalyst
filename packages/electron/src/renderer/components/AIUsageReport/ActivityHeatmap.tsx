import React, { useEffect, useState } from 'react';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';

interface ActivityHeatmapProps {
  workspaceId?: string;
}

interface ActivityHeatmapData {
  hourOfDay: number;
  dayOfWeek: number;
  activityCount: number;
}

type ActivityMetric = 'sessions' | 'messages' | 'edits';

// Values are ai-namespace i18n keys, translated at render time.
const METRIC_LABELS: Record<ActivityMetric, { title: string; description: string; toggle: string }> = {
  sessions: {
    title: 'usageReport.heatmap.sessions.title',
    description: 'usageReport.heatmap.sessions.description',
    toggle: 'usageReport.heatmap.sessions.toggle',
  },
  messages: {
    title: 'usageReport.heatmap.messages.title',
    description: 'usageReport.heatmap.messages.description',
    toggle: 'usageReport.heatmap.messages.toggle',
  },
  edits: {
    title: 'usageReport.heatmap.edits.title',
    description: 'usageReport.heatmap.edits.description',
    toggle: 'usageReport.heatmap.edits.toggle',
  },
};

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export const ActivityHeatmap: React.FC<ActivityHeatmapProps> = ({ workspaceId }) => {
  const { t } = useTranslation('ai');
  const [data, setData] = useState<ActivityHeatmapData[]>([]);
  const [loading, setLoading] = useState(true);
  const [metric, setMetric] = useState<ActivityMetric>('messages');

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      try {
        // Get user's timezone offset in minutes (e.g., -300 for EST)
        const timezoneOffsetMinutes = new Date().getTimezoneOffset();

        const heatmapData = await window.electronAPI.invoke(
          'usage-analytics:get-activity-heatmap',
          workspaceId,
          metric,
          timezoneOffsetMinutes
        );
        setData(heatmapData);
      } catch (error) {
        console.error('Failed to load activity heatmap:', error);
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, [workspaceId, metric]);

  if (loading) {
    return (
      <div className="activity-heatmap-loading flex items-center justify-center min-h-[200px] text-[var(--nim-text-muted)] text-sm">
        {t('usageReport.loading')}
      </div>
    );
  }

  // Create a 2D grid: rows = days (0-6), columns = hours (0-23)
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const days = DAY_KEYS.map((key) => t(`usageReport.days.${key}`));

  // Find max activity for scaling
  const maxActivity = Math.max(...data.map((d) => d.activityCount), 1);

  // Create lookup map
  const activityMap = new Map<string, number>();
  data.forEach((d) => {
    const key = `${d.dayOfWeek}-${d.hourOfDay}`;
    activityMap.set(key, d.activityCount);
  });

  const getIntensity = (dayOfWeek: number, hour: number): number => {
    const key = `${dayOfWeek}-${hour}`;
    const count = activityMap.get(key) || 0;
    return count / maxActivity;
  };

  const currentMetricLabels = METRIC_LABELS[metric];

  return (
    <div className="activity-heatmap flex flex-col gap-3">
      <div className="heatmap-header-section flex justify-between items-start gap-4">
        <div>
          <h3 className="m-0 text-base font-semibold text-[var(--nim-text)]">
            {t(currentMetricLabels.title)}
          </h3>
          <p className="heatmap-description mt-1 mb-0 text-xs text-[var(--nim-text-muted)]">
            {t(currentMetricLabels.description)}
          </p>
        </div>
        <div className="metric-toggle flex gap-1 bg-[var(--nim-bg-secondary)] p-1 rounded-md">
          {(['messages', 'edits', 'sessions'] as ActivityMetric[]).map((m) => (
            <button
              key={m}
              className={`metric-button border-none px-3 py-1.5 text-xs font-medium text-[var(--nim-text-muted)] cursor-pointer rounded transition-all duration-200 whitespace-nowrap hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)] ${metric === m ? 'active bg-[var(--nim-bg)] text-[var(--nim-text)] shadow-sm' : ''}`}
              onClick={() => setMetric(m)}
            >
              {t(METRIC_LABELS[m].toggle)}
            </button>
          ))}
        </div>
      </div>

      <div className="heatmap-container overflow-x-auto">
        <div className="heatmap-grid inline-block min-w-[800px]">
          {/* Header row with hour labels */}
          <div className="heatmap-header grid grid-cols-[40px_repeat(24,1fr)] gap-0.5 mb-0.5">
            <div className="day-label text-[10px] font-semibold text-[var(--nim-text)] text-right pr-2 flex items-center justify-end"></div>
            {hours.map((hour) => (
              <div
                key={hour}
                className="hour-label text-[9px] text-[var(--nim-text-faint)] text-center flex items-center justify-center"
              >
                {hour.toString().padStart(2, '0')}
              </div>
            ))}
          </div>

          {/* Data rows - one per day */}
          {days.map((day, dayIndex) => (
            <div key={dayIndex} className="heatmap-row grid grid-cols-[40px_repeat(24,1fr)] gap-0.5 mb-0.5">
              <div className="day-label text-[10px] font-semibold text-[var(--nim-text)] text-right pr-2 flex items-center justify-end">
                {day}
              </div>
              {hours.map((hour) => {
                const intensity = getIntensity(dayIndex, hour);
                const count = activityMap.get(`${dayIndex}-${hour}`) || 0;
                const tooltipText = (() => {
                  if (metric === 'messages') return t('usageReport.heatmap.messagesSent', { count });
                  if (metric === 'edits') return t('usageReport.heatmap.editsSaved', { count });
                  return t('usageReport.heatmap.sessionsStarted', { count });
                })();
                return (
                  <div
                    key={hour}
                    className="heatmap-cell aspect-square rounded-sm bg-nim border border-nim cursor-pointer transition-all duration-200 flex items-center justify-center min-h-[20px] max-h-[28px] relative hover:scale-110 hover:z-10 hover:border-nim"
                    style={{
                      backgroundColor: intensity > 0 ? `rgba(59, 130, 246, ${intensity * 0.8})` : undefined,
                    }}
                    data-tooltip={`${day} ${hour}:00 - ${tooltipText}`}
                  >
                    {count > 0 && (
                      <span className="cell-count text-[7px] font-semibold text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.5)]">
                        {count}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div className="heatmap-legend flex items-center gap-1.5 mt-2 justify-center text-[10px] text-[var(--nim-text-muted)]">
          <span>{t('usageReport.heatmap.less')}</span>
          <div
            className="legend-gradient w-[100px] h-2 rounded-sm"
            style={{
              background:
                'linear-gradient(to right, rgba(var(--nim-accent-rgb), 0), rgba(var(--nim-accent-rgb), 0.8))',
            }}
          ></div>
          <span>{t('usageReport.heatmap.more')}</span>
        </div>
      </div>
    </div>
  );
};
