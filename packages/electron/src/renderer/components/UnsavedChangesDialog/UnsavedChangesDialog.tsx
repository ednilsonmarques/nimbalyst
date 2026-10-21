import React, { useEffect } from 'react';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';

export interface UnsavedChangesDialogProps {
  isOpen: boolean;
  /** The Save choice is being carried out: only Cancel stays available. */
  isSaving?: boolean;
  onSave: () => void;
  onDiscard: () => void;
  /** Keep editing. Also what Esc and a click on the overlay do: dismissing never discards. */
  onCancel: () => void;
}

export const UnsavedChangesDialog: React.FC<UnsavedChangesDialogProps> = ({ isOpen, isSaving = false, onSave, onDiscard, onCancel }) => {
  const { t } = useTranslation();

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  return (
    <div className="confirm-dialog-overlay nim-overlay" data-testid="unsaved-changes-overlay" onClick={onCancel}>
      <div
        className="confirm-dialog nim-modal min-w-[400px] max-w-[500px] p-6"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="confirm-dialog-title m-0 mb-3 text-lg font-semibold text-nim">{t('general:app.unsavedChanges.title')}</h2>
        <p className="confirm-dialog-message m-0 mb-6 text-sm text-nim-muted leading-relaxed">{isSaving ? t('general:app.unsavedChanges.saving') : t('general:app.unsavedChanges.message')}</p>
        <div className="confirm-dialog-buttons flex gap-3 justify-end">
          <button className="confirm-dialog-button-cancel nim-btn-secondary" onClick={onCancel}>
            {t('common:cancel')}
          </button>
          <button className="confirm-dialog-button-discard nim-btn-secondary" disabled={isSaving} onClick={onDiscard}>
            {t('general:app.unsavedChanges.dontSave')}
          </button>
          <button className="confirm-dialog-button-confirm nim-btn-primary" autoFocus disabled={isSaving} onClick={onSave}>
            {t('common:save')}
          </button>
        </div>
      </div>
    </div>
  );
};
