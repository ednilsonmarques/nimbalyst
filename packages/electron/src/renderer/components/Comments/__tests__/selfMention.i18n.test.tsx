// @vitest-environment jsdom
/**
 * Regression: the mention label is serialized into the message body, so it must
 * not change with the UI language. Mentioning yourself in pt-BR sends the same
 * token as in English.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLanguage } from '@nimbalyst/runtime/i18n';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';

import { CommentComposer } from '../CommentComposer';
import { FULL_CAPABILITIES, createCommentFixtures } from '../commentFixtures';
import { composerText, type } from '../composerTestDriver';
import { toMentionDirectory } from '../../TeamMode/roomViewModel';

const NOW = Date.parse('2026-07-26T18:00:00.000Z');
const members = [
  { memberId: 'user-me', email: 'me@example.com', name: 'Me Person', role: 'member' },
  { memberId: 'user-dana', email: 'dana@example.com', name: 'Dana Okafor', role: 'admin' },
];

afterEach(async () => {
  cleanup();
  await setLanguage('en');
});

async function sendSelfMention(language: 'en' | 'pt-BR'): Promise<string> {
  await act(async () => {
    await setLanguage(language);
  });
  const fixtures = createCommentFixtures({ now: NOW });
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(
    <I18nProvider>
      <CommentComposer
        capabilities={FULL_CAPABILITIES}
        context={fixtures.context}
        directory={toMentionDirectory(members, 'user-me')}
        orgId={fixtures.orgId}
        onSubmit={onSubmit}
      />
    </I18nProvider>,
  );
  type('@me');
  fireEvent.click(await screen.findByTestId('mention-option-person-user-me'));
  await waitFor(() => expect(composerText()).toContain('nimbalyst://user/user-me'));
  fireEvent.click(screen.getByTestId('comment-composer-send'));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  const text = onSubmit.mock.calls[0][0].body.text as string;
  cleanup();
  return text;
}

describe('self mention i18n', () => {
  it('keeps the directory label language-independent', async () => {
    await setLanguage('pt-BR');
    const directory = toMentionDirectory(members, 'user-me');
    expect(directory.people.find((person) => person.userId === 'user-me')?.displayName).toBe('You');
    expect(directory.displayNames['user-me']).toBe('You');
  });

  it('serializes the same token in pt-BR as in English', async () => {
    const english = await sendSelfMention('en');
    const portuguese = await sendSelfMention('pt-BR');
    expect(portuguese).not.toContain('Você');
    expect(portuguese).toBe(english);
    expect(english).toContain('nimbalyst://user/user-me');
  });
});
