/**
 * Native confirmation shown before a `nimbalyst://invite/...` deep link joins a team.
 *
 * Following a link must never join an organisation by itself: the link can come from an email, a
 * page or a document. Default button and Esc are both Cancel; only an explicit click on the join
 * button resolves `true`. A dialog that fails to show resolves `false` (fail closed).
 */
import { dialog, type BrowserWindow, type MessageBoxOptions, type MessageBoxReturnValue } from 'electron';
import { t } from '@nimbalyst/runtime/i18n';

export interface TeamInviteConfirmInfo {
  orgId: string;
  /** Team name from the server directory; empty or missing falls back to the org id. */
  teamName?: string;
  /** Address the link says the invitation was sent to (advisory). */
  email?: string;
}

export type ShowMessageBox = (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>;

const MAX_NAME_LENGTH = 80;
const MAX_EMAIL_LENGTH = 120;

/**
 * Characters that must not reach the dialog text: control characters, bidi embeddings/isolates and
 * marks (U+202A-202E, U+2066-2069, U+200E/200F, U+061C), zero-width characters (U+200B-200D) and the
 * BOM (U+FEFF).
 */
const UNTRUSTED_TEXT_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** The name and address are untrusted text: strip those characters and bound the length. */
function sanitizeForDialog(value: string | undefined, max: number): string {
  const cleaned = (value ?? '').replace(UNTRUSTED_TEXT_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

export function buildTeamInviteConfirmDialog(info: TeamInviteConfirmInfo): MessageBoxOptions {
  const org = sanitizeForDialog(info.teamName, MAX_NAME_LENGTH) || sanitizeForDialog(info.orgId, MAX_NAME_LENGTH);
  const email = sanitizeForDialog(info.email, MAX_EMAIL_LENGTH);
  const cancel = t('dialogs:teamInviteDeepLink.cancel');
  return {
    type: 'question',
    title: t('dialogs:teamInviteDeepLink.title'),
    message: t('dialogs:teamInviteDeepLink.message', { org }),
    detail: email
      ? t('dialogs:teamInviteDeepLink.detail', { email })
      : t('dialogs:teamInviteDeepLink.detailNoEmail'),
    buttons: [t('dialogs:teamInviteDeepLink.confirm'), cancel],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
}

/**
 * Resolves `true` only when the user clicks the join button. Cancel, Esc, closing the dialog and
 * any error all resolve `false`.
 */
export async function confirmTeamInviteJoin(
  info: TeamInviteConfirmInfo,
  showMessageBox?: ShowMessageBox,
  parent?: BrowserWindow | null,
): Promise<boolean> {
  try {
    const options = buildTeamInviteConfirmDialog(info);
    const show: ShowMessageBox = showMessageBox
      ?? ((opts) => (parent && !parent.isDestroyed() ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts)));
    const result = await show(options);
    return result.response === 0;
  } catch {
    return false;
  }
}

let inviteFlowActive = false;

/**
 * Serialises invite deep links: while one invite is being resolved or confirmed, further ones are not
 * stacked behind it, they are ignored (`onBusy` logs it). The OS can deliver several links in a row.
 */
export async function runExclusiveInviteFlow(flow: () => Promise<void>, onBusy: () => void): Promise<void> {
  if (inviteFlowActive) {
    onBusy();
    return;
  }
  inviteFlowActive = true;
  try {
    await flow();
  } finally {
    inviteFlowActive = false;
  }
}
