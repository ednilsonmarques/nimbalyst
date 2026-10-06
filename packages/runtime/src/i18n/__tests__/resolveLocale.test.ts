import { describe, expect, it } from 'vitest';
import { matchSupportedLanguage, resolveLocale } from '../resolveLocale';

describe('matchSupportedLanguage', () => {
  it('matches exact and differently formatted locales', () => {
    expect(matchSupportedLanguage('pt-BR')).toBe('pt-BR');
    expect(matchSupportedLanguage('pt_BR')).toBe('pt-BR');
    expect(matchSupportedLanguage('pt_BR.UTF-8')).toBe('pt-BR');
    expect(matchSupportedLanguage('PT-br')).toBe('pt-BR');
    expect(matchSupportedLanguage('en-US')).toBe('en');
    expect(matchSupportedLanguage('en')).toBe('en');
  });

  it('falls back to the base language', () => {
    expect(matchSupportedLanguage('pt')).toBe('pt-BR');
    expect(matchSupportedLanguage('pt-PT')).toBe('pt-BR');
    expect(matchSupportedLanguage('en-GB')).toBe('en');
  });

  it('returns null for unsupported or empty locales', () => {
    expect(matchSupportedLanguage('de-DE')).toBeNull();
    expect(matchSupportedLanguage('')).toBeNull();
    expect(matchSupportedLanguage(undefined)).toBeNull();
    expect(matchSupportedLanguage(null)).toBeNull();
  });
});

describe('resolveLocale', () => {
  it('uses an explicit supported preference regardless of the system', () => {
    expect(resolveLocale('pt-BR', ['en-US'])).toBe('pt-BR');
    expect(resolveLocale('en', ['pt-BR'])).toBe('en');
  });

  it('follows the system locale for "system"', () => {
    expect(resolveLocale('system', ['pt-BR'])).toBe('pt-BR');
    expect(resolveLocale('system', ['en-US'])).toBe('en');
  });

  it('picks the first supported system locale in priority order', () => {
    expect(resolveLocale('system', ['de-DE', 'pt-BR', 'en-US'])).toBe('pt-BR');
    expect(resolveLocale('system', [undefined, '', 'fr-FR', 'en-US'])).toBe('en');
  });

  it('falls back to English for unsupported or missing system locales', () => {
    expect(resolveLocale('system', ['de-DE', 'ja-JP'])).toBe('en');
    expect(resolveLocale('system', [])).toBe('en');
    expect(resolveLocale('system')).toBe('en');
  });

  it('treats unknown or corrupt preferences as "system"', () => {
    expect(resolveLocale('fr', ['pt-BR'])).toBe('pt-BR');
    expect(resolveLocale(undefined, ['pt-BR'])).toBe('pt-BR');
    expect(resolveLocale(42, ['ja-JP'])).toBe('en');
  });
});
