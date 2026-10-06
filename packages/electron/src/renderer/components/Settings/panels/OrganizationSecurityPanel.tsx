import React from 'react';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';
import { SecurityEncryptionSection } from './SecurityEncryptionSection';

export function OrganizationSecurityPanel({ orgId }: { orgId?: string }) {
  const { t } = useTranslation('settings');
  return (
    <section className="organization-security-panel" data-testid="organization-security-panel" data-component="OrganizationSecurityPanel">
      <header className="mb-5 border-b border-[var(--nim-border)] pb-4"><h2 className="m-0 text-xl font-semibold">{t('orgSecurity.title')}</h2><p className="m-0 mt-1 text-sm text-[var(--nim-text-muted)]">{t('orgSecurity.description')}</p></header>
      {orgId ? <SecurityEncryptionSection orgId={orgId} /> : <p className="text-sm text-[var(--nim-text-muted)]">{t('organization.chooseOrganization')}</p>}
    </section>
  );
}
