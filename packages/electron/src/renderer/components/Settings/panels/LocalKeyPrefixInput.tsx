import React, { useCallback, useEffect, useState } from 'react';
import { requestConfirmation } from '../../../dialogs/requestConfirmation';
import { useTranslation, Trans } from '@nimbalyst/runtime/i18n/react';

export interface LocalKeyPrefixConfig {
  prefix: string;
  hasIssuedNumbers: boolean;
  matchesTeamPrefix: boolean;
  warning?: string;
}

const LOCAL_KEY_PREFIX_PATTERN = /^[A-Z]{2,5}$/;

export function LocalKeyPrefixInput({ config, teamPrefix, onChange }: {
  config: LocalKeyPrefixConfig;
  teamPrefix: string;
  onChange: (prefix: string) => Promise<LocalKeyPrefixConfig>;
}) {
  const [draft, setDraft] = useState(config.prefix);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const { t } = useTranslation('settings');

  useEffect(() => {
    setDraft(config.prefix);
    setError('');
  }, [config.prefix]);

  const handleBlur = useCallback(async () => {
    const upper = draft.trim().toUpperCase();
    if (!LOCAL_KEY_PREFIX_PATTERN.test(upper)) {
      setError(t('localKeyPrefix.invalid'));
      return;
    }
    if (upper === config.prefix) return;

    // Renumbering is not what happens -- `NIM.42` becomes `NIC.42` -- but an
    // already-written reference to the old letters stops resolving, so say so
    // before doing it rather than after.
    if (config.hasIssuedNumbers && !(await requestConfirmation({
      title: t('localKeyPrefix.renameConfirmTitle'),
      message: t('localKeyPrefix.renameConfirmMessage', { from: config.prefix, to: upper }),
      confirmLabel: t('localKeyPrefix.renameConfirmLabel'),
    }))) {
      setDraft(config.prefix);
      return;
    }

    setSaving(true);
    setError('');
    try {
      const next = await onChange(upper);
      setDraft(next.prefix);
    } catch (changeError) {
      setError(changeError instanceof Error ? changeError.message : t('localKeyPrefix.changeFailed'));
    } finally {
      setSaving(false);
    }
  }, [config.hasIssuedNumbers, config.prefix, draft, onChange, t]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      (event.target as HTMLInputElement).blur();
    }
  }, []);

  return (
    <div className="local-key-prefix-section provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
      <h4 className="provider-panel-section-title text-[15px] font-semibold mb-2 text-[var(--nim-text)]">
        {t('localKeyPrefix.title')}
      </h4>
      <p className="text-[13px] leading-relaxed text-[var(--nim-text-muted)] mb-3">
        <Trans t={t} i18nKey="localKeyPrefix.description" values={{ prefix: draft || 'NIM' }} components={{ code: <code className="text-[11px] text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-1 py-[1px] rounded" /> }} />
      </p>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={draft}
          disabled={saving}
          onChange={(event) => {
            setDraft(event.target.value.toUpperCase());
            setError('');
          }}
          onBlur={() => void handleBlur()}
          onKeyDown={handleKeyDown}
          maxLength={5}
          placeholder="NIM"
          aria-label={t('localKeyPrefix.inputAriaLabel')}
          className="local-key-prefix-input w-24 px-2.5 py-1.5 text-[13px] font-mono bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        />
        <span className="text-[13px] text-[var(--nim-text-faint)]">.123</span>
      </div>
      {error && <p className="text-[11px] text-[var(--nim-error)] mt-1.5">{error}</p>}
      {config.warning && !error && (
        <p className="local-key-prefix-warning text-[11px] text-[var(--nim-warning)] mt-1.5">{config.warning}</p>
      )}
      <p className="text-[11px] text-[var(--nim-text-faint)] mt-2">
        {config.hasIssuedNumbers
          ? t('localKeyPrefix.issuedHint', { teamPrefix: teamPrefix || t('localKeyPrefix.notAssigned') })
          : t('localKeyPrefix.notIssuedHint')}
      </p>
    </div>
  );
}
