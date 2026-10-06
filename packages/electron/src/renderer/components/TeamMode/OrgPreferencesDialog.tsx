import React from 'react';
import { useAtom } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';

import { settingAtom } from '../../store/atoms/settingAtomFamily';
import { OrgDialog, OrgDialogSecondaryButton } from './OrgDialog';

type MessageDensity = 'comfortable' | 'compact';

interface DensityChoice {
  value: MessageDensity;
  label: string;
  detail: string;
  icon: string;
}

const DENSITY_CHOICES: DensityChoice[] = [
  {
    value: 'comfortable',
    label: 'preferences.density.comfortable.label',
    detail: 'preferences.density.comfortable.detail',
    icon: 'view_agenda',
  },
  {
    value: 'compact',
    label: 'preferences.density.compact.label',
    detail: 'preferences.density.compact.detail',
    icon: 'view_headline',
  },
];

/**
 * The org window's own preferences.
 *
 * These are the settings that belong to this window rather than to the
 * organization — how the window shows you things, not what the organization is
 * configured to do. Organization administration stays in the admin tabs.
 *
 * Each preference is a section so the dialog can grow another one without a
 * second design; today there is exactly one.
 */
export function OrgPreferencesDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('team');
  return (
    <OrgDialog
      title={t('preferences.title')}
      description={t('preferences.description')}
      testId="org-preferences-dialog"
      onClose={onClose}
      footer={
        // Every preference here writes through on change, so there is nothing
        // to submit — the only button closes.
        <OrgDialogSecondaryButton testId="org-preferences-done" onClick={onClose}>
          {t('common:done')}
        </OrgDialogSecondaryButton>
      }
    >
      <MessageDisplaySection />
    </OrgDialog>
  );
}

function MessageDisplaySection() {
  const { t } = useTranslation('team');
  const [density, setDensity] = useAtom(settingAtom('team.messages.density'));

  return (
    <section className="org-preferences-section" data-testid="org-preferences-message-display">
      <h4 className="m-0 mb-1 text-[12px] font-semibold uppercase tracking-wide text-[var(--nim-text-faint)]">
        {t('preferences.messageDisplay')}
      </h4>
      <p className="m-0 mb-2.5 text-[12px] text-[var(--nim-text-muted)]">
        {t('preferences.messageDisplayHint')}
      </p>
      <div className="org-preferences-density flex flex-col gap-2" role="radiogroup" aria-label={t('preferences.messageDisplay')}>
        {DENSITY_CHOICES.map((choice) => {
          const selected = density === choice.value;
          return (
            <button
              key={choice.value}
              type="button"
              role="radio"
              aria-checked={selected}
              data-testid={`org-preferences-density-${choice.value}`}
              data-selected={selected ? 'true' : 'false'}
              onClick={() => { void setDensity(choice.value); }}
              className={`org-preferences-density-option flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left ${
                selected
                  ? 'border-[var(--nim-primary)] bg-[color-mix(in_srgb,var(--nim-primary)_10%,transparent)]'
                  : 'border-[var(--nim-border)] hover:bg-[var(--nim-bg-hover)]'
              }`}
            >
              <MaterialSymbol
                icon={selected ? 'radio_button_checked' : 'radio_button_unchecked'}
                size={16}
                className={selected ? 'text-[var(--nim-primary)]' : 'text-[var(--nim-text-faint)]'}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--nim-text)]">
                  <MaterialSymbol icon={choice.icon} size={14} />
                  {t(choice.label)}
                </span>
                <span className="mt-0.5 block text-[12px] text-[var(--nim-text-muted)]">
                  {t(choice.detail)}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
