/**
 * The sub-agent card in the transcript: fixed UI strings (agent kind, status,
 * section labels) follow the UI language; the model-produced `description` and
 * `prompt` from the tool call arguments are shown exactly as received.
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Provider as JotaiProvider } from 'jotai';
import type { TranscriptViewMessage } from '../../../../ai/server/transcript/TranscriptProjector';
import { store } from '../../../../store/store';
import { I18nProvider } from '../../../../i18n/react';
import { setLanguage } from '../../../../i18n';
import { RichTranscriptView } from '../RichTranscriptView';

vi.mock('virtua', async () => {
  const ReactModule = await import('react');
  return {
    VList: ReactModule.forwardRef(({ children }: { children: React.ReactNode }, ref) => {
      ReactModule.useImperativeHandle(ref, () => ({
        cache: undefined,
        scrollOffset: 0,
        scrollSize: 300,
        viewportSize: 100,
        findItemIndex: () => 0,
        scrollToIndex: vi.fn(),
        scrollBy: vi.fn(),
      }));
      return <div data-testid="mock-vlist">{ReactModule.Children.toArray(children)}</div>;
    }),
  };
});

const DESCRIPTION = 'Find files handling team session metadata';
const PROMPT = 'Search the repo for team session metadata handlers.';

function subagentMessage(): TranscriptViewMessage {
  return {
    id: 1,
    sequence: 1,
    createdAt: new Date(1_784_648_445_000),
    type: 'subagent',
    subagentId: null,
    toolCall: {
      toolName: 'Task',
      toolDisplayName: 'Task',
      status: 'completed',
      description: null,
      arguments: { description: DESCRIPTION, prompt: PROMPT, run_in_background: true },
      targetFilePath: null,
      mcpServer: null,
      mcpTool: null,
      providerToolCallId: 'toolu_subagent_1',
      progress: [],
      result: 'Done searching.',
    },
    subagent: { childEvents: [] },
  } as unknown as TranscriptViewMessage;
}

async function renderIn(language: 'en' | 'pt-BR') {
  await act(async () => {
    await setLanguage(language);
  });
  return render(
    <JotaiProvider store={store}>
      <I18nProvider>
        <RichTranscriptView sessionId="s1" sessionStatus="idle" messages={[subagentMessage()]}
          provider="claude-code" persistScrollState={false} />
      </I18nProvider>
    </JotaiProvider>
  );
}

beforeEach(() => {
  vi.stubGlobal('CSS', { highlights: { delete: vi.fn(), set: vi.fn() } });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await setLanguage('en');
});

describe('sub-agent card localization', () => {
  it('translates the fixed UI to pt-BR and leaves the model-produced description intact', async () => {
    const { container } = await renderIn('pt-BR');
    expect(container.textContent).toContain('Agente em segundo plano');
    expect(container.textContent).toContain('Concluído');
    expect(container.textContent).not.toContain('Background Agent');

    fireEvent.click(container.querySelector('.rich-transcript-tool-button')!);
    expect(screen.getByText(DESCRIPTION)).toBeTruthy();
    expect(container.textContent).toContain('Ver prompt completo');
    expect(container.textContent).toContain('Ver resultado');
  });

  it('keeps the English wording in en', async () => {
    const { container } = await renderIn('en');
    expect(container.textContent).toContain('Background Agent');
    expect(container.textContent).toContain('Done');
    fireEvent.click(container.querySelector('.rich-transcript-tool-button')!);
    expect(screen.getByText(DESCRIPTION)).toBeTruthy();
    expect(container.textContent).toContain('View full prompt');
    expect(container.textContent).toContain('View result');
  });
});
