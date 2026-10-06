// @vitest-environment jsdom
/** Composer chrome (queue, mode tag, layout, context meter, chips) follows the UI language. */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';
import { setLanguage } from '@nimbalyst/runtime/i18n';
import { PromptQueueList } from '../PromptQueueList';
import { ModeTag } from '../ModeTag';
import { LayoutControls } from '../LayoutControls';
import { ContextUsageDisplay } from '../ContextUsageDisplay';
import { SelectionChips } from '../SelectionChips';
import { clearTextSelection, setTextSelection } from '../TextSelectionIndicator';
import { buildVoiceUsageDisplay } from '../voiceUsageDisplay';
import { describeRoleOrigin, summarizeRolePermissions } from '../openCodeRoles';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: () => null,
}));
vi.mock('../../../help', () => ({
  getHelpContent: () => undefined,
  HelpTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const FILE = '/workspace/notes.md';

afterEach(async () => {
  cleanup();
  clearTextSelection();
  await act(async () => {
    await setLanguage('en');
  });
});

async function inLanguage(language: 'en' | 'pt-BR') {
  await act(async () => {
    await setLanguage(language);
  });
}

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nProvider>{ui}</I18nProvider>);
}

const queue = [
  { id: 'q1', prompt: 'first', timestamp: 1 },
  { id: 'q2', prompt: 'second', timestamp: 2 },
];

describe('PromptQueueList i18n', () => {
  it('keeps the English labels', async () => {
    await inLanguage('en');
    renderWithI18n(<PromptQueueList queue={queue} onCancel={vi.fn()} onEdit={vi.fn()} onSendNow={vi.fn()} />);
    screen.getByText('2 queued');
    expect(screen.getAllByTitle('Interrupt and send now')).toHaveLength(2);
    expect(screen.getAllByTitle('Edit this prompt')).toHaveLength(2);
    expect(screen.getAllByTitle('Cancel this prompt')).toHaveLength(2);
  });

  it('renders pt-BR labels and keeps the handlers', async () => {
    await inLanguage('pt-BR');
    const onCancel = vi.fn();
    renderWithI18n(<PromptQueueList queue={queue.slice(0, 1)} onCancel={onCancel} onSendNow={vi.fn()} />);
    screen.getByText('1 na fila');
    screen.getByTitle('Interromper e enviar agora');
    fireEvent.click(screen.getByTitle('Cancelar este prompt'));
    expect(onCancel).toHaveBeenCalledWith('q1');
  });
});

describe('ModeTag i18n', () => {
  it('shows English mode labels', async () => {
    await inLanguage('en');
    renderWithI18n(<ModeTag mode="planning" onModeChange={vi.fn()} />);
    const button = screen.getByTestId('plan-mode-toggle');
    expect(button.textContent).toBe('Plan');
    expect(button.getAttribute('aria-label')).toBe('Plan mode: Creates plan documents (click to enable full agent mode)');
  });

  it('shows pt-BR mode labels but emits the same internal mode', async () => {
    await inLanguage('pt-BR');
    const onModeChange = vi.fn();
    renderWithI18n(<ModeTag mode="agent" onModeChange={onModeChange} />);
    const button = screen.getByTestId('plan-mode-toggle');
    expect(button.textContent).toBe('Agente');
    expect(button.getAttribute('aria-label')).toMatch(/^Modo agente/);
    fireEvent.click(button);
    expect(onModeChange).toHaveBeenCalledWith('planning');
  });
});

describe('LayoutControls i18n', () => {
  it('translates labels and aria-labels', async () => {
    await inLanguage('pt-BR');
    renderWithI18n(<LayoutControls mode="split" hasTabs onModeChange={vi.fn()} />);
    screen.getByText('Arquivos');
    screen.getByText('Agente');
    screen.getByLabelText('Visualização dividida');
    screen.getByLabelText('Maximizar transcrição');
  });
});

describe('ContextUsageDisplay i18n', () => {
  const props = {
    provider: 'claude-code',
    inputTokens: 80_000,
    outputTokens: 20_000,
    totalTokens: 100_000,
    contextWindow: 200_000,
    currentContext: { tokens: 132_000, contextWindow: 200_000 },
  };

  it('keeps the English aria-label and breakdown rows', async () => {
    await inLanguage('en');
    renderWithI18n(<ContextUsageDisplay {...props} />);
    const meter = screen.getByTestId('context-indicator');
    expect(meter.getAttribute('aria-label')).toBe('Context usage 132k of 200k tokens (66%)');
    fireEvent.click(meter);
    screen.getByText('Context Breakdown');
    screen.getByText('Input:');
    screen.getByText('Output:');
    screen.getByText('Manage tools');
  });

  it('renders pt-BR text with no raw keys', async () => {
    await inLanguage('pt-BR');
    renderWithI18n(<ContextUsageDisplay {...props} />);
    const meter = screen.getByTestId('context-indicator');
    expect(meter.getAttribute('aria-label')).toBe('Uso de contexto: 132k de 200k tokens (66%)');
    fireEvent.click(meter);
    screen.getByText('Detalhamento do contexto');
    screen.getByText('Entrada:');
    screen.getByText('Saída:');
    screen.getByText('Gerenciar ferramentas');
    expect(screen.getByRole('tooltip').textContent).not.toMatch(/contextUsage\./);
  });
});

describe('SelectionChips i18n', () => {
  it('translates the selection chip and its remove label', async () => {
    await inLanguage('pt-BR');
    renderWithI18n(<SelectionChips currentFilePath={FILE} />);
    act(() => setTextSelection('selected text', FILE));
    screen.getByText('Seleção');
    fireEvent.click(screen.getByLabelText('Remover Seleção do contexto'));
    expect(screen.queryByText('Seleção')).toBeNull();
  });
});

describe('non-React label builders', () => {
  it('translates voice usage labels and plurals at call time', async () => {
    await inLanguage('pt-BR');
    const display = buildVoiceUsageDisplay({ engine: 'realtime', total: 10, backend: [{}, {}] } as never);
    expect(display?.lines.map((line) => line.label)).toEqual(['Tokens usados', 'Controlador']);
    expect(display?.lines[1].value).toBe('2 respostas');
    await inLanguage('en');
    const english = buildVoiceUsageDisplay({ engine: 'realtime', total: 10, backend: [{}] } as never);
    expect(english?.lines.map((line) => line.label)).toEqual(['Tokens used', 'Controller']);
    expect(english?.lines[1].value).toBe('1 response');
  });

  it('translates OpenCode role descriptors', async () => {
    await inLanguage('pt-BR');
    expect(describeRoleOrigin({ builtIn: true }).label).toBe('integrado');
    expect(summarizeRolePermissions({ permission: { edit: 'deny' }, tools: { a: false, b: false } } as never)).toEqual([
      'sem edições',
      '2 ferramentas desativadas',
    ]);
  });
});
