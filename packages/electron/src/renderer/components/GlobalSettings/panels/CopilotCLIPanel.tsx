import React, { useState, useEffect, useCallback } from 'react';
import { ProviderConfig } from '../../Settings/SettingsView';
import { SettingsToggle } from '../SettingsToggle';
import { AlphaBadge, SETTINGS_ALPHA_TOOLTIP } from '../../common/AlphaBadge';
import { useTranslation, Trans } from '@nimbalyst/runtime/i18n/react';

interface CopilotCLIPanelProps {
  config: ProviderConfig;
  apiKeys: Record<string, string>;
  availableModels: any[];
  loading: boolean;
  onToggle: (enabled: boolean) => void;
  onApiKeyChange: (key: string, value: string) => void;
  onModelToggle: (modelId: string, enabled: boolean) => void;
  onSelectAllModels: (selectAll: boolean) => void;
  onTestConnection: () => Promise<void>;
  onConfigChange: (updates: Partial<ProviderConfig>) => void;
}

type CLIStatus = 'checking' | 'installed' | 'not-installed' | 'installing' | 'install-error';

export function CopilotCLIPanel({
  config,
  onToggle,
}: CopilotCLIPanelProps) {
  const { t } = useTranslation('settings');
  const [cliStatus, setCLIStatus] = useState<CLIStatus>('checking');
  const [cliVersion, setCLIVersion] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  const checkCLI = useCallback(async () => {
    setCLIStatus('checking');
    try {
      const result = await window.electronAPI.invoke('cli:checkInstallation', 'copilot-cli');
      if (result?.installed) {
        setCLIVersion(result.version || null);
        setCLIStatus('installed');
      } else {
        setCLIStatus('not-installed');
      }
    } catch {
      setCLIStatus('not-installed');
    }
  }, []);

  useEffect(() => {
    checkCLI();
  }, [checkCLI]);

  const handleInstall = async () => {
    setCLIStatus('installing');
    setInstallError(null);
    try {
      await window.electronAPI.invoke('cli:install', 'copilot-cli', {});
      await checkCLI();
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err));
      setCLIStatus('install-error');
    }
  };

  return (
    <div className="provider-panel flex flex-col">
      <div className="provider-panel-header mb-6 pb-4 border-b border-[var(--nim-border)]">
        <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-2 text-[var(--nim-text)] flex items-center gap-2">
          GitHub Copilot
          <AlphaBadge size="sm" tooltip={SETTINGS_ALPHA_TOOLTIP} />
        </h3>
        <p className="provider-panel-description text-sm leading-relaxed text-[var(--nim-text-muted)]">
          {t('providers.copilotCli.description')}
        </p>
      </div>

      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)]">
        <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">Copilot CLI</h4>

        {cliStatus === 'checking' && (
          <p className="text-[13px] text-[var(--nim-text-muted)]">{t('providers.copilotCli.checking')}</p>
        )}

        {cliStatus === 'installed' && (
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[var(--nim-success)] shrink-0" />
            <span className="text-[13px] text-[var(--nim-text)]">
              {cliVersion ? t('providers.shared.installedVersion', { version: cliVersion }) : t('providers.shared.installed')}
            </span>
          </div>
        )}

        {(cliStatus === 'not-installed' || cliStatus === 'install-error') && (
          <div>
            <p className="text-[13px] text-[var(--nim-text-muted)] mb-3 leading-relaxed">
              {t('providers.copilotCli.required')}
            </p>
            <code className="block text-[13px] text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-3 py-2 rounded mb-3 select-text">
              npm install -g @github/copilot
            </code>
            <button
              className="inline-flex items-center justify-center py-2 px-4 rounded-md text-sm font-medium cursor-pointer transition-all bg-[var(--nim-primary)] text-white border border-[var(--nim-primary)] hover:opacity-90"
              onClick={handleInstall}
            >
              {t('providers.copilotCli.install')}
            </button>
            {installError && (
              <div className="text-xs mt-2 text-[var(--nim-error)]">
                {installError}
                <p className="mt-1 text-[var(--nim-text-muted)]">
                  <Trans t={t} i18nKey="providers.shared.tryRunningManually" values={{ command: 'npm install -g @github/copilot' }} components={{ code: <code className="text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-1 rounded" /> }} />
                </p>
              </div>
            )}
          </div>
        )}

        {cliStatus === 'installing' && (
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-[var(--nim-text-muted)]">{t('providers.copilotCli.installing')}</span>
          </div>
        )}

        <p className="text-[13px] text-[var(--nim-text-muted)] mt-3 leading-relaxed">
          <Trans
            t={t}
            i18nKey="providers.shared.seeDocsInstallAuth"
            values={{ label: t('providers.copilotCli.docsLabel') }}
            components={{
              link: (
                <a
                  href="https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--nim-primary)] hover:underline"
                />
              ),
            }}
          />
        </p>
      </div>

      <SettingsToggle
        variant="enable"
        name={t('providers.shared.enableProvider', { name: 'GitHub Copilot' })}
        checked={config.enabled || false}
        onChange={onToggle}
      />

      {config.enabled && (
        <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
          <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">{t('providers.shared.authentication')}</h4>
          <div className="cli-config-section">
            <p className="text-[13px] text-[var(--nim-text-muted)] mb-3">
              <Trans t={t} i18nKey="providers.copilotCli.authBody" values={{ command: 'copilot', loginCommand: '/login' }} components={{ code: <code className="text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-1 rounded" /> }} />
            </p>
            <p className="text-[13px] text-[var(--nim-text-muted)]">
              {t('providers.copilotCli.modelSelection')}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
