// @vitest-environment jsdom
/** ConfirmDialog's default buttons follow the UI language; caller labels pass through. */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';
import { setLanguage } from '@nimbalyst/runtime/i18n';
import { ConfirmDialog } from '../ConfirmDialog';

afterEach(async () => {
  cleanup();
  await setLanguage('en');
});

async function renderIn(language: 'en' | 'pt-BR', props: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  await act(async () => {
    await setLanguage(language);
  });
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const view = render(
    <I18nProvider>
      <ConfirmDialog isOpen title="Delete file?" message="This cannot be undone." onConfirm={onConfirm} onCancel={onCancel} {...props} />
    </I18nProvider>,
  );
  return { ...view, onConfirm, onCancel };
}

describe('ConfirmDialog i18n', () => {
  it('uses English default buttons', async () => {
    await renderIn('en');
    expect(screen.getByRole('button', { name: 'OK' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('uses pt-BR default buttons and keeps the same handlers', async () => {
    const { onConfirm, onCancel, container } = await renderIn('pt-BR');
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).not.toContain('confirm.ok');
    expect(buttons.join(' ')).not.toMatch(/\b(dialogs|common):|confirm\.ok/);
    fireEvent.click(screen.getByRole('button', { name: buttons.find((b) => b !== 'Cancelar')! }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('keeps labels passed by the caller', async () => {
    await renderIn('pt-BR', { confirmLabel: 'Excluir', cancelLabel: 'Manter' });
    expect(screen.getByRole('button', { name: 'Excluir' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Manter' })).toBeTruthy();
  });
});
