import React from 'react';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';

export interface ExtensionProjectIntroModalProps {
  isOpen: boolean;
  onContinue: () => void;
  onDontShowAgain: () => void;
  onCancel: () => void;
}

// `text` is an i18n key in the 'onboarding' namespace.
const capabilities = [
  { icon: 'edit_note', text: 'extensionIntro.capabilities.editors' },
  { icon: 'view_sidebar', text: 'extensionIntro.capabilities.panels' },
  { icon: 'psychology', text: 'extensionIntro.capabilities.aiTools' },
  { icon: 'deployed_code', text: 'extensionIntro.capabilities.devLoop' },
];

export const ExtensionProjectIntroModal: React.FC<ExtensionProjectIntroModalProps> = ({
  isOpen,
  onContinue,
  onDontShowAgain,
  onCancel,
}) => {
  const { t } = useTranslation('onboarding');
  if (!isOpen) return null;

  return (
    <div
      className="nim-overlay backdrop-blur-sm bg-black/55"
      onClick={onCancel}
    >
      <div
        className="nim-modal w-[92%] max-w-[480px] border border-nim bg-nim shadow-[0_30px_100px_rgba(0,0,0,0.35)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="px-7 pt-7 pb-5">
          <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-xl border border-[color:color-mix(in_srgb,var(--nim-primary)_32%,var(--nim-border))] bg-[color:color-mix(in_srgb,var(--nim-primary)_14%,transparent)] text-[var(--nim-primary)]">
            <span className="material-symbols-outlined text-[26px]">extension</span>
          </div>
          <h2 className="m-0 text-xl font-semibold tracking-[-0.02em] text-nim">
            {t('extensionIntro.title')}
          </h2>
          <p className="mt-2 text-[14px] leading-6 text-nim-muted">
            {t('extensionIntro.description')}
          </p>
        </div>

        <div className="flex flex-col gap-2.5 px-7 pb-5">
          {capabilities.map((cap) => (
            <div key={cap.icon} className="flex items-start gap-3">
              <span className="material-symbols-outlined mt-0.5 text-[18px] text-[var(--nim-primary)]">
                {cap.icon}
              </span>
              <span className="text-[13px] leading-5 text-nim-muted">{t(cap.text)}</span>
            </div>
          ))}
        </div>

        <div className="mx-7 mb-5 rounded-lg bg-nim-secondary px-4 py-3">
          <span className="text-[13px] leading-5 text-nim-muted">
            {t('extensionIntro.agentHint')}
          </span>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-nim px-7 py-4">
          <button
            className="nim-btn-secondary rounded-lg px-4 py-2 text-sm font-medium"
            onClick={onCancel}
          >
            {t('common:cancel')}
          </button>
          <button
            className="rounded-lg border border-nim bg-transparent px-4 py-2 text-sm font-medium text-nim-muted transition-colors hover:bg-nim-secondary hover:text-nim"
            onClick={onDontShowAgain}
          >
            {t('prompts.dontShowAgain')}
          </button>
          <button
            className="nim-btn-primary rounded-lg px-5 py-2 text-sm font-semibold"
            onClick={onContinue}
          >
            {t('common:continue')}
          </button>
        </div>
      </div>
    </div>
  );
};
