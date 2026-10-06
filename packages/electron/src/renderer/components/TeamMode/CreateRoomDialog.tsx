import React, { useMemo, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';

import type { ConversationDirectoryEntry } from '../../../shared/conversationDirectory';
import { createDirectoryConversation } from '../../services/conversationDirectoryClient';
import {
  OrgDialog,
  OrgDialogField,
  OrgDialogPrimaryButton,
  OrgDialogSecondaryButton,
  ORG_DIALOG_INPUT_CLASS,
} from './OrgDialog';
import { MemberPicker } from './MemberPicker';
import {
  buildCreateRoomRequest,
  deriveRoomId,
  EMPTY_CREATE_ROOM_FORM,
  type CreateRoomFormState,
} from './roomManagementViewModel';
import type { OrgRosterMember } from './useOrgRoster';

/**
 * Create an organization room.
 *
 * The id is derived from the name and stays derived until the user edits it —
 * rooms are addressed by that slug, and making people type it twice for the
 * common case would be noise. Initial members only apply to private rooms: the
 * server ignores explicit memberships on public ones because every active org
 * member can already read them.
 */
export function CreateRoomDialog({
  orgId,
  members,
  viewerUserId,
  existingConversations,
  onClose,
  onCreated,
}: {
  orgId: string;
  members: readonly OrgRosterMember[];
  viewerUserId: string | null;
  existingConversations: readonly ConversationDirectoryEntry[];
  onClose: () => void;
  onCreated: (conversationId: string) => void;
}) {
  const { t } = useTranslation('team');
  const [form, setForm] = useState<CreateRoomFormState>(EMPTY_CREATE_ROOM_FORM);
  const [idEdited, setIdEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const existingIds = useMemo(
    () => existingConversations.map((entry) => entry.id),
    [existingConversations],
  );
  const result = useMemo(
    () => buildCreateRoomRequest(form, { existingIds, viewerUserId }),
    [existingIds, form, viewerUserId],
  );

  const patch = (changes: Partial<CreateRoomFormState>) => {
    setForm((current) => ({ ...current, ...changes }));
  };

  const submit = async () => {
    if (!result.request || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await createDirectoryConversation({
        orgId,
        input: result.request,
      });
      onCreated(created.descriptor.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setSubmitting(false);
    }
  };

  return (
    <OrgDialog
      title={t('createRoom.title')}
      description={t('createRoom.description')}
      testId="create-room-dialog"
      error={error}
      onClose={onClose}
      footer={(
        <>
          <OrgDialogSecondaryButton testId="create-room-cancel" onClick={onClose}>
            {t('common:cancel')}
          </OrgDialogSecondaryButton>
          <OrgDialogPrimaryButton
            testId="create-room-submit"
            disabled={!result.canSubmit || submitting}
            onClick={() => { void submit(); }}
          >
            {submitting ? t('createRoom.creating') : t('createRoom.submit')}
          </OrgDialogPrimaryButton>
        </>
      )}
    >
      <OrgDialogField label={t('room.fields.name')} error={result.nameError && form.name ? result.nameError : null}>
        <input
          type="text"
          className={ORG_DIALOG_INPUT_CLASS}
          data-testid="create-room-name"
          value={form.name}
          autoFocus
          placeholder={t('createRoom.namePlaceholder')}
          onChange={(event) => {
            const name = event.target.value;
            patch(idEdited ? { name } : { name, id: deriveRoomId(name) });
          }}
        />
      </OrgDialogField>

      <OrgDialogField
        label={t('createRoom.roomId')}
        hint={t('createRoom.roomIdHint')}
        error={result.idError}
      >
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] text-[var(--nim-text-faint)]">#</span>
          <input
            type="text"
            className={ORG_DIALOG_INPUT_CLASS}
            data-testid="create-room-id"
            value={result.resolvedId}
            onChange={(event) => {
              setIdEdited(true);
              patch({ id: event.target.value });
            }}
          />
        </div>
      </OrgDialogField>

      <OrgDialogField label={t('createRoom.topicOptional')} hint={t('createRoom.topicHint')}>
        <input
          type="text"
          className={ORG_DIALOG_INPUT_CLASS}
          data-testid="create-room-topic"
          value={form.topic}
          placeholder={t('createRoom.topicPlaceholder')}
          onChange={(event) => patch({ topic: event.target.value })}
        />
      </OrgDialogField>

      <OrgDialogField label={t('createRoom.visibility')}>
        <div className="create-room-visibility flex flex-col gap-2">
          <VisibilityOption
            id="public"
            icon="tag"
            label={t('createRoom.public')}
            description={t('createRoom.publicDescription')}
            selected={form.visibility === 'public'}
            onSelect={() => patch({ visibility: 'public' })}
          />
          <VisibilityOption
            id="private"
            icon="lock"
            label={t('createRoom.private')}
            description={t('createRoom.privateDescription')}
            selected={form.visibility === 'private'}
            onSelect={() => patch({ visibility: 'private' })}
          />
        </div>
      </OrgDialogField>

      {form.visibility === 'private' && (
        <OrgDialogField
          label={t('adminTabs.members')}
          hint={t('createRoom.membersHint')}
        >
          <MemberPicker
            testId="create-room-members"
            members={members}
            selectedIds={form.memberIds}
            excludeIds={viewerUserId ? [viewerUserId] : []}
            onToggle={(memberId) => patch({
              memberIds: form.memberIds.includes(memberId)
                ? form.memberIds.filter((id) => id !== memberId)
                : [...form.memberIds, memberId],
            })}
          />
        </OrgDialogField>
      )}

      <label className="create-room-agent-posting flex cursor-pointer items-start gap-2.5 rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-3">
        <input
          type="checkbox"
          className="mt-0.5"
          data-testid="create-room-agent-posting"
          checked={form.agentPostingEnabled}
          onChange={(event) => patch({ agentPostingEnabled: event.target.checked })}
        />
        <span className="min-w-0">
          <span className="block text-[12px] font-medium text-[var(--nim-text)]">
            {t('room.agentPosting.label')}
          </span>
          <span className="block text-[11px] text-[var(--nim-text-faint)]">
            {t('createRoom.agentPostingHint')}
          </span>
        </span>
      </label>
    </OrgDialog>
  );
}

function VisibilityOption({
  id,
  icon,
  label,
  description,
  selected,
  onSelect,
}: {
  id: string;
  icon: string;
  label: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className={`create-room-visibility-option flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5 ${
        selected
          ? 'border-[var(--nim-primary)] bg-[color-mix(in_srgb,var(--nim-primary)_8%,transparent)]'
          : 'border-[var(--nim-border)] bg-[var(--nim-bg-secondary)]'
      }`}
      data-testid={`create-room-visibility-${id}`}
    >
      <input
        type="radio"
        name="create-room-visibility"
        className="mt-0.5"
        checked={selected}
        onChange={onSelect}
      />
      <MaterialSymbol icon={icon} size={16} className="mt-px shrink-0 text-[var(--nim-text-muted)]" />
      <span className="min-w-0">
        <span className="block text-[12px] font-medium text-[var(--nim-text)]">{label}</span>
        <span className="block text-[11px] text-[var(--nim-text-faint)]">{description}</span>
      </span>
    </label>
  );
}
