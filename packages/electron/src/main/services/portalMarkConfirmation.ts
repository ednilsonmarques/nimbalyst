/**
 * Native confirmation shown before the portal test-data mark is enabled, or its
 * interaction ports are widened.
 *
 * Owned by main (a native `dialog.showMessageBox` on the project window), so
 * nothing running in a renderer can click it: the settings UI asks, main decides.
 * Same pattern as teamInviteConfirmation: Cancel is the default button and the
 * Esc answer; only an explicit click on "Allow" resolves `true`; a dialog that
 * fails to show, or any other result, resolves `false` (fail closed).
 *
 * Only portalTestData.ts calls this. No MCP or agent path reaches it (a test
 * scans the agent-side sources for it).
 */
import { basename } from 'path';
import { dialog, type BrowserWindow, type MessageBoxOptions, type MessageBoxReturnValue } from 'electron';
import { t } from '@nimbalyst/runtime/i18n';

export type PortalMarkConfirmKind = 'enable' | 'ports';

export interface PortalMarkConfirmInfo {
  kind: PortalMarkConfirmKind;
  /** The project the change applies to (a worktree already resolved to its parent). */
  projectPath: string;
  /** The loopback ports agents may interact with once this is confirmed. */
  ports: readonly number[];
}

export type ShowMessageBox = (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>;

const MAX_NAME_LENGTH = 80;

/** Control characters, bidi embeddings/isolates and marks, zero-width characters and the BOM. */
const UNTRUSTED_TEXT_CHARS = /[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁦-⁩﻿]/g;

/** The project name comes from a folder name: untrusted text. Strip those characters and bound the length. */
function sanitizeForDialog(value: string, max: number): string {
  const cleaned = value.replace(UNTRUSTED_TEXT_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

export function buildPortalMarkConfirmDialog(info: PortalMarkConfirmInfo): MessageBoxOptions {
  const project = sanitizeForDialog(basename(info.projectPath) || info.projectPath, MAX_NAME_LENGTH);
  const ports = info.ports.join(', ');
  const detail =
    info.kind === 'ports'
      ? t('dialogs:portalTestData.detailPorts', { ports })
      : info.ports.length > 0
        ? t('dialogs:portalTestData.detailEnable', { ports })
        : t('dialogs:portalTestData.detailEnableNoPorts');
  return {
    type: 'warning',
    title: t('dialogs:portalTestData.title'),
    message:
      info.kind === 'ports'
        ? t('dialogs:portalTestData.messagePorts', { project })
        : t('dialogs:portalTestData.messageEnable', { project }),
    detail,
    buttons: [t('dialogs:portalTestData.confirm'), t('dialogs:portalTestData.cancel')],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
}

/**
 * Resolves `true` only when the user clicks "Allow". Cancel, Esc, closing the
 * dialog, any other result and any error all resolve `false`.
 */
export async function confirmPortalMark(
  info: PortalMarkConfirmInfo,
  showMessageBox?: ShowMessageBox,
  parent?: BrowserWindow | null,
): Promise<boolean> {
  try {
    const options = buildPortalMarkConfirmDialog(info);
    const show: ShowMessageBox =
      showMessageBox ??
      ((opts) => (parent && !parent.isDestroyed() ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts)));
    const result = await show(options);
    return result?.response === 0;
  } catch {
    return false;
  }
}
