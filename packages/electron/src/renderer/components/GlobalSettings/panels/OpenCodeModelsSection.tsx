import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AIModel,
  OpenCodeModelCatalogSnapshot,
} from '../../../../shared/openCodeModelCatalog';
import { useTranslation, Trans } from '@nimbalyst/runtime/i18n/react';
import { t as translate } from '@nimbalyst/runtime/i18n';

interface OpenCodeModelsSectionProps {
  /** Directory OpenCode discovers providers for; refresh is unavailable without one. */
  workspacePath?: string;
  hiddenModels: string[];
  /** opencode.json `model` value: `provider/model`, without the `opencode:` prefix. */
  selectedModelId: string;
  onSelectModel: (modelId: string) => void;
  onVisibilityToggle: (modelId: string, visible: boolean) => void;
  onSetVisibilityForModels: (modelIds: string[], visible: boolean) => void;
}

interface CatalogStatusCopy {
  tone: 'info' | 'warning';
  headline: string;
  detail: string;
}

/**
 * What the user is looking at, and what to do about it. The cold state matters
 * most: before a first discovery the list is only the built-in fallback, so a
 * user who configured their own providers (OpenRouter, an LM Studio bridge)
 * will not see them until they refresh (#916, #859).
 */
export function describeCatalogStatus(
  snapshot: OpenCodeModelCatalogSnapshot
): CatalogStatusCopy {
  if (snapshot.cacheStatus === 'cold') {
    return {
      tone: 'warning',
      headline: translate('settings:providers.openCodeModels.coldHeadline'),
      detail:
        translate('settings:providers.openCodeModels.coldDetail'),
    };
  }

  if (snapshot.cacheStatus === 'stale' && snapshot.staleReason === 'identity-changed') {
    return {
      tone: 'warning',
      headline: translate('settings:providers.openCodeModels.identityChangedHeadline'),
      detail:
        translate('settings:providers.openCodeModels.identityChangedDetail'),
    };
  }

  if (snapshot.cacheStatus === 'stale') {
    return {
      tone: 'warning',
      headline: translate('settings:providers.openCodeModels.staleHeadline'),
      detail: translate('settings:providers.openCodeModels.staleDetail', { time: formatTimestamp(snapshot.refreshedAt) }),
    };
  }

  return {
    tone: 'info',
    headline: translate('settings:providers.openCodeModels.connectedProviders', { count: countProviders(snapshot.models) }),
    detail: translate('settings:providers.openCodeModels.freshDetail', { time: formatTimestamp(snapshot.refreshedAt) }),
  };
}

