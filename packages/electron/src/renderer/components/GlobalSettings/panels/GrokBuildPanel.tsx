import React from 'react';
import { ProviderConfig } from '../../Settings/SettingsView';
import { HeadlessCliProviderPanel } from './HeadlessCliProviderPanel';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';

interface GrokBuildPanelProps {
  config: ProviderConfig;
  onToggle: (enabled: boolean) => void;
}

export function GrokBuildPanel({ config, onToggle }: GrokBuildPanelProps) {
  const { t } = useTranslation('settings');
  return (
    <HeadlessCliProviderPanel
      config={config}
      onToggle={onToggle}
      toolId="grok-build"
      title="Grok Build"
      description={t('providers.grokBuild.description')}
      commandName="Grok"
      loginCommand="grok login"
      docsUrl="https://docs.x.ai/build/cli/headless-scripting"
      docsLabel={t('providers.grokBuild.docsLabel')}
      // Grok has no delete or move tool, so removals only appear as shell
      // commands and the filesystem watcher has to catch them.
      fileChangeFidelity="tool-args"
    />
  );
}
