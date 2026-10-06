import React from 'react';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';
import {
  MENU_BAR_ISLAND_CHANNELS,
  type MenuBarIslandSettingChange,
  type MenuBarIslandSettings,
  type PreventSleepMode,
} from '../../../shared/menuBarIsland';

/**
 * The island's own settings.
 *
 * It exists because island mode removes the tray item, and with it the
 * right-click menu that used to own these. Deliberately not a second copy of app
 * Settings: it carries only what a user standing in front of the menu bar needs
 * to change about the menu bar, plus the notification toggle, which is the thing
 * people find duplicative once the island is telling them the same news.
 *
 * Every value arrives on the frame from main, so this component holds no state
 * of its own -- a change goes out over IPC and comes back as the next frame.
 */

const FOCUS_RING = 'focus:outline-none focus-visible:outline-2 focus-visible:outline-[var(--nim-border-focus)] focus-visible:outline-offset-[-2px]';

function send(change: MenuBarIslandSettingChange): void {
  window.electronAPI.send(MENU_BAR_ISLAND_CHANNELS.setSetting, change);
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 px-3.5 py-2">
      <div className="min-w-0">
        <div className="text-[12px] text-nim">{label}</div>
        {hint && <div className="mt-0.5 text-[10.5px] leading-snug text-nim-faint">{hint}</div>}
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}

/**
 * A pill switch rather than a checkbox.
 *
 * The panel sits on the app's themed surface but is read at a glance from the
 * menu bar, where a 13px checkbox's state is genuinely hard to see.
 */
function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-[18px] w-[32px] rounded-full transition-colors ${
        checked ? 'bg-nim-primary' : 'bg-nim-tertiary'
      } ${FOCUS_RING}`}
    >
      <span
        className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-[left] ${
          checked ? 'left-[16px]' : 'left-[2px]'
        }`}
      />
    </button>
  );
}

function SegmentedChoice<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (next: T) => void;
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-md bg-nim-tertiary p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={option.value === value}
          className={`rounded px-2 py-[3px] text-[11px] transition-colors ${
            option.value === value ? 'bg-nim text-nim shadow-sm' : 'text-nim-muted hover:text-nim'
          } ${FOCUS_RING}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function MenuBarIslandSettingsPanel({ settings }: { settings: MenuBarIslandSettings }) {
  const { t } = useTranslation('onboarding');
  return (
    <div data-testid="menu-bar-island-settings">
      <Row
        label={t('island.settings.style')}
        hint={settings.style === 'island'
          ? t('island.settings.styleIslandHint')
          : t('island.settings.styleImageHint')}
      >
        <SegmentedChoice
          value={settings.style}
          options={[{ value: 'island', label: t('island.settings.styleIsland') }, { value: 'image', label: t('island.settings.styleIcon') }]}
          onChange={(value) => send({ key: 'style', value })}
        />
      </Row>

      <Row label={t('island.settings.showFleetStatus')} hint={t('island.settings.showFleetStatusHint')}>
        <Toggle
          label={t('island.settings.showFleetStatus')}
          checked={settings.showFleetStatus}
          onChange={(value) => send({ key: 'showFleetStatus', value })}
        />
      </Row>

      <Row
        label={t('island.settings.notifications')}
        hint={t('island.settings.notificationsHint')}
      >
        <Toggle
          label={t('island.settings.notifications')}
          checked={settings.osNotifications}
          onChange={(value) => send({ key: 'osNotifications', value })}
        />
      </Row>

      {/* Null means sync is not configured, in which case preventing sleep has
          nothing to protect -- the tray menu hides it on the same condition. */}
      {settings.preventSleep !== null && (
        <Row label={t('island.settings.preventSleep')}>
          <SegmentedChoice<PreventSleepMode>
            value={settings.preventSleep}
            options={[
              { value: 'off', label: t('island.settings.preventSleepOff') },
              { value: 'pluggedIn', label: t('island.settings.preventSleepPluggedIn') },
              { value: 'always', label: t('island.settings.preventSleepAlways') },
            ]}
            onChange={(value) => send({ key: 'preventSleep', value })}
          />
        </Row>
      )}
    </div>
  );
}
