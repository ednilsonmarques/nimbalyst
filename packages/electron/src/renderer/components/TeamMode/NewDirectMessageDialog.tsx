import React, { useMemo, useState } from 'react';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';

import type { ConversationDirectoryEntry } from '../../../shared/conversationDirectory';
import {
  OrgDialog,
  OrgDialogPrimaryButton,
  OrgDialogSecondaryButton,
} from './OrgDialog';
import { MemberPicker } from './MemberPicker';
import { openOrCreateDirectMessage } from './roomManagementActions';
import {
  buildDirectMessageRequest,
  MAX_DM_PARTICIPANTS,
} from './roomManagementViewModel';
import type { OrgRosterMember } from './useOrgRoster';

/**
 * Start a direct message with one or more people.
 *
 * The viewer counts toward the server's 2-8 participant range but is never a
 * checkbox — they are always in their own DM — so the picker caps at one fewer
 * than the server's ceiling and the summary line counts them explicitly.
 */
export function NewDirectMessageDialog({
  orgId,
  members,
  viewerUserId,
  conversations,
  participantsByConversationId,
  onClose,
  onOpened,
}: {
  orgId: string;
  members: readonly OrgRosterMember[];
  viewerUserId: string | null;
  conversations: readonly ConversationDirectoryEntry[];
  participantsByConversationId?: Readonly<Record<string, readonly string[]>>;
  onClose: () => void;
  onOpened: (conversationId: string) => void;
}) {
  const { t } = useTranslation('team');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validation = useMemo(
    () => buildDirectMessageRequest(selectedIds, viewerUserId),
    [selectedIds, viewerUserId],
  );

  const submit = async () => {
    if (!validation.request || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const conversationId = await openOrCreateDirectMessage({
        orgId,
        selectedMemberIds: selectedIds,
        viewerUserId,
        conversations,
        participantsByConversationId,
      });
      onOpened(conversationId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setSubmitting(false);
    }
  };

  return (
    <OrgDialog
      title={t('sidebar.newDirectMessage')}
      description={t('newDm.description', { count: MAX_DM_PARTICIPANTS - 1 })}
      testId="new-dm-dialog"
      error={error}
      onClose={onClose}
      footer={(
        <>
          <OrgDialogSecondaryButton testId="new-dm-cancel" onClick={onClose}>
            {t('common:cancel')}
          </OrgDialogSecondaryButton>
          <OrgDialogPrimaryButton
            testId="new-dm-submit"
            disabled={!validation.request || submitting}
            onClick={() => { void submit(); }}
          >
            {submitting ? t('compose.opening') : t('newDm.submit')}
          </OrgDialogPrimaryButton>
        </>
      )}
    >
      <MemberPicker
        testId="new-dm-members"
        members={members}
        selectedIds={selectedIds}
        excludeIds={viewerUserId ? [viewerUserId] : []}
        maxSelected={MAX_DM_PARTICIPANTS - 1}
        onToggle={(memberId) => setSelectedIds((current) => (
          current.includes(memberId)
            ? current.filter((id) => id !== memberId)
            : [...current, memberId]
        ))}
      />
      <p
        className="new-dm-summary m-0 mt-2 text-[11px] text-[var(--nim-text-muted)]"
        data-testid="new-dm-summary"
      >
        {validation.error
          ?? t('newDm.participants', { count: validation.participants.length })}
      </p>
    </OrgDialog>
  );
}
