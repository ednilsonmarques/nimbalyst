/**
 * The tool permission prompt follows the UI language. Only its text changes:
 * the decision each button submits is the same in every language.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider as JotaiProvider } from 'jotai';
import { store } from '../../../../../store/store';
import { setInteractiveWidgetHost } from '../../../../../store/atoms/interactiveWidgetHost';
import { I18nProvider } from '../../../../../i18n/react';
import { setLanguage, t as translate } from '../../../../../i18n';
import { ToolPermissionWidget } from '../ToolPermissionWidget';
import type { InteractiveWidgetHost } from '../InteractiveWidgetHost';
import { describePermissionPattern, localizeClassifierReason, localizePermissionWarning } from '../toolPermissionText';

const SESSION = 'session-i18n';

function message(args: Record<string, unknown> = {}, result: unknown = null) {
  return {
    toolCall: {
      providerToolCallId: 'tool-call-1',
      arguments: {
        requestId: 'req-1',
        toolName: 'Bash',
        rawCommand: 'git status',
        pattern: 'Bash(git status:*)',
        patternDisplayName: 'git status commands',
        isDestructive: false,
        warnings: [],
        workspacePath: '/tmp/workspace',
        ...args,
      },
      result,
    },
  } as any;
}

async function renderIn(language: 'en' | 'pt-BR', msg = message()) {
  await act(async () => {
    await setLanguage(language);
  });
  const host = { toolPermissionSubmit: vi.fn().mockResolvedValue(undefined) } as unknown as InteractiveWidgetHost;
  setInteractiveWidgetHost(SESSION, host);
  render(
    <JotaiProvider store={store}>
      <I18nProvider>
        <ToolPermissionWidget message={msg} sessionId={SESSION} {...({} as any)} />
      </I18nProvider>
    </JotaiProvider>,
  );
  return host;
}

const text = (testId: string) => screen.getByTestId(testId).textContent;
const widgetText = () => screen.getByTestId('tool-permission-widget').textContent ?? '';
const tAi = (key: string, options?: Record<string, unknown>) => translate(`ai:${key}`, options);

afterEach(async () => {
  cleanup();
  setInteractiveWidgetHost(SESSION, null);
  await setLanguage('en');
});

describe('ToolPermissionWidget in pt-BR', () => {
  it('translates the title, the buttons and the helper line', async () => {
    await renderIn('pt-BR');
    expect(widgetText()).toContain('Permitir esta ferramenta?');
    expect(text('tool-permission-deny')).toBe('Negar');
    expect(text('tool-permission-allow-once')).toBe('Permitir uma vez');
    expect(text('tool-permission-allow-session')).toBe('Nesta sessão');
    expect(text('tool-permission-allow-always')).toBe('Sempre');
    expect(widgetText()).toContain('Nesta sessão/Sempre permitirá: comandos git status');
    expect(screen.getByTestId('tool-permission-allow-session').getAttribute('title')).toBe('Permitir nesta sessão: comandos git status');
    expect(screen.getByTestId('tool-permission-allow-always').getAttribute('title')).toBe('Salvar em .claude/settings.local.json: comandos git status');
    expect(widgetText()).not.toMatch(/Allow this tool|Allow Once|will allow/);
  });

  it('translates the web fetch extras', async () => {
    await renderIn('pt-BR', message({ toolName: 'WebFetch', pattern: 'WebFetch(domain:example.com)', patternDisplayName: 'Fetch from example.com' }));
    expect(text('tool-permission-allow-all-domains')).toBe('Todos os domínios');
    expect(widgetText()).toContain('Buscar em example.com');
  });

  it('translates a known classifier reason and keeps the sentence around it', async () => {
    await renderIn('pt-BR', message({ warnings: ['Auto-mode classifier flagged this call: [Unrequested Commit in a Connected App]'] }));
    expect(widgetText()).toContain(
      'O classificador do modo automático sinalizou esta ação: [Commit não solicitado em um aplicativo conectado]',
    );
  });

  it('keeps an unknown classifier reason in its original wording', async () => {
    await renderIn('pt-BR', message({ warnings: ['Auto-mode classifier flagged this call: [Some Brand New Reason]'] }));
    expect(widgetText()).toContain('O classificador do modo automático sinalizou esta ação: [Some Brand New Reason]');
  });

  it('leaves a warning it does not know untouched', async () => {
    await renderIn('pt-BR', message({ warnings: ['Custom warning from a provider'] }));
    expect(widgetText()).toContain('Custom warning from a provider');
  });

  it('translates the resolved states', async () => {
    await renderIn('pt-BR', message({}, JSON.stringify({ decision: 'allow', scope: 'session' })));
    expect(widgetText()).toContain('Permissão concedida');
    expect(text('tool-permission-granted')).toBe('Nesta sessão');
    cleanup();
    await renderIn('pt-BR', message({}, JSON.stringify({ decision: 'deny', scope: 'once' })));
    expect(widgetText()).toContain('Permissão negada');
    expect(text('tool-permission-denied')).toBe('Uma vez');
  });

  it('submits the same decisions as in English', async () => {
    const host = await renderIn('pt-BR');
    await act(async () => {
      fireEvent.click(screen.getByTestId('tool-permission-allow-session'));
    });
    expect(host.toolPermissionSubmit).toHaveBeenCalledWith('req-1', { decision: 'allow', scope: 'session' });
    cleanup();
    const second = await renderIn('pt-BR');
    await act(async () => {
      fireEvent.click(screen.getByTestId('tool-permission-deny'));
    });
    expect(second.toolPermissionSubmit).toHaveBeenCalledWith('req-1', { decision: 'deny', scope: 'once' });
  });
});

describe('ToolPermissionWidget in English', () => {
  it('reads exactly as before', async () => {
    await renderIn('en', message({ warnings: ['Auto-mode classifier flagged this call: [Untrusted Code Integration]'] }));
    expect(widgetText()).toContain('Allow this tool?');
    expect(text('tool-permission-deny')).toBe('Deny');
    expect(text('tool-permission-allow-once')).toBe('Allow Once');
    expect(text('tool-permission-allow-session')).toBe('Session');
    expect(text('tool-permission-allow-always')).toBe('Always');
    expect(widgetText()).toContain('Session/Always will allow: git status commands');
    expect(widgetText()).toContain('Auto-mode classifier flagged this call: [Untrusted Code Integration]');
  });
});

describe('permission text helpers', () => {
  it('describes the patterns it knows and returns null for the rest', async () => {
    await setLanguage('pt-BR');
    expect(describePermissionPattern('Bash', tAi)).toBe('Executar comandos de shell');
    expect(describePermissionPattern('Bash(npm test:*)', tAi)).toBe('comandos npm test');
    expect(describePermissionPattern('Bash:compound:abc', tAi)).toBe('este comando composto (somente desta vez)');
    expect(describePermissionPattern('Edit', tAi)).toBe('Editar arquivos no projeto');
    expect(describePermissionPattern('mcp__nimbalyst-host__run_project_tests', tAi)).toBe('Nimbalyst Host: Run Project Tests');
    expect(describePermissionPattern('SomethingNew', tAi)).toBeNull();
  });

  it('maps known classifier reasons whatever their casing or brackets, and nothing else', async () => {
    await setLanguage('pt-BR');
    expect(localizeClassifierReason('[Untrusted Code Integration]', tAi)).toBe('[Integração de código não confiável]');
    expect(localizeClassifierReason('untrusted code integration', tAi)).toBe('Integração de código não confiável');
    expect(localizeClassifierReason('[Totally Unknown]', tAi)).toBe('[Totally Unknown]');
    expect(localizePermissionWarning('Auto-mode classifier requested user approval before running this tool.', tAi)).toBe(
      'O classificador do modo automático pediu sua aprovação antes de executar esta ferramenta.',
    );
    expect(localizePermissionWarning('This is part of a compound command - each part is checked separately', tAi)).toBe(
      'Isto faz parte de um comando composto: cada parte é verificada separadamente',
    );
  });
});
