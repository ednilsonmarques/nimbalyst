/**
 * The Team checkpoint card: what the user reads, and that "Continue team" goes
 * through the host's own channel (teamContinue), never a prompt answer.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider as JotaiProvider } from 'jotai';
import { store } from '../../../../../store/store';
import { setInteractiveWidgetHost } from '../../../../../store/atoms/interactiveWidgetHost';
import { I18nProvider } from '../../../../../i18n/react';
import { setLanguage } from '../../../../../i18n';
import { TeamCheckpointWidget } from '../TeamCheckpointWidget';
import { getCustomToolWidget } from '../index';
import type { InteractiveWidgetHost, TeamContinueResult } from '../InteractiveWidgetHost';
import { isInteractiveWidgetTool } from '../../../../../ai/server/interactivePromptTools';
import { TEAM_CHECKPOINT_TOOL_NAME } from '../../../../../ai/server/providers/teamContext';

const SESSION = 'root-session';

function message(result: unknown = null) {
  return {
    toolCall: {
      providerToolCallId: 'team-checkpoint-root-session-8',
      toolName: 'TeamCheckpoint',
      arguments: { rootSessionId: SESSION, created: 8, authorized: 8, extension: 4, maxActive: 3 },
      result,
    },
  } as any;
}

async function renderIn(
  language: 'en' | 'pt-BR',
  options: { result?: unknown; teamContinue?: InteractiveWidgetHost['teamContinue'] | null } = {},
) {
  await act(async () => {
    await setLanguage(language);
  });
  const teamContinue = options.teamContinue === undefined
    ? vi.fn<(id: string) => Promise<TeamContinueResult>>().mockResolvedValue({ success: true, extended: true, authorized: 12 })
    : options.teamContinue;
  const host = (teamContinue ? { teamContinue } : {}) as unknown as InteractiveWidgetHost;
  setInteractiveWidgetHost(SESSION, host);
  render(
    <JotaiProvider store={store}>
      <I18nProvider>
        <TeamCheckpointWidget message={message(options.result ?? null)} sessionId={SESSION} {...({} as any)} />
      </I18nProvider>
    </JotaiProvider>,
  );
  return teamContinue;
}

const widget = () => screen.getByTestId('team-checkpoint-widget');
const widgetText = () => widget().textContent ?? '';

afterEach(async () => {
  cleanup();
  setInteractiveWidgetHost(SESSION, null);
  await setLanguage('en');
});

describe('TeamCheckpointWidget', () => {
  it('is the widget of the TeamCheckpoint card and always renders, even with tool calls hidden', () => {
    expect(TEAM_CHECKPOINT_TOOL_NAME).toBe('TeamCheckpoint');
    expect(getCustomToolWidget(TEAM_CHECKPOINT_TOOL_NAME)).toBe(TeamCheckpointWidget);
    expect(isInteractiveWidgetTool(TEAM_CHECKPOINT_TOOL_NAME)).toBe(true);
  });

  it('tells the user, in pt-BR, how many members exist, that it is a cost checkpoint and what continuing does', async () => {
    await renderIn('pt-BR');
    expect(widget().getAttribute('data-state')).toBe('pending');
    expect(widgetText()).toContain('Checkpoint da equipe');
    expect(widgetText()).toContain('Esta equipe já criou 8 membros, o limite autorizado até aqui (8).');
    expect(widgetText()).toContain('É um checkpoint de segurança e de custo.');
    expect(widgetText()).toContain('continuar a equipe para permitir novas sessões (mais 4 membros)');
    expect(widgetText()).toContain('O limite de 3 sessões rodando ao mesmo tempo continua valendo.');
    expect(screen.getByTestId('team-checkpoint-continue').textContent).toBe('Continuar equipe');
    expect(widgetText()).not.toMatch(/Team checkpoint|Continue team/);
  });

  it('renders in English too', async () => {
    await renderIn('en');
    expect(widgetText()).toContain('This team has created 8 members, the limit authorized so far (8).');
    expect(screen.getByTestId('team-checkpoint-continue').textContent).toBe('Continue team');
  });

  it('"Continuar equipe" asks the host to continue this root, once, and shows the new limit', async () => {
    const teamContinue = await renderIn('pt-BR');
    await act(async () => {
      fireEvent.click(screen.getByTestId('team-checkpoint-continue'));
    });
    expect(teamContinue).toHaveBeenCalledTimes(1);
    // The root and the level of the card that was clicked.
    expect(teamContinue).toHaveBeenCalledWith(SESSION, 8);
    expect(widget().getAttribute('data-state')).toBe('continued');
    expect(screen.getByTestId('team-checkpoint-continued').textContent).toBe('Equipe liberada: até 12 membros');
    expect(screen.queryByTestId('team-checkpoint-continue')).toBeNull();
  });

  it('shows the persisted outcome after a reload, with nothing left to click', async () => {
    const teamContinue = await renderIn('pt-BR', { result: JSON.stringify({ continued: true, authorized: 12 }) });
    expect(widget().getAttribute('data-state')).toBe('continued');
    expect(widgetText()).toContain('Equipe liberada: até 12 membros');
    expect(screen.queryByTestId('team-checkpoint-continue')).toBeNull();
    expect(teamContinue).not.toHaveBeenCalled();
  });

  it('a result that is not the host\'s own outcome does not close the card', async () => {
    for (const result of ['{"decision":"allow","scope":"once"}', 'allow', '{"continued":"yes","authorized":99}']) {
      await renderIn('en', { result });
      expect(widget().getAttribute('data-state'), result).toBe('pending');
      expect(screen.getByTestId('team-checkpoint-continue')).toBeTruthy();
      cleanup();
    }
  });

  it('a click that found the team already continued still shows the current limit', async () => {
    await renderIn('pt-BR', { teamContinue: vi.fn().mockResolvedValue({ success: true, extended: false, authorized: 12 }) });
    await act(async () => {
      fireEvent.click(screen.getByTestId('team-checkpoint-continue'));
    });
    expect(widgetText()).toContain('Equipe liberada: até 12 membros');
  });

  it('keeps the button and says so when continuing fails', async () => {
    for (const teamContinue of [
      vi.fn().mockResolvedValue({ success: false, error: 'boom' }),
      vi.fn().mockRejectedValue(new Error('ipc down')),
    ]) {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      await renderIn('pt-BR', { teamContinue });
      await act(async () => {
        fireEvent.click(screen.getByTestId('team-checkpoint-continue'));
      });
      expect(widget().getAttribute('data-state')).toBe('pending');
      expect(screen.getByTestId('team-checkpoint-error').textContent).toBe('Não foi possível continuar a equipe. Tente de novo.');
      expect(screen.getByTestId('team-checkpoint-continue')).toBeTruthy();
      error.mockRestore();
      cleanup();
    }
  });

  it('a host that cannot continue a team (mobile) gets no button, only where to do it', async () => {
    await renderIn('pt-BR', { teamContinue: null });
    expect(screen.queryByTestId('team-checkpoint-continue')).toBeNull();
    expect(screen.getByTestId('team-checkpoint-desktop-only').textContent)
      .toBe('Abra esta sessão no aplicativo desktop para continuar a equipe.');
  });
});
