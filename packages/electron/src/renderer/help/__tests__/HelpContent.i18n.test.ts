// @vitest-environment jsdom
/**
 * The HelpContent registry stays the English source of truth; getHelpContent
 * resolves `general:help.<testId>` in the current UI language.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { I18N_RESOURCES, setLanguage } from '@nimbalyst/runtime/i18n';
import { CANVAS_HELP_CONTENT } from '@nimbalyst/runtime/canvas/canvasHelpContent';
import { HelpContent, getHelpContent } from '../HelpContent';

type HelpTree = Record<string, { title: string; body: string }>;
const enHelp = (I18N_RESOURCES.en.general as unknown as { help: HelpTree }).help;
const ptHelp = (I18N_RESOURCES['pt-BR'].general as unknown as { help: HelpTree }).help;
const ownIds = Object.keys(HelpContent).filter((id) => !(id in CANVAS_HELP_CONTENT));

afterEach(async () => {
  await setLanguage('en');
});

describe('HelpContent i18n', () => {
  it('has an English resource byte-identical to every registry entry', () => {
    expect(ownIds.length).toBeGreaterThan(60);
    for (const id of ownIds) {
      expect(enHelp[id], id).toEqual({ title: HelpContent[id].title, body: HelpContent[id].body });
    }
  });

  it('returns the unchanged English entry (with shortcut) in English', () => {
    for (const id of ownIds) {
      expect(getHelpContent(id)).toEqual(HelpContent[id]);
    }
  });

  it('returns pt-BR text without raw keys and keeps the shortcut', async () => {
    await setLanguage('pt-BR');
    for (const id of ownIds) {
      const entry = getHelpContent(id)!;
      expect(entry.title, id).toBe(ptHelp[id].title);
      expect(entry.body, id).toBe(ptHelp[id].body);
      expect(entry.title).not.toMatch(/^help\./);
      expect(entry.shortcut).toBe(HelpContent[id].shortcut);
    }
    expect(getHelpContent('terminal-panel-button')?.body).toBe('Mostre ou oculte o painel do terminal para executar comandos.');
    expect(getHelpContent('file-tree-new-file-button')?.title).toBe('Novo arquivo');
  });

  it('falls back to the English registry for entries without a translation', async () => {
    await setLanguage('pt-BR');
    for (const id of Object.keys(CANVAS_HELP_CONTENT)) {
      expect(getHelpContent(id)?.title).toBe(CANVAS_HELP_CONTENT[id].title);
    }
  });
});
