import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguage, t } from '@nimbalyst/runtime/i18n';
import { getRelativeTimeString, getTimeGroupKey, groupSessionsByTime } from '../dateFormatting';

const NOW = new Date(2026, 5, 17, 12, 0, 0).getTime();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(async () => {
  vi.useRealTimers();
  await setLanguage('en');
});

const ago = (ms: number) => getRelativeTimeString(NOW - ms);

describe('getRelativeTimeString i18n', () => {
  it('keeps the exact original English wording', () => {
    expect(ago(30 * 1000)).toBe('Just now');
    expect(ago(1 * MIN)).toBe('1 min ago');
    expect(ago(5 * MIN)).toBe('5 mins ago');
    expect(ago(1 * HOUR)).toBe('1 hr ago');
    expect(ago(3 * HOUR)).toBe('3 hrs ago');
    expect(ago(1 * DAY)).toBe('1 day ago');
    expect(ago(4 * DAY)).toBe('4 days ago');
    expect(ago(7 * DAY)).toBe('1 week ago');
    expect(ago(14 * DAY)).toBe('2 weeks ago');
    expect(ago(30 * DAY)).toBe('1 month ago');
    expect(ago(90 * DAY)).toBe('3 months ago');
    expect(ago(365 * DAY)).toBe('1 year ago');
    expect(ago(800 * DAY)).toBe('2 years ago');
  });

  it('renders pt-BR with singular and plural forms', async () => {
    await setLanguage('pt-BR');
    expect(ago(30 * 1000)).toBe('Agora');
    expect(ago(1 * MIN)).toBe('há 1 min');
    expect(ago(5 * MIN)).toBe('há 5 min');
    expect(ago(1 * HOUR)).toBe('há 1 h');
    expect(ago(3 * HOUR)).toBe('há 3 h');
    expect(ago(1 * DAY)).toBe('há 1 dia');
    expect(ago(4 * DAY)).toBe('há 4 dias');
    expect(ago(7 * DAY)).toBe('há 1 semana');
    expect(ago(14 * DAY)).toBe('há 2 semanas');
    expect(ago(30 * DAY)).toBe('há 1 mês');
    expect(ago(90 * DAY)).toBe('há 3 meses');
    expect(ago(365 * DAY)).toBe('há 1 ano');
    expect(ago(800 * DAY)).toBe('há 2 anos');
  });

  it('uses the plural (not CLDR "one") for zero in pt-BR and keeps English plural for zero', async () => {
    expect(t('general:relativeTime.daysAgo', { count: 0 })).toBe('0 days ago');
    await setLanguage('pt-BR');
    expect(t('general:relativeTime.daysAgo', { count: 0 })).toBe('há 0 dias');
    expect(t('general:relativeTime.monthsAgo', { count: 0 })).toBe('há 0 meses');
    expect(t('general:relativeTime.yearsAgo', { count: 0 })).toBe('há 0 anos');
  });

  it('keeps the persisted English time-group keys regardless of language', async () => {
    await setLanguage('pt-BR');
    expect(getTimeGroupKey(NOW - HOUR)).toBe('Today');
    expect(getTimeGroupKey(NOW - DAY)).toBe('Yesterday');
    const grouped = groupSessionsByTime([{ createdAt: NOW - HOUR }]);
    expect(Object.keys(grouped)).toEqual(['Today']);
  });
});
