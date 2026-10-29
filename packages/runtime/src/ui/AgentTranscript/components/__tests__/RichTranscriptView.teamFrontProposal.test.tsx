/**
 * The host notice that follows a front proposal decision (F1.1) is a system status line with a
 * localized label, never a "You" message. Its body is the agent-facing English text.
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
        cache: undefined, scrollOffset: 0, scrollSize: 300, viewportSize: 100,
        findItemIndex: () => 0, scrollToIndex: vi.fn(), scrollBy: vi.fn(),
      }));
      return <div data-testid="mock-vlist">{ReactModule.Children.toArray(children)}</div>;
    }),
  };
});

const ROOT = 'team-root';
const NOTICE = 'The user decided your front proposal "tfp_x": 1 of 2 items written.\n- item 0 (create) "Billing": written; id "tfr_9", status "active"';

function makeMessage(index: number, overrides: Partial<TranscriptViewMessage>): TranscriptViewMessage {
  return {
    id: index + 1, sequence: index + 1, createdAt: new Date(1_784_648_445_000 + index),
    type: 'assistant_message', subagentId: null, ...overrides,
  };
}

const notice = makeMessage(1, {
  type: 'system_message',
  text: NOTICE,
  systemMessage: { systemType: 'status', reminderKind: 'team_front_proposal' },
});

async function renderIn(language: 'en' | 'pt-BR', messages: TranscriptViewMessage[]) {
  await act(async () => {
    await setLanguage(language);
  });
  return render(
    <JotaiProvider store={store}>
      <I18nProvider>
        <RichTranscriptView sessionId={ROOT} sessionStatus="idle" messages={messages} provider="claude-code" persistScrollState={false} />
      </I18nProvider>
    </JotaiProvider>,
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

describe('front proposal decision notice', () => {
  it('is a system status line with a pt-BR label, not a message from "You"', async () => {
    await renderIn('pt-BR', [notice]);
    const card = screen.getByTestId('system-reminder-card');
    expect(card.getAttribute('data-reminder-kind')).toBe('team_front_proposal');
    expect(card.textContent).toContain('Proposta de frentes: decisão registrada');
    expect(card.textContent).not.toContain('teamFrontProposal.');
    expect(screen.queryByText('You')).toBeNull();
    // Expanding it shows the agent-facing body as it is: English, untranslated.
    fireEvent.click(card.querySelector('button')!);
    expect(card.textContent).toContain('The user decided your front proposal');
  });

  it('has an English label in English', async () => {
    await renderIn('en', [notice]);
    expect(screen.getByTestId('system-reminder-card').textContent).toContain('Front proposal: decision recorded');
  });

  it('the same text as an ordinary user message would be shown as "You" (what the origin prevents)', async () => {
    await renderIn('pt-BR', [makeMessage(1, { type: 'user_message', text: NOTICE })]);
    expect(screen.queryByTestId('system-reminder-card')).toBeNull();
    expect(screen.getByText('You')).toBeTruthy();
  });
});
