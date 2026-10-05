import React, { useState, useEffect, useCallback } from 'react';
import { ProviderConfig } from '../../Settings/SettingsView';
import { SettingsToggle } from '../SettingsToggle';
import { AlphaBadge, SETTINGS_ALPHA_TOOLTIP } from '../../common/AlphaBadge';
import type { FileChangeFidelity } from '@nimbalyst/runtime/ai/server/providerFileTracking';
import { useTranslation, Trans } from '@nimbalyst/runtime/i18n/react';

/**
 * Settings panel for a CLI agent Nimbalyst detects but does not install.
 *
 * Unlike the npm-backed panels there is no Install button: neither vendor
 * publishes to npm, and Nimbalyst does not pipe a remote script to a shell.
 * The panel shows the vendor's own command and links their docs.
 *
 * It also states the provider's file-change fidelity plainly. A provider whose
 * edits are inferred by a filesystem watcher gives a diff review that can be
 * wrong at the margins, and the user is entitled to know that rather than
 * assume every panel means the same thing by "file tracking".
 */

type CLIStatus = 'checking' | 'installed' | 'signed-out' | 'not-installed';

export interface HeadlessCliProviderPanelProps {
  config: ProviderConfig;
  onToggle: (enabled: boolean) => void;
  /** CLIManager tool id, e.g. 'grok-build'. */
  toolId: string;
  title: string;
  description: string;
  /** Binary name, shown in the login instructions. */
  commandName: string;
  loginCommand: string;
  docsUrl: string;
  docsLabel: string;
  fileChangeFidelity: FileChangeFidelity;
}

interface InstallStrategy {
  kind: 'npm' | 'script';
  command?: string;
  docsUrl?: string;
}

/** i18n keys (settings namespace); translated at render time. */
const FIDELITY_COPY: Record<FileChangeFidelity, string> = {
  structured: 'providers.headlessCli.fidelity.structured',
  'tool-args': 'providers.headlessCli.fidelity.toolArgs',
  none: 'providers.headlessCli.fidelity.none',
};

