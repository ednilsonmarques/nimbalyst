// @vitest-environment node
/**
 * The dialog's strings, judged against both languages: the two agent.json files carry the same
 * teamMissionDialog.* keys with the same {{placeholders}}, and every key the code can ask for
 * (the static status and error maps) resolves to a real string in en and in pt-BR.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage, t as translate } from '@nimbalyst/runtime/i18n';
import { TEAM_MISSION_CLIENT_ERROR_CODES, TEAM_MISSION_ERROR_CODES } from '../../../../shared/teamMission';
import { TEAM_MISSION_LOOKUP_KEYS, teamFrontStatusLabelKey, teamMissionErrorKey, type TeamFrontStatusKind } from '../teamMissionDialog';

const LOCALES = path.resolve(__dirname, '../../../../../../runtime/src/i18n/locales');
const load = (language: string) => JSON.parse(readFileSync(path.join(LOCALES, language, 'agent.json'), 'utf8'));

/** Flatten a JSON subtree into { 'a.b.c': 'text' }. */
function flatten(node: unknown, prefix: string, out: Record<string, string> = {}): Record<string, string> {
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) flatten(value, prefix ? `${prefix}.${key}` : key, out);
  } else if (typeof node === 'string') {
    out[prefix] = node;
  }
  return out;
}

const placeholders = (text: string) => [...text.matchAll(/\{\{\s*([\w.-]+)\s*(?:,[^}]*)?\}\}/g)].map((m) => m[1]).sort();

function missionStrings(language: string): Record<string, string> {
  const agent = load(language);
  return {
    ...flatten(agent.teamMissionDialog, 'teamMissionDialog'),
    'sessionList.create.newTeamMission': agent.sessionList.create.newTeamMission,
  };
}

afterEach(async () => {
  await setLanguage('en');
});

describe('en and pt-BR carry the same mission strings', () => {
  const en = missionStrings('en');
  const pt = missionStrings('pt-BR');

  it('has the same keys', () => {
    expect(Object.keys(pt).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(en).length).toBeGreaterThan(30);
  });

  it('has the same {{placeholders}} for every key, and no empty text', () => {
    for (const key of Object.keys(en)) {
      expect(placeholders(pt[key]), key).toEqual(placeholders(en[key]));
      expect(pt[key].trim(), key).not.toBe('');
      expect(en[key].trim(), key).not.toBe('');
    }
  });

  it('shows the main detail through one interpolated key, not by gluing a label to the message', () => {
    expect(en['teamMissionDialog.detailsLine']).toBe('Details: {{message}}');
    expect(pt['teamMissionDialog.detailsLine']).toBe('Detalhes: {{message}}');
    expect(en).not.toHaveProperty('teamMissionDialog.detailsLabel');
    expect(pt).not.toHaveProperty('teamMissionDialog.detailsLabel');
  });

  it('interpolates by name, never by a plural count', () => {
    for (const key of Object.keys(en)) expect(placeholders(en[key]), key).not.toContain('count');
  });

  it('calls the Tracker "Rastreador" in pt-BR, as the rest of the app does', () => {
    for (const [key, text] of Object.entries(pt)) expect(text, key).not.toMatch(/\bTracker\b/);
  });
});

describe('every key the code can ask for resolves to a real string in both languages', () => {
  const STATUSES: TeamFrontStatusKind[] = ['active', 'paused', 'closed', 'unknown'];
  const errorKeys = [
    ...TEAM_MISSION_ERROR_CODES,
    ...TEAM_MISSION_CLIENT_ERROR_CODES,
    undefined, // the generic one
    'a-code-from-the-future',
  ].map((code) => teamMissionErrorKey(code));
  const statusKeys = [...STATUSES, 'on-hold' as TeamFrontStatusKind].map((status) => teamFrontStatusLabelKey(status));

  for (const language of ['en', 'pt-BR'] as const) {
    it(`status and error keys exist in ${language}`, async () => {
      await setLanguage(language);
      for (const key of [...statusKeys, ...errorKeys]) {
        const text = translate(`agent:${key}`);
        expect(text, key).not.toBe(key);
        expect(text, key).not.toBe(`agent:${key}`);
        expect(text.trim(), key).not.toBe('');
      }
    });
  }

  for (const language of ['en', 'pt-BR'] as const) {
    it(`every key of the active-mission lookup exists in ${language}`, async () => {
      await setLanguage(language);
      const keys = Object.values(TEAM_MISSION_LOOKUP_KEYS);
      expect(keys.length).toBeGreaterThanOrEqual(10);
      expect(keys).toContain('teamMissionDialog.activeMission.noneAfterFailure');
      for (const key of keys) {
        const text = translate(`agent:${key}`);
        expect(text, key).not.toBe(key);
        expect(text, key).not.toBe(`agent:${key}`);
        expect(text.trim(), key).not.toBe('');
      }
    });
  }

  it('the lookup keys are all in the JSON of both languages (nothing only in the code, nothing orphaned)', () => {
    const en = missionStrings('en');
    const pt = missionStrings('pt-BR');
    for (const key of Object.values(TEAM_MISSION_LOOKUP_KEYS)) {
      expect(en, key).toHaveProperty([key]);
      expect(pt, key).toHaveProperty([key]);
    }
    const lookupInJson = Object.keys(en).filter((key) => key.startsWith('teamMissionDialog.activeMission.')).sort();
    expect(lookupInJson).toEqual([...Object.values(TEAM_MISSION_LOOKUP_KEYS)].sort());
  });

  it('the two "none found" texts are different, and the neutral one does not claim a mission exists', () => {
    const en = missionStrings('en');
    const pt = missionStrings('pt-BR');
    expect(en['teamMissionDialog.activeMission.noneAfterFailure']).toBe('No mission was found on this front. If the creation did go through, it will appear in the session list.');
    expect(pt['teamMissionDialog.activeMission.noneAfterFailure']).toBe('Nenhuma missão foi encontrada nesta frente. Se a criação foi concluída, ela aparecerá na lista de sessões.');
    expect(en['teamMissionDialog.activeMission.noneAfterFailure']).not.toBe(en['teamMissionDialog.activeMission.none']);
    expect(pt['teamMissionDialog.activeMission.noneAfterFailure']).not.toBe(pt['teamMissionDialog.activeMission.none']);
    expect(en['teamMissionDialog.activeMission.noneAfterFailure']).not.toMatch(/active mission|could not be located/i);
    expect(pt['teamMissionDialog.activeMission.noneAfterFailure']).not.toMatch(/missão ativa|não foi possível localizar/i);
  });

  it('the generic and unknown fallbacks are what an unknown input gets', () => {
    expect(teamMissionErrorKey('a-code-from-the-future')).toBe('teamMissionDialog.errors.generic');
    expect(teamFrontStatusLabelKey('on-hold' as TeamFrontStatusKind)).toBe('teamMissionDialog.status.unknown');
  });
});
