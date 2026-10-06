// @vitest-environment jsdom
/** Feedback request labels computed in the presentation models follow the UI language. */
import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage } from '@nimbalyst/runtime/i18n';
import {
  feedbackBacklinkAuthorLabel,
  feedbackBacklinkProgressLabel,
  feedbackBacklinkStatus,
} from '../feedbackBacklinkModel';
import { unpublishableSubjectMessage } from '../publishFeedbackSubject';

afterEach(async () => {
  await setLanguage('en');
});

const progress = { answeredRecipientCount: 1, totalRecipientCount: 3, quorumReached: false };

describe('feedback request i18n', () => {
  it('keeps the English labels', () => {
    expect(feedbackBacklinkStatus({ lifecycle: { status: 'open' }, progress } as never).label).toBe('Open');
    expect(feedbackBacklinkProgressLabel({ progress } as never)).toBe('1/3 responded');
    expect(feedbackBacklinkAuthorLabel({ author: { onBehalfOfUserId: 'me' } } as never, 'me' as never)).toBe('Asked by you');
    expect(unpublishableSubjectMessage({ kind: 'session' } as never)).toBe(
      'A session cannot be published, so a teammate cannot be asked to review one.',
    );
  });

  it('renders pt-BR labels', async () => {
    await setLanguage('pt-BR');
    expect(feedbackBacklinkStatus({ lifecycle: { status: 'open' }, progress: { ...progress, quorumReached: true } } as never).label).toBe('Respondida');
    expect(feedbackBacklinkStatus({ lifecycle: { status: 'cancelled' }, progress } as never).label).toBe('Cancelada');
    expect(feedbackBacklinkProgressLabel({ progress } as never)).toBe('1/3 responderam');
    expect(feedbackBacklinkAuthorLabel(
      { author: { kind: 'agent', onBehalfOfUserId: 'other', sessionName: 'Revisão' } } as never,
      'me' as never,
    )).toBe('Solicitado por Revisão');
  });
});
