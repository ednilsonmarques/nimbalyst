/**
 * Source-level guard for the Office and Command Center POCs: they are
 * presentation over existing renderer state, so their files must not reach the
 * IPC bridge, embed foreign content, render raw HTML, run effects, timers or
 * watchers, or write atoms. Comments are stripped first so a rule is matched
 * against code only.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const officeDir = join(__dirname, '..');
// The Command Center (POC G+) lives beside the Office and obeys the same rules.
const commandDir = join(officeDir, '..', 'commandCenter');

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function read(path: string): string {
  return stripComments(readFileSync(path, 'utf8'));
}

const sourcesOf = (dir: string) =>
  readdirSync(dir)
    .filter((name) => /\.(ts|tsx)$/.test(name))
    .map((name) => ({ name, text: read(join(dir, name)) }));

const officeSources = sourcesOf(officeDir);
const commandSources = sourcesOf(commandDir);
const allSources = [
  ...officeSources.map((s) => ({ ...s, name: `office/${s.name}` })),
  ...commandSources.map((s) => ({ ...s, name: `commandCenter/${s.name}` })),
];

// The hunk of the Team view that switches presentations.
const teamViewText = read(join(officeDir, '..', 'AgentTeamView.tsx'));

const FORBIDDEN: Array<[string, RegExp]> = [
  ['IPC bridge or Electron', /electronAPI|ipcRenderer|\binvoke\(|from ['"]electron['"]|\bfetch\(/],
  ['embedded or raw HTML', /<iframe|<webview|<object|<embed|dangerouslySetInnerHTML|srcDoc|innerHTML/i],
  ['MockupLM', /mockup/i],
  ['atom writes', /useSetAtom|\buseAtom\(|\bstore\.set\(|getDefaultStore|\.set\(\s*session/],
  ['effects, timers, polling or watchers', /useEffect|useLayoutEffect|setInterval|setTimeout|requestAnimationFrame|watch\(|EventSource|WebSocket|ResizeObserver|IntersectionObserver|MutationObserver/],
  ['persistence', /localStorage|sessionStorage|atomWithStorage/],
  ['team or session actions', /team:continue|sendMessage|respondToPrompt|create_session|spawn_session|send_prompt|markSessionRead|selectSessionActionAtom/],
];

describe('Office boundaries', () => {
  it('has source files to check', () => {
    expect(officeSources.map((s) => s.name).sort()).toEqual(['OfficeView.tsx', 'officeModel.ts', 'useOfficeRooms.ts']);
    expect(commandSources.map((s) => s.name).sort()).toEqual([
      'CommandCenterContainer.tsx',
      'CommandCenterView.tsx',
      'iso.ts',
      'officeScene.ts',
      'roomArt.tsx',
      'stationArt.tsx',
    ]);
  });

  for (const [label, pattern] of FORBIDDEN) {
    it(`office/ and commandCenter/ use no ${label}`, () => {
      const offenders = allSources.filter((s) => pattern.test(s.text)).map((s) => s.name);
      expect(offenders).toEqual([]);
    });
  }

  it('keeps the Command Center scene and projection pure: no React, no atoms, no i18n', () => {
    for (const name of ['officeScene.ts', 'iso.ts']) {
      const text = commandSources.find((s) => s.name === name)!.text;
      expect(/from ['"](react|jotai|@nimbalyst\/runtime[^'"]*)['"]/.test(text), name).toBe(false);
      expect(/store\/atoms/.test(text), name).toBe(false);
    }
  });

  it('reads atoms in exactly one place: the shared useOfficeRooms hook, never in a view', () => {
    // Type-only imports (`import type`) read nothing at run time.
    const readers = allSources
      .filter((s) => /store\/atoms|useAtomValue|from ['"]jotai['"]/.test(s.text.replace(/import type [^;]+;/g, '')))
      .map((s) => s.name);
    expect(readers).toEqual(['office/useOfficeRooms.ts']);
  });

  it('adds no stylesheet that animates a filter, blur or blend mode', () => {
    const css = readFileSync(join(commandDir, 'CommandCenter.css'), 'utf8');
    expect(css).not.toMatch(/mix-blend-mode|backdrop-filter|filter:\s*blur|feGaussianBlur|drop-shadow/);
  });

  it('AgentTeamView adds only a local toggle and the Office and Command Center elements', () => {
    // The view keeps its single IPC seam in teamDataSource and gains no writes or effects.
    for (const [, pattern] of FORBIDDEN.filter(([label]) => label !== 'team or session actions')) {
      expect(pattern.test(teamViewText)).toBe(false);
    }
    expect(teamViewText).toMatch(/useState<TeamPresentation>\('tree'\)/);
    expect(teamViewText).toMatch(/<OfficeView teams=\{teams\} onSessionOpen=\{onSessionOpen\} \/>/);
    expect(teamViewText).toMatch(/<CommandCenterContainer teams=\{teams\} onSessionOpen=\{onSessionOpen\} \/>/);
  });
});