export function useOpenCodeModelCatalog(workspacePath?: string) {
  const [snapshot, setSnapshot] = useState<OpenCodeModelCatalogSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspacePath) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    // Read-only path: it reuses an OpenCode server only if one is already
    // running, so opening settings never spawns `opencode serve`.
    void (async () => {
      try {
        const response = await window.electronAPI.openCodeModelCatalogGet({ workspacePath });
        if (cancelled) return;
        if (response.success) {
          setSnapshot(response.catalog);
          setError(response.catalog.error ?? null);
        } else {
          setError(response.error);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [workspacePath]);

  const refresh = useCallback(async () => {
    if (!workspacePath) return;
    setRefreshing(true);
    setError(null);
    try {
      const response = await window.electronAPI.openCodeModelCatalogRefresh({ workspacePath });
      if (response.success) {
        setSnapshot(response.catalog);
        setError(response.catalog.error ?? null);
      } else {
        setError(response.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }, [workspacePath]);

  return { snapshot, loading, refreshing, error, refresh };
}

export function OpenCodeModelsSection({
  workspacePath,
  hiddenModels,
  selectedModelId,
  onSelectModel,
  onVisibilityToggle,
  onSetVisibilityForModels,
}: OpenCodeModelsSectionProps) {
  const { t } = useTranslation('settings');
  const { snapshot, loading, refreshing, error, refresh } = useOpenCodeModelCatalog(workspacePath);
  const [filter, setFilter] = useState('');

  const models = useMemo(() => sortModels(snapshot?.models ?? []), [snapshot]);
  const visibleModels = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return models;
    return models.filter(
      (model) =>
        model.name.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle)
    );
  }, [models, filter]);

  const status = snapshot ? describeCatalogStatus(snapshot) : null;
  const selectOptions = useMemo(
    () => buildSelectOptions(models, selectedModelId),
    // `t` re-derives the translated option labels after a language change.
    [models, selectedModelId, t]
  );

  return (
    <div className="opencode-models-section provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)]">
      <div className="flex items-start justify-between gap-3 mb-3">
        <h4 className="provider-panel-section-title text-base font-semibold text-[var(--nim-text)]">{t('providers.openCodeModels.title')}</h4>
        <div className="flex flex-col items-end gap-1">
          <button
            data-testid="opencode-models-refresh"
            className="inline-flex items-center justify-center py-1.5 px-3 rounded-md text-xs font-medium cursor-pointer transition-all bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)] border border-[var(--nim-border)] hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)] disabled:opacity-60 disabled:cursor-not-allowed"
            onClick={() => { void refresh(); }}
            disabled={refreshing || !workspacePath}
          >
            {refreshing ? t('providers.openCodeModels.discovering') : t('providers.openCodeModels.discover')}
          </button>
          <span className="text-[11px] text-[var(--nim-text-faint)]">
            {workspacePath
              ? t('providers.openCodeModels.startsBriefly')
              : t('providers.openCodeModels.openProject')}
          </span>
        </div>
      </div>

      {loading && (
        <p className="text-[13px] text-[var(--nim-text-muted)] py-2">{t('providers.shared.loadingModels')}</p>
      )}

      {!loading && status && (
        <div
          data-testid="opencode-catalog-status"
          className={`opencode-catalog-status rounded-md px-3 py-2 mb-3 border ${
            status.tone === 'warning'
              ? 'border-[var(--nim-warning)] bg-[var(--nim-bg-secondary)]'
              : 'border-[var(--nim-border)] bg-[var(--nim-bg-secondary)]'
          }`}
        >
          <p className="text-[13px] font-medium text-[var(--nim-text)]">{status.headline}</p>
          <p className="text-xs text-[var(--nim-text-muted)] leading-relaxed mt-1">{status.detail}</p>
        </div>
      )}

      {error && (
        <div className="opencode-catalog-error text-xs mb-3 text-[var(--nim-error)]">
          {t('providers.openCodeModels.discoveryFailed', { error })}
        </div>
      )}

      <label className="block text-[13px] text-[var(--nim-text)] mb-1">{t('providers.openCodeModels.defaultModel')}</label>
      <p className="text-xs text-[var(--nim-text-muted)] mb-2 leading-relaxed">
        <Trans
          t={t}
          i18nKey="providers.openCodeModels.defaultModelHint"
          values={{ field: 'model', file: 'opencode.json' }}
          components={{ code: <code className="text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-1 rounded" /> }}
        />
      </p>
      <select
        data-testid="opencode-model-select"
        value={selectedModelId}
        onChange={(e) => onSelectModel(e.target.value)}
        className="w-full py-2 px-3 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)] mb-4"
      >
        <option value="">{t('providers.openCodeModels.openCodeDefault')}</option>
        {selectOptions.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>

      {!loading && models.length > 0 && (
        <>
          <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
            <input
              data-testid="opencode-models-filter"
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('providers.openCodeModels.filterPlaceholder')}
              className="flex-1 min-w-[180px] py-1.5 px-3 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[13px] text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)]"
            />
            <div className="flex gap-2">
              <button
                data-testid="opencode-models-show-all"
                className="text-xs py-1 px-2 rounded bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text-muted)] hover:text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] cursor-pointer transition-all"
                onClick={() => onSetVisibilityForModels(visibleModels.map((m) => m.id), true)}
              >
                {t('providers.shared.showAll')}
              </button>
              <button
                data-testid="opencode-models-hide-all"
                className="text-xs py-1 px-2 rounded bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text-muted)] hover:text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] cursor-pointer transition-all"
                onClick={() => onSetVisibilityForModels(visibleModels.map((m) => m.id), false)}
              >
                {t('providers.shared.hideAll')}
              </button>
            </div>
          </div>

          <div className="models-grid flex flex-col gap-1.5">
            {visibleModels.map((model) => {
              const metadata = describeModelMetadata(model);
              return (
              <label
                key={model.id}
                className="opencode-model-row flex items-start gap-3 py-2 px-3 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] cursor-pointer hover:bg-[var(--nim-bg-hover)]"
              >
                <input
                  type="checkbox"
                  checked={!hiddenModels.includes(model.id)}
                  onChange={(e) => onVisibilityToggle(model.id, e.target.checked)}
                  className="w-4 h-4 mt-0.5 cursor-pointer accent-[var(--nim-primary)]"
                />
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm text-[var(--nim-text)]">{model.name}</span>
                    {model.status && model.status !== 'active' && (
                      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)]">
                        {model.status}
                      </span>
                    )}
                    {model.unavailable && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--nim-bg-tertiary)] text-[var(--nim-warning)]">
                        {t('providers.openCodeModels.providerNotConnected')}
                      </span>
                    )}
                  </span>
                  <span className="block text-[11px] text-[var(--nim-text-faint)] font-mono truncate">
                    {stripPrefix(model.id)}
                  </span>
                  {metadata && (
                    <span className="block text-[11px] text-[var(--nim-text-muted)]">
                      {metadata}
                    </span>
                  )}
                </span>
              </label>
              );
            })}
            {visibleModels.length === 0 && (
              <p className="text-[13px] text-[var(--nim-text-muted)] py-2">{t('providers.openCodeModels.noMatch')}</p>
            )}
          </div>
          <p className="text-[11px] text-[var(--nim-text-faint)] leading-relaxed mt-3">
            {t('providers.openCodeModels.uncheckedHint')}
          </p>
        </>
      )}

      {!loading && models.length === 0 && (
        <p className="text-[13px] text-[var(--nim-text-muted)] py-2">
          <Trans
            t={t}
            i18nKey="providers.openCodeModels.noModelsYet"
            values={{ command: 'opencode auth login' }}
            components={{ code: <code className="text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-1 rounded" /> }}
          />
        </p>
      )}
    </div>
  );
}

