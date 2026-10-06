import React from 'react';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';

export interface ShareAccountOption {
  personalOrgId: string;
  email: string | null;
  isSyncAccount: boolean;
  sessionStatus: 'active' | 'expired';
}

export interface ShareAccountPickerProps {
  accounts: ShareAccountOption[];
  selectedPersonalOrgId: string;
  defaultSource: 'workspace-binding' | 'sync-account' | 'only-account';
  onChange: (personalOrgId: string) => void;
}

export function ShareAccountPicker({ accounts, selectedPersonalOrgId, defaultSource, onChange }: ShareAccountPickerProps) {
  const { t } = useTranslation('team');
  return (
    <fieldset className="share-account-picker m-0 flex flex-col gap-2 border-0 p-0" data-testid="share-account-picker" data-component="ShareAccountPicker">
      <legend className="mb-1 text-xs font-semibold text-[var(--nim-text)]">{t('share.accountPicker.createAs')}</legend>
      {accounts.map((account) => (
        <label
          key={account.personalOrgId}
          className={`share-account-picker-option flex cursor-pointer items-center gap-3 rounded-lg border p-3 ${
            selectedPersonalOrgId === account.personalOrgId
              ? 'border-[var(--nim-primary)] bg-[color-mix(in_srgb,var(--nim-primary)_8%,transparent)]'
              : 'border-[var(--nim-border)] bg-[var(--nim-bg-secondary)]'
          }`}
        >
          <input
            type="radio"
            name="share-account"
            value={account.personalOrgId}
            checked={selectedPersonalOrgId === account.personalOrgId}
            onChange={() => onChange(account.personalOrgId)}
          />
          <span className="min-w-0 flex-1 select-text text-[13px] text-[var(--nim-text)]">{account.email}</span>
          {account.isSyncAccount && <span className="text-[10px] text-[var(--nim-text-muted)]">{t('share.accountPicker.syncAccount')}</span>}
        </label>
      ))}
      <p className="m-0 text-[11px] text-[var(--nim-text-muted)]">
        {defaultSource === 'workspace-binding'
          ? t('share.accountPicker.defaultWorkspace')
          : defaultSource === 'sync-account'
            ? t('share.accountPicker.defaultSync')
            : t('share.accountPicker.onlyAccount')}
      </p>
    </fieldset>
  );
}
