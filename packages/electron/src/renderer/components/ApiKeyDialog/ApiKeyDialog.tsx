import React from 'react';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';

interface ApiKeyDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenPreferences: () => void;
}

export function ApiKeyDialog({ isOpen, onClose, onOpenPreferences }: ApiKeyDialogProps) {
  const { t } = useTranslation('ai');
  if (!isOpen) return null;

  const handleOpenPreferences = () => {
    onClose();
    onOpenPreferences();
  };

  return (
    <div className="api-key-dialog-overlay nim-overlay" onClick={onClose}>
      <div
        className="api-key-dialog nim-modal w-[90%] max-w-[500px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="api-key-dialog-header nim-modal-header">
          <h2 className="m-0 text-xl font-semibold text-[var(--nim-text)]">
            {t('apiKey.title')}
          </h2>
          <button
            className="api-key-dialog-close nim-btn-icon text-2xl"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="api-key-dialog-content nim-modal-body">
          <div className="api-key-dialog-icon text-5xl text-center mb-4">🔑</div>

          <p className="api-key-dialog-message text-base text-[var(--nim-text-muted)] mb-6 text-center leading-relaxed">
            {t('apiKey.message')}
          </p>

          <div className="api-key-dialog-steps rounded-lg p-4 mb-2 bg-[var(--nim-bg-secondary)]">
            <h3 className="text-sm font-semibold text-[var(--nim-text)] m-0 mb-3">
              {t('apiKey.howToStart')}
            </h3>
            <ol className="m-0 pl-5 text-[var(--nim-text-muted)] text-sm leading-7">
              <li className="mb-2">
                {t('apiKey.chooseProvider')}
                <ul className="mt-1 mb-1 pl-5">
                  <li>
                    <a
                      href="https://console.anthropic.com/settings/keys"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--nim-primary)] no-underline font-medium hover:underline"
                    >
                      Anthropic
                    </a>{' '}
                    (Claude)
                  </li>
                  <li>
                    <a
                      href="https://platform.openai.com/api-keys"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--nim-primary)] no-underline font-medium hover:underline"
                    >
                      OpenAI
                    </a>{' '}
                    (GPT-4)
                  </li>
                  <li>
                    <a
                      href="https://lmstudio.ai"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--nim-primary)] no-underline font-medium hover:underline"
                    >
                      LM Studio
                    </a>{' '}
                    {t('apiKey.local')}
                  </li>
                </ul>
              </li>
              <li className="mb-2">{t('apiKey.stepGetKey')}</li>
              <li className="mb-2">{t('apiKey.stepClick')}</li>
              <li className="mb-2">{t('apiKey.stepEnter')}</li>
            </ol>
          </div>
        </div>

        <div className="api-key-dialog-footer nim-modal-footer">
          <button className="api-key-dialog-button nim-btn-secondary" onClick={onClose}>
            {t('apiKey.cancel')}
          </button>
          <button
            className="api-key-dialog-button nim-btn-primary"
            onClick={handleOpenPreferences}
          >
            {t('apiKey.openSettings')}
          </button>
        </div>
      </div>
    </div>
  );
}
