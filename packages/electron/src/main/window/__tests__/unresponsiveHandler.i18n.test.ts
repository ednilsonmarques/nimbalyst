// @vitest-environment node
/** The "window not responding" dialog is fully localized and resolves its text when shown. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { setLanguage, t } from '@nimbalyst/runtime/i18n';

const showMessageBox = vi.fn();
vi.mock('electron', () => ({
  dialog: { showMessageBox: (...args: unknown[]) => showMessageBox(...args) },
}));

import { createUnresponsiveHandler } from '../unresponsiveHandler';

function show() {
  const window = { isDestroyed: () => false, reload: vi.fn() } as unknown as BrowserWindow;
  const handler = createUnresponsiveHandler({
    message: () => t('dialogs:unresponsive.windowMessage'),
    logLabel: '[Test]',
    getWindow: () => window,
  });
  return handler().then(() => showMessageBox.mock.calls.at(-1)?.[1] as Record<string, unknown>);
}

afterEach(async () => {
  showMessageBox.mockReset();
  await setLanguage('en');
});

describe('unresponsive dialog i18n', () => {
  it('keeps the English text, buttons and ids', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    showMessageBox.mockResolvedValue({ response: 1 });
    const options = await show();
    expect(options).toMatchObject({
      message: 'The window is not responding',
      buttons: ['Reload', 'Keep Waiting'],
      defaultId: 0,
      cancelId: 1,
      detail: 'Would you like to reload the window?',
    });
  });

  it('resolves the message in the language active when the dialog is shown', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    showMessageBox.mockResolvedValue({ response: 1 });
    await setLanguage('pt-BR');
    const options = await show();
    expect(options).toMatchObject({
      message: 'A janela não está respondendo',
      buttons: ['Recarregar', 'Continuar aguardando'],
      defaultId: 0,
      cancelId: 1,
      detail: 'Deseja recarregar a janela?',
    });
  });
});
