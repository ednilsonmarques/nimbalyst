import React, { useEffect, useState } from 'react';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';

interface OverviewDashboardProps {
  workspaceId?: string;
}

interface TokenUsageStats {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  sessionCount: number;
  messageCount: number;
}

interface ProviderUsageStats {
  provider: string;
  model: string | null;
  sessionCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
}

export const OverviewDashboard: React.FC<OverviewDashboardProps> = ({ workspaceId }) => {
  const { t } = useTranslation('ai');
  const [overallStats, setOverallStats] = useState<TokenUsageStats | null>(null);
  const [providerStats, setProviderStats] = useState<ProviderUsageStats[]>([]);
  const [allSessionCount, setAllSessionCount] = useState<number>(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      try {
        const [overall, providers, totalSessions] = await Promise.all([
          window.electronAPI.invoke('usage-analytics:get-overall-stats', workspaceId),
          window.electronAPI.invoke('usage-analytics:get-usage-by-provider', workspaceId),
          window.electronAPI.invoke('usage-analytics:get-all-session-count', workspaceId),
        ]);
        setOverallStats(overall);
        setProviderStats(providers);
        setAllSessionCount(totalSessions);
      } catch (error) {
        console.error('Failed to load overview data:', error);
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, [workspaceId]);

  if (loading) {
    return (
      <div className="overview-loading flex items-center justify-center min-h-[300px] text-[var(--nim-text-muted)] text-base">
        {t('usageReport.loading')}
      </div>
    );
  }

  if (!overallStats) {
    return (
      <div className="overview-empty flex items-center justify-center min-h-[300px] text-[var(--nim-text-muted)] text-base">
        {t('usageReport.noUsageData')}
      </div>
    );
  }

  // Get most used provider
  const mostUsedProvider = providerStats.length > 0 ? providerStats[0] : null;

  return (
    <div className="overview-dashboard flex flex-col gap-4">
      <div className="stats-grid grid grid-cols-[repeat(auto-fit,minmax(250px,1fr))] gap-4">
        <div className="stat-card bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-md px-4 py-3">
          <div className="stat-label text-[11px] text-[var(--nim-text-faint)] uppercase tracking-[0.5px] mb-1 font-medium">
            {t('usageReport.totalSessions')}
          </div>
          <div className="stat-value text-2xl font-semibold text-[var(--nim-text)] mb-0.5">
            {allSessionCount.toLocaleString()}
          </div>
          {overallStats.sessionCount < allSessionCount && (
            <div className="stat-detail text-[11px] text-[var(--nim-text-muted)]">
              {t('usageReport.withTokenData', { sessions: overallStats.sessionCount.toLocaleString() })}
            </div>
          )}
        </div>

        <div className="stat-card bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-md px-4 py-3">
          <div className="stat-label text-[11px] text-[var(--nim-text-faint)] uppercase tracking-[0.5px] mb-1 font-medium">
            {t('usageReport.totalTokens')}
          </div>
          <div className="stat-value text-2xl font-semibold text-[var(--nim-text)] mb-0.5">
            {overallStats.totalTokens.toLocaleString()}
          </div>
          <div className="stat-detail text-[11px] text-[var(--nim-text-muted)]">
            {t('usageReport.inOut', { input: overallStats.totalInputTokens.toLocaleString(), output: overallStats.totalOutputTokens.toLocaleString() })}
          </div>
        </div>

        {mostUsedProvider && (
          <div className="stat-card bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-md px-4 py-3">
            <div className="stat-label text-[11px] text-[var(--nim-text-faint)] uppercase tracking-[0.5px] mb-1 font-medium">
              {t('usageReport.mostUsed')}
            </div>
            <div className="stat-value text-2xl font-semibold text-[var(--nim-text)] mb-0.5">
              {mostUsedProvider.provider}
            </div>
            <div className="stat-detail text-[11px] text-[var(--nim-text-muted)]">
              {mostUsedProvider.model || t('usageReport.defaultModel')} - {t('usageReport.sessionsCount', { count: mostUsedProvider.sessionCount })}
            </div>
          </div>
        )}
      </div>

      {providerStats.length > 0 && (
        <div className="provider-breakdown mt-2">
          <h3 className="m-0 mb-3 text-sm font-semibold text-[var(--nim-text)]">
            {t('usageReport.usageByProvider')}
          </h3>
          <div className="provider-bars flex flex-col gap-2">
            {providerStats.map((provider, index) => {
              const maxTokens = providerStats[0]?.totalTokens || 1;
              const percentage = (provider.totalTokens / maxTokens) * 100;
              const displayName = provider.model
                ? `${provider.provider} (${provider.model})`
                : provider.provider;
              return (
                <div key={index} className="provider-bar-item flex flex-col gap-1">
                  <div className="provider-bar-label flex justify-between items-center">
                    <span className="provider-bar-name text-xs font-medium text-[var(--nim-text)]">
                      {displayName}
                    </span>
                    <span className="provider-bar-tokens text-[11px] text-[var(--nim-text-muted)]">
                      {provider.totalTokens.toLocaleString()}
                    </span>
                  </div>
                  <div className="provider-bar-track h-1.5 bg-[var(--nim-bg-tertiary)] rounded-sm overflow-hidden">
                    <div
                      className="provider-bar-fill h-full bg-[var(--nim-primary)] rounded-sm transition-[width] duration-300 ease-out"
                      style={{ width: `${percentage}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