export function HeadlessCliProviderPanel({
  config,
  onToggle,
  toolId,
  title,
  description,
  commandName,
  loginCommand,
  docsUrl,
  docsLabel,
  fileChangeFidelity,
}: HeadlessCliProviderPanelProps) {
  const { t } = useTranslation('settings');
  const [cliStatus, setCLIStatus] = useState<CLIStatus>('checking');
  const [cliVersion, setCLIVersion] = useState<string | null>(null);
  const [installCommand, setInstallCommand] = useState<string | null>(null);

  const checkCLI = useCallback(async () => {
    setCLIStatus('checking');
    let signedIn = false;
    try {
      // Sign-in state, not just presence: this provider is only on by default
      // when the CLI is BOTH installed and logged in, and the panel must say
      // which of the two is missing rather than reporting a bare "installed"
      // for a CLI that would fail on the first turn.
      const availability = await window.electronAPI.aiGetHeadlessAgentAvailability?.();
      signedIn = availability?.[toolId]?.signedIn ?? false;
    } catch {
      // Fall through to the install probe below.
    }
    try {
      const result = await window.electronAPI.invoke('cli:checkInstallation', toolId);
      if (result?.installed) {
        setCLIVersion(result.version || null);
        setCLIStatus(signedIn ? 'installed' : 'signed-out');
        return;
      }
    } catch {
      // Fall through to not-installed.
    }
    setCLIStatus('not-installed');
  }, [toolId]);

  useEffect(() => {
    void checkCLI();
  }, [checkCLI]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const strategy = await window.electronAPI.invoke('cli:getInstallStrategy', toolId) as InstallStrategy | null;
        if (!cancelled && strategy?.kind === 'script' && strategy.command) {
          setInstallCommand(strategy.command);
        }
      } catch {
        // The panel still works without it; the docs link covers the gap.
      }
    })();
    return () => { cancelled = true; };
  }, [toolId]);

  return (
    <div className="provider-panel headless-cli-provider-panel flex flex-col">
      <div className="provider-panel-header mb-6 pb-4 border-b border-[var(--nim-border)]">
        <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-2 text-[var(--nim-text)] flex items-center gap-2">
          {title}
          <AlphaBadge size="sm" tooltip={SETTINGS_ALPHA_TOOLTIP} />
        </h3>
        <p className="provider-panel-description text-sm leading-relaxed text-[var(--nim-text-muted)]">
          {description}
        </p>
      </div>

      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)]">
        <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">
          {commandName} CLI
        </h4>

        {cliStatus === 'checking' && (
          <p className="text-[13px] text-[var(--nim-text-muted)]">{t('providers.headlessCli.checking', { command: commandName })}</p>
        )}

        {cliStatus === 'installed' && (
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[var(--nim-success)] shrink-0" />
            <span className="text-[13px] text-[var(--nim-text)]">
              {cliVersion ? t('providers.headlessCli.installedSignedInVersion', { version: cliVersion }) : t('providers.headlessCli.installedSignedIn')}
            </span>
          </div>
        )}

        {cliStatus === 'signed-out' && (
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="w-2 h-2 rounded-full bg-[var(--nim-warning)] shrink-0" />
              <span className="text-[13px] text-[var(--nim-text)]">
                {cliVersion ? t('providers.headlessCli.signedOutVersion', { version: cliVersion }) : t('providers.headlessCli.signedOut')}
              </span>
            </div>
            <p className="text-[13px] text-[var(--nim-text-muted)] leading-relaxed">
              <Trans t={t} i18nKey="providers.headlessCli.runLoginThenCheck" values={{ command: loginCommand }} components={{ code: <code className="text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-1 rounded select-text" /> }} />
            </p>
            <button
              className="mt-3 inline-flex items-center justify-center py-2 px-4 rounded-md text-sm font-medium cursor-pointer transition-all bg-[var(--nim-surface)] text-[var(--nim-text)] border border-[var(--nim-border)] hover:bg-[var(--nim-surface-hover)]"
              onClick={() => void checkCLI()}
            >
              {t('providers.shared.checkAgain')}
            </button>
          </div>
        )}

        {cliStatus === 'not-installed' && (
          <div>
            <p className="text-[13px] text-[var(--nim-text-muted)] mb-3 leading-relaxed">
              {t('providers.headlessCli.notInstalled', { command: commandName })}
            </p>
            {installCommand && (
              <code className="block text-[13px] text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-3 py-2 rounded mb-3 select-text">
                {installCommand}
              </code>
            )}
            <button
              className="inline-flex items-center justify-center py-2 px-4 rounded-md text-sm font-medium cursor-pointer transition-all bg-[var(--nim-surface)] text-[var(--nim-text)] border border-[var(--nim-border)] hover:bg-[var(--nim-surface-hover)]"
              onClick={() => void checkCLI()}
            >
              {t('providers.shared.checkAgain')}
            </button>
          </div>
        )}

        <p className="text-[13px] text-[var(--nim-text-muted)] mt-3 leading-relaxed">
          <Trans
            t={t}
            i18nKey="providers.shared.seeDocsInstallAuth"
            values={{ label: docsLabel }}
            components={{
              link: (
                <a
                  href={docsUrl}
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
        name={t('providers.shared.enableProvider', { name: title })}
        checked={config.enabled || false}
        onChange={onToggle}
      />

      {cliStatus === 'installed' && (
        <p className="text-[13px] text-[var(--nim-text-muted)] mt-2 leading-relaxed">
          {t('providers.headlessCli.onByDefault', { command: commandName })}
        </p>
      )}

      {config.enabled && (
        <>
          <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)]">
            <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">{t('providers.shared.authentication')}</h4>
            <p className="text-[13px] text-[var(--nim-text-muted)] mb-3 leading-relaxed">
              <Trans t={t} i18nKey="providers.headlessCli.authUsesOwnLogin" values={{ title, command: loginCommand }} components={{ code: <code className="text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-1 rounded select-text" /> }} />
            </p>
            <p className="text-[13px] text-[var(--nim-text-muted)]">
              {t('providers.shared.noApiKeyRequired')}
            </p>
          </div>

          <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
            <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">{t('providers.shared.fileTracking')}</h4>
            <p className="text-[13px] text-[var(--nim-text-muted)] leading-relaxed">
              {t(FIDELITY_COPY[fileChangeFidelity])}
            </p>
            <p className="text-[13px] text-[var(--nim-text-muted)] mt-3 leading-relaxed">
              {t('providers.headlessCli.allowEditsRequired')}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