function sortModels(models: AIModel[]): AIModel[] {
  return [...models].sort((a, b) => a.id.localeCompare(b.id));
}

function countProviders(models: AIModel[]): number {
  return new Set(models.map((model) => stripPrefix(model.id).split('/')[0])).size;
}

function stripPrefix(modelId: string): string {
  return modelId.replace(/^opencode:/, '');
}

/**
 * The select carries the id shape opencode.json wants (`provider/model`), and
 * always includes the current selection even when discovery does not know it,
 * so opening settings can never silently drop the configured default.
 */
function buildSelectOptions(
  models: AIModel[],
  selectedModelId: string
): Array<{ value: string; label: string }> {
  const options = models.map((model) => ({
    value: stripPrefix(model.id),
    label: model.unavailable ? translate('settings:providers.openCodeModels.optionProviderNotConnected', { name: model.name }) : model.name,
  }));
  if (selectedModelId && !options.some((option) => option.value === selectedModelId)) {
    options.unshift({ value: selectedModelId, label: translate('settings:providers.openCodeModels.optionNotDiscovered', { id: selectedModelId }) });
  }
  return options;
}

function describeModelMetadata(model: AIModel): string {
  const parts: string[] = [];
  if (model.contextWindow) parts.push(translate('settings:providers.openCodeModels.contextTokens', { tokens: formatTokens(model.contextWindow) }));
  if (model.cost && (model.cost.input || model.cost.output)) {
    parts.push(translate('settings:providers.openCodeModels.costPerMtok', { input: formatCost(model.cost.input), output: formatCost(model.cost.output) }));
  }
  return parts.join('  ·  ');
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

function formatCost(value: number): string {
  return value >= 1 ? value.toFixed(2) : value.toFixed(3);
}

function formatTimestamp(refreshedAt: number | null): string {
  if (!refreshedAt) return translate('settings:providers.openCodeModels.never');
  return new Date(refreshedAt).toLocaleString();
}
