// @vitest-environment jsdom
/** Slash-command section headers are localized; section ids (used for ordering) are not. */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';
import { setLanguage } from '@nimbalyst/runtime/i18n';
import { GenericTypeahead } from '../GenericTypeahead';
import { buildSlashCommandOptions } from '../slashCommandAutocomplete';

afterEach(async () => {
  cleanup();
  await act(async () => {
    await setLanguage('en');
  });
});

const commands = [
  { name: 'compact', source: 'builtin' as const },
  { name: 'deploy', source: 'project' as const, description: 'Deploy the app' },
];

function renderTypeahead() {
  const anchor = document.createElement('textarea');
  document.body.appendChild(anchor);
  const options = buildSlashCommandOptions(commands, '', 'commands');
  return render(
    <I18nProvider>
      <GenericTypeahead
        anchorElement={anchor}
        options={options}
        selectedIndex={null}
        onSelectedIndexChange={vi.fn()}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        cursorPosition={0}
        sectionOrder={['Built-in Commands', 'Project Commands']}
      />
    </I18nProvider>,
  );
}

describe('GenericTypeahead i18n', () => {
  it('keeps English section headers and fallback descriptions', async () => {
    renderTypeahead();
    screen.getByText('Built-in Commands');
    screen.getByText('Project Commands');
    screen.getByText('Execute compact command');
  });

  it('renders pt-BR section headers in the same order and leaves command text alone', async () => {
    await act(async () => {
      await setLanguage('pt-BR');
    });
    renderTypeahead();
    const headers = Array.from(document.querySelectorAll('.generic-typeahead-section-header')).map((el) => el.textContent);
    expect(headers).toEqual(['Comandos integrados', 'Comandos do projeto']);
    screen.getByText('Executar o comando compact');
    // Descriptions authored by the command itself are not translated.
    screen.getByText('Deploy the app');
  });
});
