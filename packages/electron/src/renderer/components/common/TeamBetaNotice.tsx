/**
 * The single source of the "Nimbalyst Teams is in beta" disclosure.
 *
 * Every surface that lets someone create, join, or administer an organization
 * shows this (or the matching `AlphaBadge` tooltip) so nobody adopts team
 * collaboration without knowing it is beta-quality and will be paid after
 * launch. Keep the wording in `TEAM_BETA_TOOLTIP` and the notice in sync.
 */

import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { Trans, useTranslation } from '@nimbalyst/runtime/i18n/react';

/** Tooltip copy for the beta `AlphaBadge` on organization surfaces. */
export const TEAM_BETA_TOOLTIP =
  'Nimbalyst Teams is in beta. Expect bugs.\n\nOrganizations are free during beta and will require a paid Nimbalyst Teams subscription after launch.';

export function TeamBetaNotice({ className = '' }: { className?: string }) {
  const { t } = useTranslation('general');
  return (
    <div
      className={`team-beta-notice flex items-start gap-1.5 text-[12px] leading-relaxed text-[var(--nim-text-faint)] ${className}`.trim()}
      data-testid="team-beta-notice"
    >
      <MaterialSymbol icon="info" size={13} className="mt-[2px] shrink-0" />
      <span>
        <Trans t={t} i18nKey="teamBetaNotice.text" components={{ highlight: <span className="text-[var(--nim-text-muted)]" /> }} />
      </span>
    </div>
  );
}
