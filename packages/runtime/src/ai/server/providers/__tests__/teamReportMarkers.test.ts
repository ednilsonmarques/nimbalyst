/**
 * NIB.39 item B: one definition of the reviewer's verdict and the advisor's
 * opinion markers (teamReportMarkers.mjs), read by the pilot report script.
 * A localized marker still counts; prose that merely mentions a verdict does not.
 */
import { describe, expect, it } from 'vitest';
import { ADVISOR_OPINION_PATTERN, REVIEW_VERDICT_PATTERN, readReviewVerdict } from '../teamReportMarkers.mjs';

describe('review verdict marker', () => {
  it('reads the English and pt-BR forms, and nothing else', () => {
    expect(readReviewVerdict('Verdict: no blockers\n\n## Findings')).toBe(true);
    expect(readReviewVerdict('Verdict: blockers found')).toBe(false);
    expect(readReviewVerdict('Veredito: sem bloqueantes')).toBe(true);
    expect(readReviewVerdict('Veredito: bloqueantes encontrados')).toBe(false);
    expect(readReviewVerdict('O veredito ainda não saiu.')).toBeNull();
    expect(readReviewVerdict(null)).toBeNull();
    expect(new RegExp(REVIEW_VERDICT_PATTERN).test('Verdict: maybe')).toBe(false);
  });
});

describe('advisor opinion marker', () => {
  it('reads every contract outcome in English and pt-BR', () => {
    const marker = new RegExp(ADVISOR_OPINION_PATTERN);
    for (const line of [
      'Independent opinion: no material objections',
      'Independent opinion: approved with reservations',
      'Independent opinion: correct before proceeding',
      'Independent opinion: reconsider the approach',
      'Opinião independente: aprovado com ressalvas',
      'Parecer independente: corrigir antes de prosseguir',
    ]) {
      expect(marker.test(line), line).toBe(true);
    }
    expect(marker.test('Independent opinion: looks fine')).toBe(false);
  });
});
