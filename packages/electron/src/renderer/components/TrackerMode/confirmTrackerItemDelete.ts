import { requestConfirmation } from '../../dialogs/requestConfirmation';
import { t } from '@nimbalyst/runtime/i18n';

/** The host confirm the runtime tracker table and row menu call before deleting items. */
export function confirmTrackerItemDelete(itemCount: number): Promise<boolean> {
  return requestConfirmation({
    title: t('tracker:deleteItems.title', { count: itemCount }),
    message: t('tracker:deleteItems.message', { count: itemCount }),
    confirmLabel: t('common:delete'),
    destructive: true,
  });
}
