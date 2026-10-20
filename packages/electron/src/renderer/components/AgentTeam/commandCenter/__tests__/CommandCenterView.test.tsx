// @vitest-environment jsdom
/**
 * The Command Center is a third presentation of the same Team read model: same
 * forest, live state from the existing per-session atoms, and the caller's
 * select action as its only interaction. The Tree stays the default.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { SessionMeta } from '@nimbalyst/runtime';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';
import { setLanguage } from '@nimbalyst/runtime/i18n';

const teamFlag = vi.hoisted(() => ({ enabled: true }));

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({ MaterialSymbol: () => null }));
vi.mock('@nimbalyst/runtime/ui/icons/ProviderIcons', () => ({ ProviderIcon: () => null }));
vi.mock('../../../AgenticCoding/SessionListItem', () => ({ SessionStatusIndicator: () => null }));
vi.mock('../../../../store/atoms/appSettings', async () => {
  const { atom } = await import('jotai');
  const flagAtom = atom(() => teamFlag.enabled);
  return { alphaFeatureEnabledAtom: () => flagAtom };
});

import {
  activeSessionIdAtom,
  sessionHasPendingInteractivePromptAtom,
  sessionPendingPromptsAtom,
  sessionProcessingAtom,
  sessionRegistryAtom,
  type PendingPrompt,
} from '../../../../store/atoms/sessions';
import { sessionErrorAtom } from '../../../../store/atoms/sessionTranscript';
import { AgentTeamView } from '../../AgentTeamView';
import { CommandCenterView } from '../CommandCenterView';
import type { OfficeMemberView, OfficeRoomView } from '../../office/officeModel';

const RAW_KEY = /\bagentTeam\.[\w.]+/;
const css = readFileSync(join(__dirname, '..', 'CommandCenter.css'), 'utf8');

function session(id: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: id,
    provider: 'claude-code',
    model: 'claude-code:sonnet',
    sessionType: 'session',
    workspaceId: '/project',
    worktreeId: null,
    parentSessionId: null,
    childCount: 0,
    uncommittedCount: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    messageCount: 0,
    isArchived: false,
    isPinned: false,
    ...overrides,
  };
}

function pending(sessionId: string, promptType: PendingPrompt['promptType']): PendingPrompt {
  return { id: `${sessionId}-${promptType}`, sessionId, promptType, promptId: 'p1', data: {}, createdAt: 1 } as PendingPrompt;
}

let store: ReturnType<typeof createStore>;
let invoke: ReturnType<typeof vi.fn>;

function seedTeam() {
  store.set(
    sessionRegistryAtom,
    new Map(
      [
        session('lead', { teamMode: true, title: 'Coordenação', provider: 'claude-code', model: 'claude-code:opus' }),
        session('exp', { createdBySessionId: 'lead', teamRole: 'explorer', title: 'Explorer', createdAt: 2_000, teamMission: 'Mapear as regras de impostos' }),
        session('impl', { createdBySessionId: 'lead', teamRole: 'implementer', title: 'Implementer', createdAt: 2_500 }),
        session('rev', { createdBySessionId: 'lead', teamRole: 'reviewer', title: 'Reviewer', createdAt: 3_000 }),
        session('adv', {
          createdBySessionId: 'lead',
          teamRole: 'advisor',
          title: 'Consultor',
          provider: 'openai-codex',
          model: 'openai-codex:gpt-6.1-sol',
          createdAt: 4_000,
        }),
        session('solta', { title: 'Sessão solta' }),
      ].map((s) => [s.id, s]),
    ),
  );
}

function renderBoard(onSessionOpen = vi.fn()) {
  const view = render(
    <Provider store={store}>
      <I18nProvider>
        <AgentTeamView onSessionOpen={onSessionOpen} />
      </I18nProvider>
    </Provider>,
  );
  return { ...view, onSessionOpen };
}

function openCommandCenter() {
  fireEvent.click(screen.getByTestId('agent-team-presentation-command'));
}

function member(id: string, role: OfficeMemberView['role'], overrides: Partial<OfficeMemberView> = {}): OfficeMemberView {
  return { sessionId: id, title: id, role, isRoot: role === 'coordinator', provider: 'claude-code', principal: 'idle', waitingUser: null, isActiveSession: false, ...overrides };
}

function room(members: OfficeMemberView[], rootId = members[0].sessionId): OfficeRoomView {
  return {
    rootId,
    title: `Sala ${rootId}`,
    isTeamModeRoot: true,
    members,
    workingCount: members.filter((m) => m.principal === 'working' && m.waitingUser === null).length,
    waitingUserCount: members.filter((m) => m.waitingUser !== null).length,
    errorCount: members.filter((m) => m.principal === 'error').length,
  };
}

function renderView(rooms: OfficeRoomView[], onSessionOpen = vi.fn()) {
  const view = render(
    <I18nProvider>
      <CommandCenterView rooms={rooms} onSessionOpen={onSessionOpen} />
    </I18nProvider>,
  );
  return { ...view, onSessionOpen };
}

beforeEach(async () => {
  store = createStore();
  teamFlag.enabled = true;
  invoke = vi.fn(async () => ({ success: true, worktrees: {} }));
  (window as unknown as { electronAPI: unknown }).electronAPI = { invoke };
  await act(async () => {
    await setLanguage('pt-BR');
  });
});

afterEach(async () => {
  cleanup();
  await setLanguage('en');
});

describe('Command Center as a presentation of the Team view', () => {
  it('starts on the Tree and offers Tree, Office and Command Center, switching without losing the Tree', () => {
    seedTeam();
    renderBoard();
    const group = screen.getByTestId('agent-team-presentation');
    expect(within(group).getAllByRole('button').map((b) => b.getAttribute('data-testid'))).toEqual([
      'agent-team-presentation-tree',
      'agent-team-presentation-office',
      'agent-team-presentation-command',
    ]);
    expect(screen.getByTestId('agent-team-tree-lead')).toBeTruthy();
    expect(screen.queryByTestId('cc-view')).toBeNull();

    openCommandCenter();
    expect(screen.getByTestId('cc-view')).toBeTruthy();
    expect(screen.getByTestId('agent-team-presentation-command').getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByTestId('agent-team-tree-lead')).toBeNull();
    expect(screen.getByTestId('office-standalone-note').textContent).toBe('1 sessão avulsa aparece só na Árvore.');

    fireEvent.click(screen.getByTestId('agent-team-presentation-office'));
    expect(screen.getByTestId('office-view')).toBeTruthy();
    expect(screen.queryByTestId('cc-view')).toBeNull();
    fireEvent.click(screen.getByTestId('agent-team-presentation-tree'));
    expect(screen.getByTestId('agent-team-tree-lead')).toBeTruthy();
  });

  it('shows every member at a station with an agent, a desk and a screen, advisor included', () => {
    seedTeam();
    renderBoard();
    openCommandCenter();
    for (const id of ['lead', 'exp', 'impl', 'rev', 'adv']) {
      const station = screen.getByTestId(`cc-station-${id}`);
      expect(station.querySelector('.cc-agent'), `${id} agent`).not.toBeNull();
      expect(station.querySelector('.cc-agent .cc-head'), `${id} head`).not.toBeNull();
      expect(station.querySelectorAll('.cc-agent .cc-arm').length, `${id} arms`).toBe(2);
      expect(station.querySelector('.cc-desk'), `${id} desk`).not.toBeNull();
      expect(station.querySelector('.cc-monitor'), `${id} monitor`).not.toBeNull();
      expect(station.querySelector('.cc-chair'), `${id} chair`).not.toBeNull();
    }
    expect(screen.getByTestId('cc-station-lead').getAttribute('data-slot')).toBe('C');
    expect(screen.getByTestId('cc-station-adv').getAttribute('data-zone')).toBe('bay');
    expect(screen.getByTestId('cc-bay-label').textContent).toBe('Bay de revisão independente');
  });

  it('keeps the idle advisor visibly present, with its label, a seated agent and a reduced light', () => {
    seedTeam();
    renderBoard();
    openCommandCenter();
    const adv = screen.getByTestId('cc-station-adv');
    expect(adv.getAttribute('data-state')).toBe('idle');
    expect(adv.className).toContain('cc-state-idle');
    expect(adv.className).toContain('cc-role-advisor');
    expect(adv.querySelector('.cc-agent .jacket')).not.toBeNull();
    expect(within(screen.getByTestId('cc-label-adv')).getByText('Consultor')).toBeTruthy();
    expect(screen.getByTestId('cc-label-adv').textContent).toContain('Consultor Independente');
    expect(screen.getByTestId('cc-label-adv').textContent).toContain('Ociosa');
    // Standby screen, not an empty desk.
    expect(adv.querySelector('.cc-scr-standby')).not.toBeNull();
  });

  it('derives each station state from the existing atoms, live, and redraws the dynamic layers', () => {
    seedTeam();
    store.set(sessionProcessingAtom('exp'), true);
    store.set(sessionProcessingAtom('impl'), true);
    store.set(sessionHasPendingInteractivePromptAtom('impl'), true);
    store.set(sessionPendingPromptsAtom('impl'), [pending('impl', 'git_commit_proposal_request')]);
    store.set(sessionErrorAtom('rev'), { message: 'boom' });
    renderBoard();
    openCommandCenter();

    const state = (id: string) => screen.getByTestId(`cc-station-${id}`).getAttribute('data-state');
    expect(state('exp')).toBe('working');
    expect(state('impl')).toBe('waiting');
    expect(state('rev')).toBe('error');
    expect(state('adv')).toBe('idle');
    // Members working do not make the coordinator "work" or "wait".
    expect(state('lead')).toBe('idle');
    expect(screen.getByTestId('cc-station-impl').getAttribute('data-waiting-user')).toBe('commit');
    expect(screen.getByTestId('cc-callout-impl').textContent).toContain('commit para confirmar');
    expect(screen.getByTestId('cc-callout-rev').textContent).toContain('Erro não visto');
    expect(screen.queryByTestId('cc-callout-exp')).toBeNull();
    expect(screen.getByTestId('cc-room-summary').textContent).toBe('1 trabalhando · 1 aguardando você · 1 com erro não visto');

    act(() => {
      store.set(sessionProcessingAtom('exp'), false);
      store.set(sessionHasPendingInteractivePromptAtom('impl'), false);
      store.set(sessionErrorAtom('rev'), null);
      store.set(sessionProcessingAtom('lead'), true);
    });
    expect(state('exp')).toBe('idle');
    expect(state('impl')).toBe('working');
    expect(state('rev')).toBe('idle');
    expect(state('lead')).toBe('working');
    expect(screen.queryByTestId('cc-callout-impl')).toBeNull();
    expect(screen.queryByTestId('cc-callout-rev')).toBeNull();
    expect(screen.getByTestId('cc-attention-none').textContent).toContain('Nada precisa de você agora.');
  });

  it('declares every infinite animation in the stylesheet and which state may run it', () => {
    // Every `animation: ... infinite` in the sheet, keyed by the state class of its selector.
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const found = new Map<string, Set<string>>();
    let matched = 0;
    for (const [, selectorList, body] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const animation = /animation:\s*(cc-[\w-]+)[^;]*\binfinite\b/.exec(body);
      if (!animation) continue;
      matched += 1;
      for (const selector of selectorList.split(',')) {
        const scope = /\.cc-state-(working|waiting|error|idle)\b/.exec(selector)?.[1] ?? 'unscoped';
        if (!found.has(scope)) found.set(scope, new Set());
        found.get(scope)!.add(animation[1]);
      }
    }
    // Every `infinite` in the sheet must be one of the declarations matched above. A form the parser does not
    // understand (`animation: 2s infinite cc-x`, `animation-iteration-count: infinite`, an unprefixed name) leaves
    // the token count above the matched count and fails here instead of slipping past the allowlist.
    expect((text.match(/\binfinite\b/g) ?? []).length, 'infinite tokens vs allowlisted declarations').toBe(matched);
    expect(text).not.toMatch(/animation-iteration-count|animation-name/);
    expect(matched).toBeGreaterThan(10);
    const listed = Object.fromEntries([...found].map(([scope, names]) => [scope, [...names].sort()]));
    // The allowlist. Adding a loop to the stylesheet fails here until it is listed on purpose.
    expect(listed).toEqual({
      // work: typing, head scan, breathing, rack LEDs
      working: ['cc-breathe', 'cc-led', 'cc-scan', 'cc-tap'],
      // the "needs you" signal: lock brackets, beacon, blinking call card, visor and callout dot
      waiting: ['cc-beacon', 'cc-blink', 'cc-lock'],
      // the error signal: beacon, blinking alert triangle and callout dot
      error: ['cc-beacon', 'cc-blink'],
      // ambient presence only: slow breathing and an occasional glance
      idle: ['cc-breathe', 'cc-glance'],
      // classes with no state in the selector: the elements exist only where the DOM test below puts them
      unscoped: ['cc-cycle', 'cc-float', 'cc-flow', 'cc-scroll-x', 'cc-scroll-y'],
    });
    // Waiting and error never type, scan or scroll.
    expect(css).not.toMatch(/\.cc-state-(waiting|error)[^{]*\.tap\s*\{[^}]*animation/);
    expect(css).not.toMatch(/\.cc-state-(waiting|error)[^{]*\.cc-head\s*\{[^}]*animation/);
  });

  it('renders the elements of the unscoped loops only where their state allows', () => {
    seedTeam();
    store.set(sessionProcessingAtom('exp'), true);
    store.set(sessionProcessingAtom('impl'), true);
    store.set(sessionHasPendingInteractivePromptAtom('impl'), true);
    store.set(sessionErrorAtom('rev'), { message: 'x' });
    renderBoard();
    openCommandCenter();

    const count = (id: string, selector: string) => screen.getByTestId(`cc-station-${id}`).querySelectorAll(selector).length;
    const floor = () => screen.getByTestId('cc-floor-lead');
    // Scrolling screens: working station only.
    expect(screen.getByTestId('cc-station-exp').className).toContain('cc-state-working');
    expect(count('exp', '.cc-scroll-x, .cc-scroll-y')).toBeGreaterThan(0);
    for (const id of ['impl', 'rev', 'adv', 'lead']) {
      expect(screen.getByTestId(`cc-station-${id}`).className, id).not.toContain('cc-state-working');
      expect(count(id, '.cc-scroll-x, .cc-scroll-y'), `${id} scroll`).toBe(0);
    }
    // The floating callout: waiting and error stations only.
    expect(count('impl', '.cc-callout')).toBe(1);
    expect(count('rev', '.cc-callout')).toBe(1);
    for (const id of ['exp', 'adv', 'lead']) expect(count(id, '.cc-callout'), `${id} callout`).toBe(0);
    // Lane flow: one moving lane per working station, none for the others.
    expect(floor().querySelectorAll('.cc-lane').length).toBe(4);
    expect(floor().querySelectorAll('.cc-lane .flow').length).toBe(1);
    expect(floor().querySelectorAll('.cc-lane--working .flow').length).toBe(1);
    // The display cycles its focus only while the Coordinator works.
    expect(floor().querySelector('.cc-focus')).toBeNull();
    act(() => {
      store.set(sessionProcessingAtom('lead'), true);
    });
    expect(floor().querySelector('.cc-focus')).not.toBeNull();

    // When the state changes the loop goes away with it, and comes back on working.
    act(() => {
      store.set(sessionProcessingAtom('exp'), false);
      store.set(sessionErrorAtom('exp'), { message: 'x' });
    });
    expect(screen.getByTestId('cc-station-exp').className).toContain('cc-state-error');
    expect(count('exp', '.cc-scroll-x, .cc-scroll-y')).toBe(0);
    expect(count('exp', '.cc-callout')).toBe(1);
    act(() => {
      store.set(sessionErrorAtom('exp'), null);
      store.set(sessionProcessingAtom('exp'), true);
    });
    expect(count('exp', '.cc-scroll-x, .cc-scroll-y')).toBeGreaterThan(0);
    expect(count('exp', '.cc-callout')).toBe(0);
    // The work loop is tied to the working class in the stylesheet: typing, scanning.
    expect(css).toMatch(/\.cc-state-working \.cc-arm-l \.tap\s*\{[^}]*animation:\s*cc-tap/);
    expect(css).toMatch(/\.cc-state-working \.cc-head\s*\{[^}]*animation:\s*cc-scan/);
  });

  it('changes the posture of the agent with the state (waiting turns to the viewer, error is held)', () => {
    seedTeam();
    store.set(sessionHasPendingInteractivePromptAtom('impl'), true);
    store.set(sessionErrorAtom('rev'), { message: 'x' });
    renderBoard();
    openCommandCenter();
    // Both head views exist in every station; the state class decides which one shows.
    for (const id of ['impl', 'rev', 'exp']) {
      const station = screen.getByTestId(`cc-station-${id}`);
      expect(station.querySelector('.cc-hair-view')).not.toBeNull();
      expect(station.querySelector('.cc-face-view')).not.toBeNull();
    }
    expect(css).toMatch(/\.cc-state-waiting \.cc-face-view\s*\{\s*opacity:\s*1/);
    expect(css).toMatch(/\.cc-state-waiting \.cc-hair-view\s*\{\s*opacity:\s*0/);
    expect(css).toMatch(/\.cc-state-error \.cc-head\s*\{[^}]*rotate/);
    // The screen carries the state too: a call card while waiting, an alert while failing.
    expect(screen.getByTestId('cc-station-impl').querySelector('.cc-scr-call')).not.toBeNull();
    expect(screen.getByTestId('cc-station-rev').querySelector('.cc-scr-alert')).not.toBeNull();
    // The arms change their pose through a transition, not a cut.
    expect(css).toMatch(/\.cc-agent \.upper,\s*\n\.cc-agent \.lower\s*\{[^}]*transition:\s*d/);
  });

  it('keeps no motion at all for reduced-motion users', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*animation:\s*none !important/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*transition:\s*none !important/);
  });

  it('uses no animated filter, blur or blend mode', () => {
    expect(css).not.toMatch(/mix-blend-mode|backdrop-filter|filter:\s*blur|feGaussianBlur|drop-shadow/);
    // The only filter in the sheet is a static brightness on the hovered label.
    for (const line of css.split('\n').filter((l) => /\bfilter\s*:/.test(l))) expect(line).toMatch(/brightness/);
  });
});

describe('Command Center interaction', () => {
  it('highlights the whole station on hover and focus: the layers share one root the stylesheet targets', () => {
    seedTeam();
    renderBoard();
    openCommandCenter();
    const station = screen.getByTestId('cc-station-exp');
    const hit = screen.getByTestId('cc-hit-exp');
    // Floor outline, desk and monitor (lifted together), agent, label and tooltip are all inside the same root as the button.
    expect(station.contains(hit)).toBe(true);
    expect(station.querySelector('.cc-pad .hl')).not.toBeNull();
    expect(station.querySelector('.cc-lift .cc-desk')).not.toBeNull();
    expect(station.querySelector('.cc-lift .cc-monitor')).not.toBeNull();
    expect(station.querySelector('.cc-lift .cc-agent')).not.toBeNull();
    expect(station.contains(screen.getByTestId('cc-label-exp'))).toBe(true);
    expect(station.contains(screen.getByTestId('cc-tip-exp'))).toBe(true);
    for (const target of ['.cc-pad .hl', '.cc-lift', '.cc-label', '.cc-tip']) {
      const escaped = target.replace(/\./g, '\\.').replace(/ /g, '\\s');
      expect(css, `${target} on hover`).toMatch(new RegExp(`\\.cc-station:hover ${escaped}`));
      expect(css, `${target} on keyboard focus`).toMatch(new RegExp(`\\.cc-station:has\\(\\.cc-hit:focus-visible\\) ${escaped}`));
    }
    // Focus lands on the real button inside that root.
    hit.focus();
    expect(document.activeElement).toBe(hit);
    expect(station.contains(document.activeElement)).toBe(true);
  });

  it('lights a station for the keyboard and the pointer, never for a mouse click that left focus behind', () => {
    // :focus-within would keep the station lit after a mouse click; only :focus-visible follows the keyboard.
    expect(css).not.toMatch(/:focus-within/);
    expect(css.match(/\.cc-station:has\(\.cc-hit:focus-visible\)/g)?.length).toBeGreaterThanOrEqual(5);
    // The keyboard ring is a bright floor outline; the native outline would be cut by the hit area's clip-path.
    expect(css).toMatch(/\.cc-station:has\(\.cc-hit:focus-visible\) \.cc-pad \.hl\s*\{[^}]*stroke:\s*#ffffff[^}]*stroke-width:\s*3/);
    expect(css).toMatch(/\.cc-hit:focus-visible\s*\{\s*outline:\s*none;\s*\}/);
    expect(css).toMatch(/focus ring is drawn on the pad/);
  });

  it('shows name, role, state, wait kind, mission, provider/model and sessionId in the tooltip of every station', () => {
    seedTeam();
    store.set(sessionHasPendingInteractivePromptAtom('impl'), true);
    store.set(sessionPendingPromptsAtom('impl'), [pending('impl', 'git_commit_proposal_request')]);
    renderBoard();
    openCommandCenter();
    const exp = screen.getByTestId('cc-tip-exp');
    expect(exp.getAttribute('role')).toBe('tooltip');
    expect(exp.textContent).toContain('Explorer');
    expect(exp.textContent).toContain('Mapear as regras de impostos');
    expect(exp.textContent).toContain('Claude Agent');
    expect(exp.textContent).toContain('sonnet');
    expect(exp.textContent).toContain('Sessão: exp');
    const impl = screen.getByTestId('cc-tip-impl');
    expect(impl.textContent).toContain('commit para confirmar');
    expect(impl.textContent).toContain('Aguardando você');
    const adv = screen.getByTestId('cc-tip-adv');
    expect(adv.textContent).toContain('OpenAI Codex');
    expect(adv.textContent).toContain('gpt-6.1-sol');
    // The button names the station and points at its tooltip.
    const hit = screen.getByTestId('cc-hit-adv');
    expect(hit.getAttribute('aria-describedby')).toBe(adv.id);
    expect(hit.getAttribute('aria-label')).toContain('Consultor');
    expect(screen.getByTestId('cc-view').textContent).not.toMatch(RAW_KEY);
  });

  it('opens a session once per click, Enter and Space, with no other effect', () => {
    seedTeam();
    const { onSessionOpen } = renderBoard();
    openCommandCenter();
    const hit = screen.getByTestId('cc-hit-rev');
    fireEvent.mouseEnter(hit);
    fireEvent.mouseOver(hit);
    fireEvent.focus(hit);
    expect(onSessionOpen).not.toHaveBeenCalled();

    fireEvent.click(hit);
    expect(onSessionOpen).toHaveBeenCalledTimes(1);
    expect(onSessionOpen).toHaveBeenLastCalledWith('rev');

    // Keys: the keydown is the activation and its default (a synthetic click) is cancelled.
    const enter = fireEvent.keyDown(hit, { key: 'Enter' });
    expect(enter).toBe(false);
    expect(onSessionOpen).toHaveBeenCalledTimes(2);
    expect(onSessionOpen).toHaveBeenLastCalledWith('rev');

    const space = fireEvent.keyDown(hit, { key: ' ' });
    expect(space).toBe(false);
    expect(fireEvent.keyUp(hit, { key: ' ' })).toBe(false);
    expect(onSessionOpen).toHaveBeenCalledTimes(3);

    // Other keys do nothing.
    fireEvent.keyDown(hit, { key: 'a' });
    fireEvent.keyDown(hit, { key: 'Tab' });
    expect(onSessionOpen).toHaveBeenCalledTimes(3);
  });

  it('opens once when Enter or Space is held: key repeats are swallowed', () => {
    seedTeam();
    const { onSessionOpen } = renderBoard();
    openCommandCenter();
    const hit = screen.getByTestId('cc-hit-rev');
    expect(fireEvent.keyDown(hit, { key: 'Enter' })).toBe(false);
    for (let i = 0; i < 5; i++) {
      // A repeat keeps its default cancelled too, so the browser does not turn it into a click.
      expect(fireEvent.keyDown(hit, { key: 'Enter', repeat: true })).toBe(false);
    }
    expect(onSessionOpen).toHaveBeenCalledTimes(1);
    expect(fireEvent.keyDown(hit, { key: ' ' })).toBe(false);
    for (let i = 0; i < 5; i++) expect(fireEvent.keyDown(hit, { key: ' ', repeat: true })).toBe(false);
    expect(fireEvent.keyUp(hit, { key: ' ' })).toBe(false);
    expect(onSessionOpen).toHaveBeenCalledTimes(2);
    expect(onSessionOpen).toHaveBeenLastCalledWith('rev');
  });

  it('puts every station in the tab order as a real button', () => {
    seedTeam();
    renderBoard();
    openCommandCenter();
    for (const id of ['lead', 'exp', 'impl', 'rev', 'adv']) {
      const hit = screen.getByTestId(`cc-hit-${id}`);
      expect(hit.tagName).toBe('BUTTON');
      expect(hit.tabIndex).toBeGreaterThanOrEqual(0);
      hit.focus();
      expect(document.activeElement).toBe(hit);
    }
  });

  it('follows the model in the tab order (Coordinator first) while depth stays a z-index', () => {
    seedTeam();
    renderBoard();
    openCommandCenter();
    const hits = Array.from(screen.getByTestId('cc-floor-lead').querySelectorAll<HTMLElement>('button.cc-hit')).map((b) => b.dataset.testid);
    expect(hits).toEqual(['cc-hit-lead', 'cc-hit-exp', 'cc-hit-impl', 'cc-hit-rev', 'cc-hit-adv']);
    // Depth is drawn with z-index: one distinct back-to-front rank per station.
    const ranks = ['lead', 'exp', 'impl', 'rev', 'adv'].map((id) => Number((screen.getByTestId(`cc-station-${id}`) as HTMLElement).style.getPropertyValue('--cc-rank')));
    expect(new Set(ranks).size).toBe(5);
    expect(ranks.every((rank) => rank >= 1 && rank <= 5)).toBe(true);
    // The advisor sits in front of the explorer on screen, whatever the DOM order.
    expect(ranks[4]).toBeGreaterThan(ranks[1]);
    expect(css).toMatch(/\.cc-art\s*\{\s*z-index:\s*calc\(1 \+ var\(--cc-rank/);
  });

  it('keeps the model order even when the model lists the Coordinator after another member', () => {
    renderView([room([member('exp', 'explorer'), member('lead', 'coordinator'), member('rev', 'reviewer')], 'lead')]);
    const hits = Array.from(screen.getByTestId('cc-floor-lead').querySelectorAll<HTMLElement>('button.cc-hit')).map((b) => b.dataset.testid);
    expect(hits).toEqual(['cc-hit-lead', 'cc-hit-exp', 'cc-hit-rev']);
  });

  it('marks the session open in the panel on its station and keeps its state', () => {
    seedTeam();
    store.set(activeSessionIdAtom, 'rev');
    store.set(sessionProcessingAtom('rev'), true);
    renderBoard();
    openCommandCenter();
    const station = screen.getByTestId('cc-station-rev');
    expect(station.getAttribute('data-active-session')).toBe('true');
    expect(station.className).toContain('is-active');
    expect(screen.getByTestId('cc-hit-rev').getAttribute('aria-current')).toBe('true');
    expect(station.getAttribute('data-state')).toBe('working');
    expect(screen.getByTestId('cc-station-exp').getAttribute('data-active-session')).toBeNull();
  });

  it('keeps the "needs you" strip: session, room, wait kind or unseen error, and opens on click', () => {
    seedTeam();
    store.set(sessionHasPendingInteractivePromptAtom('impl'), true);
    store.set(sessionPendingPromptsAtom('impl'), [pending('impl', 'permission_request')]);
    store.set(sessionErrorAtom('adv'), { message: 'x' });
    const { onSessionOpen } = renderBoard();
    openCommandCenter();
    const attention = screen.getByTestId('cc-attention');
    expect(attention.textContent).toContain('Precisa de você (2)');
    expect(within(attention).getByTestId('cc-attention-impl').textContent).toContain('pedido de permissão');
    // The second column is the member's role, not the team name.
    expect(within(attention).getByTestId('cc-needs-role-impl').textContent).toBe('· Implementer');
    expect(within(attention).getByTestId('cc-attention-impl').textContent).not.toContain('Coordenação');
    expect(within(attention).getByTestId('cc-needs-role-adv').textContent).toBe('· Consultor Independente');
    expect(within(attention).getByTestId('cc-attention-adv').textContent).toContain('Erro não visto');
    fireEvent.click(within(attention).getByTestId('cc-attention-impl'));
    expect(onSessionOpen).toHaveBeenCalledTimes(1);
    expect(onSessionOpen).toHaveBeenLastCalledWith('impl');
  });

  it('adds no IPC and no operational control: only buttons that open a session', async () => {
    seedTeam();
    store.set(sessionHasPendingInteractivePromptAtom('impl'), true);
    renderBoard();
    const callsBefore = invoke.mock.calls.length;
    openCommandCenter();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    for (const [channel] of invoke.mock.calls) expect(channel).toBe('worktree:get-batch');
    expect(invoke.mock.calls.length).toBe(callsBefore);
    const view = screen.getByTestId('cc-view');
    expect(view.querySelector('iframe, webview, object, embed, form, input, textarea, select')).toBeNull();
    const hits = view.querySelectorAll('[data-testid^="cc-hit-"]');
    const attention = view.querySelectorAll('[data-testid^="cc-attention-"]:not([data-testid="cc-attention-none"])');
    expect(hits.length).toBe(5);
    expect(attention.length).toBe(1);
    expect(view.querySelectorAll('button').length).toBe(hits.length + attention.length);
  });
});

describe('Command Center mission at rest and tooltip dismissal', () => {
  const FULL = 'Mapear as regras de cálculo de impostos no módulo legado e relatar casos limite sem cobertura de teste.';

  it('shows the mission of a station at rest, without hover, and keeps the full text in the tooltip', () => {
    renderView([room([member('lead', 'coordinator'), member('exp', 'explorer', { mission: FULL })])]);
    const mission = screen.getByTestId('cc-mission-exp');
    // At rest and in the label: not inside the tooltip, which only opens on hover or focus.
    expect(screen.getByTestId('cc-label-exp').contains(mission)).toBe(true);
    expect(screen.getByTestId('cc-tip-exp').contains(mission)).toBe(false);
    expect(mission.textContent).toBe(FULL);
    // Visual truncation is the stylesheet's (one line, ellipsis); the tooltip carries the same full text.
    expect(css).toMatch(/\.cc-label \.mission\s*\{[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/);
    expect(css).not.toMatch(/\.cc-label \.mission\s*\{[^}]*white-space:\s*normal/);
    expect(within(screen.getByTestId('cc-tip-exp')).getByText(FULL)).toBeTruthy();
  });

  it('shows a mission line only for a member that has a mission, and invents none from the title', () => {
    renderView([
      room([
        member('lead', 'coordinator', { title: 'Coordenar a migração inteira' }),
        member('exp', 'explorer', { title: 'Mapear impostos' }),
        member('blank', 'reviewer', { mission: '   ' }),
        member('impl', 'implementer', { mission: '  Portar descontos  ' }),
      ]),
    ]);
    for (const id of ['lead', 'exp', 'blank']) {
      expect(screen.queryByTestId(`cc-mission-${id}`), `${id} has no mission`).toBeNull();
      expect(screen.getByTestId(`cc-label-${id}`).querySelector('.mission')).toBeNull();
    }
    // Title text appears once, as the name, never repeated as a mission.
    expect(screen.getByTestId('cc-label-exp').textContent?.match(/Mapear impostos/g)).toHaveLength(1);
    // A blank mission shows no line and no mission block in the tooltip; a real one is trimmed.
    expect(screen.getByTestId('cc-tip-blank').textContent).not.toContain('Missão');
    expect(screen.getByTestId('cc-mission-impl').textContent).toBe('Portar descontos');
  });

  it('does not let the mission change the visual state of a station', () => {
    const state = (rooms: OfficeRoomView[]) => {
      renderView(rooms);
      const out = ['lead', 'exp', 'impl', 'rev'].map((id) => screen.getByTestId(`cc-station-${id}`).getAttribute('data-state'));
      cleanup();
      return out;
    };
    const build = (mission?: string) =>
      room([
        member('lead', 'coordinator'),
        member('exp', 'explorer', { principal: 'working', mission }),
        member('impl', 'implementer', { waitingUser: ['commit'], mission }),
        member('rev', 'reviewer', { principal: 'error', mission }),
      ]);
    const without = state([build()]);
    expect(without).toEqual(['idle', 'working', 'waiting', 'error']);
    // A mission that talks about errors, waiting and work changes nothing.
    expect(state([build('ERRO: aguardando você, trabalhando, bloqueado')])).toEqual(without);
    expect(state([build(FULL)])).toEqual(without);
  });

  it('closes the tooltip of the focused station with Escape, keeps focus, and shows it again on leave or blur', () => {
    seedTeam();
    const { onSessionOpen } = renderBoard();
    openCommandCenter();
    const station = screen.getByTestId('cc-station-exp');
    const hit = screen.getByTestId('cc-hit-exp');
    hit.focus();
    expect(station.className).not.toContain('is-dismissed');

    fireEvent.keyDown(hit, { key: 'Escape' });
    expect(station.className).toContain('is-dismissed');
    // Focus stays on the station, the tooltip stays in the tree (the stylesheet hides it), nothing opens.
    expect(document.activeElement).toBe(hit);
    expect(screen.getByTestId('cc-tip-exp')).toBeTruthy();
    expect(onSessionOpen).not.toHaveBeenCalled();
    // Other stations are not affected.
    expect(screen.getByTestId('cc-station-impl').className).not.toContain('is-dismissed');

    // The pointer leaving or entering, and focus moving away, bring it back.
    fireEvent.mouseLeave(station);
    expect(station.className).not.toContain('is-dismissed');
    fireEvent.keyDown(hit, { key: 'Escape' });
    expect(station.className).toContain('is-dismissed');
    fireEvent.mouseEnter(station);
    expect(station.className).not.toContain('is-dismissed');
    fireEvent.keyDown(hit, { key: 'Escape' });
    fireEvent.blur(hit);
    expect(station.className).not.toContain('is-dismissed');
    // Enter still opens the session after an Escape.
    fireEvent.keyDown(hit, { key: 'Escape' });
    fireEvent.keyDown(hit, { key: 'Enter' });
    expect(onSessionOpen).toHaveBeenCalledTimes(1);
  });

  it('hides a dismissed tooltip whatever opened it: the rule outranks hover and keyboard focus', () => {
    expect(css).toMatch(/\.cc-station\.is-dismissed \.cc-tip,\s*\n\.cc-station\.is-dismissed:hover \.cc-tip,\s*\n\.cc-station\.is-dismissed:has\(\.cc-hit:focus-visible\) \.cc-tip\s*\{\s*opacity:\s*0;/);
    // It comes after the rules that show the tooltip, so equal-or-lower specificity cannot win.
    expect(css.indexOf('.cc-station.is-dismissed .cc-tip')).toBeGreaterThan(css.indexOf('.cc-station:has(.cc-hit:focus-visible) .cc-tip'));
  });
});

describe('Command Center layout for real teams', () => {
  it('draws one room per team and keeps the same ids apart', () => {
    renderView([
      room([member('a-lead', 'coordinator'), member('a-exp', 'explorer', { principal: 'working' })]),
      room([member('b-lead', 'coordinator'), member('b-rev', 'reviewer', { principal: 'error' })]),
    ]);
    expect(screen.getAllByTestId(/^cc-room-(?!summary)/)).toHaveLength(2);
    expect(screen.getByTestId('cc-station-a-exp').getAttribute('data-state')).toBe('working');
    expect(screen.getByTestId('cc-station-b-rev').getAttribute('data-state')).toBe('error');
    expect(screen.getByTestId('cc-attention-b-rev').textContent).toContain('Sala b-lead');
  });

  it('seats eight members, repeated roles included, without losing any', () => {
    const members = [
      member('lead', 'coordinator'),
      member('e1', 'explorer'), member('e2', 'explorer'), member('arch', 'architect'),
      member('i1', 'implementer'), member('i2', 'implementer'),
      member('rev', 'reviewer'), member('adv', 'advisor', { provider: 'openai-codex' }),
    ];
    renderView([room(members)]);
    for (const m of members) expect(screen.getByTestId(`cc-hit-${m.sessionId}`)).toBeTruthy();
    expect(new Set(members.map((m) => screen.getByTestId(`cc-station-${m.sessionId}`).getAttribute('data-slot'))).size).toBe(8);
    expect(screen.queryByTestId('cc-overflow')).toBeNull();
  });

  it('lists members that do not fit the floor as reachable chips', () => {
    const members = [member('lead', 'coordinator'), ...Array.from({ length: 9 }, (_, i) => member(`m${i}`, 'other', { principal: i === 8 ? 'error' : 'idle' }))];
    const { onSessionOpen } = renderView([room(members)]);
    const overflow = screen.getByTestId('cc-overflow');
    expect(within(overflow).getAllByRole('button').map((b) => b.textContent)).toEqual(['m7', 'm8']);
    fireEvent.click(screen.getByTestId('cc-overflow-m8'));
    expect(onSessionOpen).toHaveBeenCalledWith('m8');
    expect(screen.getByTestId('cc-overflow-m8').getAttribute('data-state')).toBe('error');
  });

  it('draws no bay until an advisor exists, and a bay with glass when one does', () => {
    const { rerender, container } = renderView([room([member('lead', 'coordinator'), member('e', 'explorer')])]);
    expect(screen.queryByTestId('cc-bay-label')).toBeNull();
    expect(container.querySelector('.cc-bay')).toBeNull();
    rerender(
      <I18nProvider>
        <CommandCenterView rooms={[room([member('lead', 'coordinator'), member('adv', 'advisor')])]} onSessionOpen={() => {}} />
      </I18nProvider>,
    );
    expect(container.querySelector('.cc-bay .pane')).not.toBeNull();
    expect(screen.getByTestId('cc-bay-label')).toBeTruthy();
  });

  it('gives every clipPath, gradient and tooltip a distinct id, even for session ids that differ only in punctuation', () => {
    renderView([
      room([member('lead', 'coordinator'), member('a:b', 'explorer'), member('ab', 'explorer'), member('a-b', 'implementer'), member('a_b', 'reviewer')]),
      room([member('x:y', 'coordinator'), member('xy', 'explorer')], 'x:y'),
    ]);
    const ids = Array.from(document.querySelectorAll('[id]')).map((el) => el.id);
    expect(ids.length).toBeGreaterThan(20);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    // Every clip-path reference resolves to exactly one clipPath.
    const refs = Array.from(document.querySelectorAll('[clip-path]')).map((el) => /url\(#([^)]+)\)/.exec(el.getAttribute('clip-path') ?? '')?.[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(document.querySelectorAll(`clipPath[id="${ref}"]`), String(ref)).toHaveLength(1);
    // The two rooms keep separate display clips although their root ids differ by one colon.
    expect(document.querySelectorAll('clipPath[id^="cc-display-"]')).toHaveLength(2);
  });

  it('keeps the idle state colour and the tooltip captions at 4.5:1 or better on the dark scene', () => {
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (fg: string, bg: string) => {
      const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
      return (hi + 0.05) / (lo + 0.05);
    };
    const colour = (pattern: RegExp) => {
      const match = pattern.exec(css);
      expect(match, String(pattern)).not.toBeNull();
      return match![1];
    };
    // Lightest backgrounds the text can sit on: the floor, the walls and the top of the tooltip.
    const backgrounds = ['#131c29', '#1a2431', '#101621'];
    const checks: Array<[string, string]> = [
      ['idle state', colour(/--cc-idle:\s*(#[0-9a-f]{6})/i)],
      ['tooltip caption (.k)', colour(/\.cc-tip \.k\s*\{[^}]*color:\s*(#[0-9a-f]{6})/i)],
      ['tooltip role', colour(/\.cc-tip \.role\s*\{[^}]*color:\s*(#[0-9a-f]{6})/i)],
      ['tooltip meta', colour(/\.cc-tip \.meta\s*\{[^}]*color:\s*(#[0-9a-f]{6})/i)],
    ];
    for (const [name, fg] of checks) for (const bg of backgrounds) expect(contrast(fg, bg), `${name} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  it('seats two advisors in the bay, each with its own labelled station', () => {
    renderView([room([member('lead', 'coordinator'), member('a1', 'advisor'), member('a2', 'advisor')])]);
    expect(screen.getByTestId('cc-station-a1').getAttribute('data-slot')).toBe('A1');
    expect(screen.getByTestId('cc-station-a2').getAttribute('data-slot')).toBe('A2');
    expect(screen.getByTestId('cc-label-a1')).toBeTruthy();
    expect(screen.getByTestId('cc-label-a2')).toBeTruthy();
    expect(screen.getByTestId('cc-bay-label')).toBeTruthy();
  });

  it('renders the English copy with no raw keys', async () => {
    await act(async () => {
      await setLanguage('en');
    });
    renderView([room([member('lead', 'coordinator'), member('rev', 'reviewer', { principal: 'error' })])]);
    const text = screen.getByTestId('cc-view').textContent ?? '';
    expect(text).toContain('Needs you');
    expect(text).not.toMatch(RAW_KEY);
  });

  it('shows the empty-teams hint when there is no team', () => {
    store.set(sessionRegistryAtom, new Map([['solo', session('solo')]]));
    renderBoard();
    openCommandCenter();
    expect(screen.getByTestId('cc-empty').textContent).toContain('Nenhuma equipe ainda');
  });
});
