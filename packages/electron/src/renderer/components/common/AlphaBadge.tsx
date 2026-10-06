import React, { useState } from 'react';
import {
  FloatingPortal,
  flip,
  offset,
  shift,
  useFloating,
  useHover,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import { windowControlsClearance } from '@nimbalyst/runtime/ui/floating/windowControlsClearance';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';
import { TEAM_BETA_TOOLTIP } from './TeamBetaNotice';

interface AlphaBadgeProps {
  /**
   * `xs` and `sm` render the lowercase stage word as a pill (sidebar rows / panel headers).
   * `dot` renders just the Greek letter — for tight spots like square icon buttons.
   */
  size?: 'xs' | 'sm' | 'dot';
  /** Maturity the badge announces. Teams surfaces pass `beta`; everything else is alpha. */
  stage?: 'alpha' | 'beta';
  className?: string;
  tooltip?: string;
}

const DEFAULT_TOOLTIP = 'Alpha feature — may change or be removed.';
export const SETTINGS_ALPHA_TOOLTIP =
  'Alpha features may be incomplete, and shared data may be lost.\n\nTeam features are free during beta and will be part of a Nimbalyst Teams subscription in the future.';

const STAGE_LABELS = {
  alpha: { word: 'alpha', dot: 'α', title: 'Alpha' },
  beta: { word: 'beta', dot: 'β', title: 'Beta' },
} as const;

/**
 * The shared English tooltip constants are passed in as props by many callers;
 * map them to their translation here so every badge follows the UI language.
 * Any other caller-supplied tooltip renders as given.
 */
const KNOWN_TOOLTIP_KEYS: Record<string, string> = {
  [DEFAULT_TOOLTIP]: 'alphaBadge.defaultTooltip',
  [SETTINGS_ALPHA_TOOLTIP]: 'alphaBadge.settingsTooltip',
  [TEAM_BETA_TOOLTIP]: 'alphaBadge.teamBetaTooltip',
};

const PILL_BASE = 'inline-flex items-center font-medium lowercase bg-[var(--nim-bg-tertiary)] border border-[var(--nim-border)]';

const SIZE_CLASSES: Record<NonNullable<AlphaBadgeProps['size']>, string> = {
  xs: `${PILL_BASE} px-2 py-px rounded-full text-[10px] text-[var(--nim-text-faint)]`,
  sm: `${PILL_BASE} px-2.5 py-0.5 rounded-full text-[11px] text-[var(--nim-text-muted)] align-middle`,
  dot: 'inline-flex items-center justify-center text-[10px] leading-none font-semibold text-[var(--nim-text-faint)]',
};

export const AlphaBadge: React.FC<AlphaBadgeProps> = ({
  size = 'xs',
  stage = 'alpha',
  className = '',
  tooltip = DEFAULT_TOOLTIP,
}) => {
  const { t } = useTranslation('general');
  const label = STAGE_LABELS[stage];
  const stageTitle = t(`alphaBadge.stage.${stage}.title`);
  const tooltipKey = tooltip ? KNOWN_TOOLTIP_KEYS[tooltip] : undefined;
  const tooltipText = tooltipKey ? t(tooltipKey) : tooltip;
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const { refs, floatingStyles, context } = useFloating({
    open: tooltipOpen,
    onOpenChange: setTooltipOpen,
    placement: 'top',
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 }), windowControlsClearance()],
  });
  const hover = useHover(context, { delay: { open: 250, close: 0 }, move: false });
  const role = useRole(context, { role: 'tooltip' });
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, role]);

  return (
    <>
      <span
        ref={refs.setReference}
        data-testid="alpha-badge"
        data-stage={stage}
        aria-label={t(`alphaBadge.stage.${stage}.ariaLabel`)}
        className={`${SIZE_CLASSES[size]} ${className}`.trim()}
        {...getReferenceProps()}
      >
        {size === 'dot' ? label.dot : t(`alphaBadge.stage.${stage}.word`)}
      </span>
      {tooltipOpen && tooltipText && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            className="help-tooltip pointer-events-none z-[10002] max-w-[320px] px-3 py-2.5 bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-lg shadow-[0_4px_16px_rgba(0,0,0,0.15),0_2px_4px_rgba(0,0,0,0.1)] text-xs leading-normal text-[var(--nim-text-muted)] whitespace-pre-wrap"
            style={floatingStyles}
            {...getFloatingProps()}
          >
            <div className="mb-1 text-[13px] font-semibold text-[var(--nim-text)]">{stageTitle}</div>
            {tooltipText}
          </div>
        </FloatingPortal>
      )}
    </>
  );
};
