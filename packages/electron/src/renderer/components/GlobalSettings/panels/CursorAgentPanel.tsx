import React from 'react';
import { ProviderConfig } from '../../Settings/SettingsView';
import { HeadlessCliProviderPanel } from './HeadlessCliProviderPanel';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';

interface CursorAgentPanelProps {
  config: ProviderConfig;
  onToggle: (enabled: boolean) => void;
}

export function CursorAgentPanel({ config, onToggle }: CursorAgentPanelProps) {
  const { t } = useTranslation('settings');
  return (
    <HeadlessCliProviderPanel
      config={config}
      onToggle={onToggle}
      toolId="cursor-agent"
      title="Cursor Agent"
      description={t('providers.cursorAgent.description')}
      commandName="Cursor"
      loginCommand="cursor-agent login"
      docsUrl="https://cursor.com/docs/cli/using"
      docsLabel={t('providers.cursorAgent.docsLabel')}
      // Reports path, unified diff, and the file's pre-edit contents on every
      // edit, plus a typed delete carrying the removed file's contents.
      fileChangeFidelity="structured"
    />
  );
}
