// @vitest-environment jsdom
/**
 * Desktop context menus follow the UI language: real menus render translated
 * labels, never raw keys, and the context-menu sources carry no hardcoded
 * English labels.
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';
import { I18N_RESOURCES, setLanguage } from '@nimbalyst/runtime/i18n';
import { TerminalTabContextMenu } from '../TerminalBottomPanel/TerminalTabContextMenu';
import { TerminalContextMenu } from '../Terminal/TerminalContextMenu';
import { GutterContextMenu } from '../NavigationGutter/GutterContextMenu';
import { getLocalizedShowInFileBrowserLabel } from '../../utils/showInFileBrowserLabel';
import { AccountInspectorPopover } from '../Accounts/AccountInspectorPopover';
import { formatLastSync } from '../Accounts/syncStatusSummary';

const RAW_KEY = /\b(menu|contextMenu)[.:][\w.]+/;

afterEach(async () => {
  cleanup();
  await setLanguage('en');
});

async function renderIn(language: 'en' | 'pt-BR', ui: React.ReactElement) {
  await act(async () => {
    await setLanguage(language);
  });
  return render(<I18nProvider>{ui}</I18nProvider>);
}

function terminalTabMenu() {
  const handlers = { onClose: vi.fn(), onCloseTab: vi.fn(), onCloseOthers: vi.fn(), onCloseAll: vi.fn(), onCloseToRight: vi.fn() };
  const ui = <TerminalTabContextMenu x={10} y={10} terminalId="t1" terminalCount={3} terminalIndex={0} {...handlers} />;
  return { ui, handlers };
}

describe('context menus i18n', () => {
  it('terminal tab menu in English', async () => {
    await renderIn('en', terminalTabMenu().ui);
    for (const label of ['Close', 'Close Others', 'Close to the Right', 'Close All']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it('terminal tab menu in pt-BR keeps the same actions', async () => {
    const { ui, handlers } = terminalTabMenu();
    const { container } = await renderIn('pt-BR', ui);
    for (const label of ['Fechar', 'Fechar outras', 'Fechar à direita', 'Fechar todas']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    fireEvent.click(screen.getByText('Fechar outras'));
    expect(handlers.onCloseOthers).toHaveBeenCalledTimes(1);
    expect(container.ownerDocument.body.textContent).not.toMatch(RAW_KEY);
  });

  it('terminal and gutter menus translate, including interpolated labels', async () => {
    await renderIn(
      'pt-BR',
      <>
        <TerminalContextMenu x={0} y={0} onClose={() => {}} onClear={() => {}} />
        <GutterContextMenu
          x={0}
          y={0}
          onClose={() => {}}
          targetButton="files"
          items={[{ id: 'files', label: 'Arquivos' } as never, { id: 'terminal', label: 'Terminal' } as never]}
          hiddenIds={['terminal']}
          canHide={() => true}
          onToggleHidden={() => {}}
          onReset={() => {}}
          onOpenCustomize={() => {}}
        />
      </>,
    );
    expect(screen.getByText('Limpar')).toBeTruthy();
    expect(screen.getByText('Ocultar Arquivos')).toBeTruthy();
    expect(screen.getByText('Mostrar Terminal')).toBeTruthy();
    expect(screen.getByText('Personalizar barra de navegação lateral…')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(RAW_KEY);
  });

  it('account menu translates and keeps relative sync time readable', async () => {
    const noop = () => {};
    await renderIn(
      'pt-BR',
      <AccountInspectorPopover
        accounts={[]}
        projectOrg={null}
        anchorEl={null}
        onClose={noop}
        onOpenAccount={noop}
        onManageOrganization={noop}
        onOpenApplicationSettings={noop}
        onOpenProjectSettings={noop}
      />,
    );
    for (const label of ['Configurações do aplicativo', 'Configurações do projeto', 'Adicionar este projeto a uma organização', 'Entrar', 'Entre para sincronizar e colaborar']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(document.body.textContent).not.toMatch(RAW_KEY);
    expect(formatLastSync(1_000, 1_000 + 5 * 60_000)).toBe('há 5 min');
    await setLanguage('en');
    expect(formatLastSync(1_000, 1_000 + 5 * 60_000)).toBe('5m ago');
  });

  it('show-in-file-browser label follows platform and language', async () => {
    expect(getLocalizedShowInFileBrowserLabel('Win32')).toBe('Show in Explorer');
    expect(getLocalizedShowInFileBrowserLabel('MacIntel')).toBe('Show in Finder');
    await setLanguage('pt-BR');
    expect(getLocalizedShowInFileBrowserLabel('Win32')).toBe('Mostrar no Explorador de Arquivos');
    expect(getLocalizedShowInFileBrowserLabel('Linux x86_64')).toBe('Mostrar na pasta');
  });

  it('menu sources use only existing menu keys', () => {
    const files = [
      'FileContextMenu.tsx',
      'CommonFileActions.tsx',
      'TabManager/TabBar.tsx',
      'ProjectRail.tsx',
      'TerminalBottomPanel/TerminalTabContextMenu.tsx',
      'Terminal/TerminalContextMenu.tsx',
      'NavigationGutter/GutterContextMenu.tsx',
      'NavigationGutter/CustomizeGutterPopover.tsx',
      'NavigationGutter/NavigationGutter.tsx',
      'TabEditor/UnifiedEditorHeaderBar.tsx',
      'WorkspaceManager/WorkspaceManager.tsx',
      'Accounts/AccountInspectorPopover.tsx',
    ].map((file) => path.resolve(__dirname, '..', file));
    const flatten = (tree: Record<string, unknown>, prefix = ''): string[] =>
      Object.entries(tree).flatMap(([key, value]) =>
        typeof value === 'string' ? [`${prefix}${key}`] : flatten(value as Record<string, unknown>, `${prefix}${key}.`));
    const known = new Set(flatten(I18N_RESOURCES.en.menu as Record<string, unknown>));
    const has = (key: string) => known.has(key) || known.has(`${key}_one`) || known.has(`${key}_other`);
    const missing: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      const menuNs = /useTranslation\(\s*'menu'\s*\)/.test(source);
      for (const match of source.matchAll(/\b(?:t|translate)\(\s*'([^'$`]+)'/g)) {
        const raw = match[1];
        const key = raw.startsWith('menu:') ? raw.slice(5) : raw;
        if (!raw.startsWith('menu:') && (!menuNs || raw.includes(':'))) continue;
        if (!has(key)) missing.push(`${path.basename(file)}: ${raw}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('fully localized menus carry no hardcoded English labels', () => {
    // Files whose whole UI was localized in this stage. Others in the list
    // above still contain out-of-scope English outside their menus.
    const files = [
      'FileContextMenu.tsx',
      'CommonFileActions.tsx',
      'TerminalBottomPanel/TerminalTabContextMenu.tsx',
      'Terminal/TerminalContextMenu.tsx',
      'NavigationGutter/GutterContextMenu.tsx',
      'NavigationGutter/CustomizeGutterPopover.tsx',
      'Accounts/AccountInspectorPopover.tsx',
    ].map((file) => path.resolve(__dirname, '..', file));
    const patterns: RegExp[] = [
      // JSX text, alone or next to an expression: <span>Delete {n} Items</span>
      />\s*([A-Z][a-z]+(?:[ '][A-Za-z&;]+)*(?:\.\.\.|…)?)\s*(?:\{|<)/g,
      // A JSX text line on its own
      /^\s+([A-Z][a-z]+(?: [A-Za-z&;']+)*(?:\.\.\.|…)?)\s*\r?$/gm,
      // Literal user-facing attributes
      /\b(?:title|aria-label|placeholder)="([A-Z][^"]*)"/g,
      // Template-literal labels: `Show ${x}`
      /`([A-Z][a-z]+ \$\{)/g,
    ];
    const hardcoded: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) hardcoded.push(`${path.basename(file)}: ${match[1]}`);
      }
    }
    expect(hardcoded).toEqual([]);
  });
});
