/**
 * The host's stored-manifest notice (promptOrigin `tool_manifest`) renders as a
 * Tool Manifest card in the coordinator's transcript: id, status, confidence,
 * architect, what it supersedes, and "Open manifest", which opens the stored
 * tracker item through the app's existing Tracker navigation. The card reads
 * through the session's host and follows Tracker changes; it writes nothing.
 * Where there is no such host, or the text is not a notice, nothing is invented.
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Provider as JotaiProvider } from 'jotai';
import type { TranscriptViewMessage } from '../../../../ai/server/transcript/TranscriptProjector';
import { store } from '../../../../store/store';
import { setInteractiveWidgetHost } from '../../../../store/atoms/interactiveWidgetHost';
import { I18nProvider } from '../../../../i18n/react';
import { setLanguage } from '../../../../i18n';
import type { InteractiveWidgetHost, ToolManifestCardData, TrackerItemsChange } from '../CustomToolWidgets/InteractiveWidgetHost';
import { RichTranscriptView } from '../RichTranscriptView';

vi.mock('virtua', async () => {
  const ReactModule = await import('react');
  return {
    VList: ReactModule.forwardRef(({ children }: { children: React.ReactNode }, ref) => {
      ReactModule.useImperativeHandle(ref, () => ({
        cache: undefined,
        scrollOffset: 0,
        scrollSize: 300,
        viewportSize: 100,
        findItemIndex: () => 0,
        scrollToIndex: vi.fn(),
        scrollBy: vi.fn(),
      }));
      return <div data-testid="mock-vlist">{ReactModule.Children.toArray(children)}</div>;
    }),
  };
});

const ROOT = 'team-root';

const PT_NOTICE_M2 = '[Tool Manifest] M-2 do architect (sessão arch-1) foi gravado como item NIM.14 do Tracker (confiança: alta). É o manifesto do relatório do architect, não um novo: não o releia agora. Ao declarar per manifest M-2, marque o item como accepted com tracker_update (só o status); uma divergência vira Team Note, nunca edição do item. Depois, tracker_get NIM.14 o devolve. Ele substitui M-1 (NIM.9), agora marcado como superseded: M-2 é o manifesto atual.';
const EN_NOTICE_M1 = '[Tool Manifest] M-1 from the architect (session arch-1) is stored as tracker item NIM.9 (confidence: medium). It is the manifest in the architect\'s report, not a new one: do not re-read it now.';

const M2: ToolManifestCardData = {
  itemId: 'tmf-2', manifestId: 'M-2', status: 'draft', confidence: 'high',
  architectSessionId: 'arch-1', architectTitle: 'Arquiteto ECC', supersedes: ['M-1'],
};

function makeMessage(index: number, overrides: Partial<TranscriptViewMessage>): TranscriptViewMessage {
  return {
    id: index + 1,
    sequence: index + 1,
    createdAt: new Date(1_784_648_445_000 + index),
    type: 'assistant_message',
    subagentId: null,
    ...overrides,
  };
}

const manifestNotice = (index: number, text: string) => makeMessage(index, {
  type: 'system_message',
  text,
  systemMessage: { systemType: 'status', reminderKind: 'tool_manifest' },
});

/** What the architect's report looks like when the host could not store it (Phase 1A.1): no notice, no card. */
const tooLongUpdate = (index: number) => makeMessage(index, {
  type: 'user_message', promptActor: 'agent',
  text: '[Child Session Update]\nSession: "Arquiteto"\n\nMANIFEST TOO LONG: 9,120 characters (limit 7,500); YAML kept whole, Markdown dropped.\n```yaml\ntoolManifest: 1\nid: M-3\n```',
});
const invalidUpdate = (index: number) => makeMessage(index, {
  type: 'user_message', promptActor: 'agent',
  text: '[Child Session Update]\nSession: "Arquiteto"\n\nMANIFEST INVALID: id must match M-<n>; task is required.',
});

function view(messages: TranscriptViewMessage[]) {
  return (
    <JotaiProvider store={store}>
      <I18nProvider>
        <RichTranscriptView sessionId={ROOT} sessionStatus="idle" messages={messages}
          provider="claude-code" persistScrollState={false} />
      </I18nProvider>
    </JotaiProvider>
  );
}

let resolveToolManifest: ReturnType<typeof vi.fn<(root: string, id: string) => Promise<ToolManifestCardData | null>>>;
let unsubscribe: ReturnType<typeof vi.fn<() => void>>;
let trackerListeners: Array<(change: TrackerItemsChange | undefined) => void>;
let onTrackerItemsChanged: ReturnType<typeof vi.fn<(listener: (change: TrackerItemsChange | undefined) => void) => () => void>>;

async function renderIn(language: 'en' | 'pt-BR', messages: TranscriptViewMessage[], host: Partial<InteractiveWidgetHost> | null = { resolveToolManifest, onTrackerItemsChanged }) {
  await act(async () => {
    await setLanguage(language);
  });
  setInteractiveWidgetHost(ROOT, host as unknown as InteractiveWidgetHost | null);
  const utils = render(view(messages));
  // The card resolves its item through the host after mount.
  await act(async () => {
    await Promise.resolve();
  });
  return utils;
}

const cards = () => screen.queryAllByTestId('tool-manifest-card');

beforeEach(() => {
  resolveToolManifest = vi.fn<(root: string, id: string) => Promise<ToolManifestCardData | null>>().mockResolvedValue(M2);
  unsubscribe = vi.fn();
  trackerListeners = [];
  onTrackerItemsChanged = vi.fn((listener: (change: TrackerItemsChange | undefined) => void) => {
    trackerListeners.push(listener);
    return unsubscribe;
  });
  vi.stubGlobal('CSS', { highlights: { delete: vi.fn(), set: vi.fn() } });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
});

afterEach(async () => {
  cleanup();
  setInteractiveWidgetHost(ROOT, null);
  vi.unstubAllGlobals();
  await setLanguage('en');
});

describe('the stored-manifest notice renders as a Tool Manifest card', () => {
  it('shows the manifest the notice names: id, status, confidence, architect, what it supersedes, in pt-BR', async () => {
    await renderIn('pt-BR', [makeMessage(0, { type: 'user_message', text: 'Prepare com o ECC Architect' }), manifestNotice(1, PT_NOTICE_M2), makeMessage(2, { text: 'Team plan: TEAM — per manifest M-2' })]);
    expect(cards()).toHaveLength(1);
    const card = cards()[0];
    expect(card.getAttribute('data-manifest-id')).toBe('M-2');
    expect(card.getAttribute('data-state')).toBe('draft');
    expect(screen.getByTestId('tool-manifest-title').textContent).toBe('Tool Manifest M-2');
    expect(screen.getByTestId('tool-manifest-status').textContent).toBe('Rascunho');
    expect(screen.getByTestId('tool-manifest-confidence').textContent).toBe('Confiança: alta');
    expect(screen.getByTestId('tool-manifest-architect').textContent).toBe('Arquiteto: Arquiteto ECC');
    expect(screen.getByTestId('tool-manifest-supersedes').textContent).toBe('Substitui M-1');
    expect(screen.getByTestId('tool-manifest-open').textContent).toBe('Abrir manifesto');
    // It asked the host for this root's M-2, and for nothing else.
    expect(resolveToolManifest.mock.calls).toEqual([[ROOT, 'M-2']]);
    // Only the user's own message says "You": the notice is not shown as one. The YAML is not in the card.
    expect(screen.getAllByText('You')).toHaveLength(1);
    expect(card.textContent).not.toContain('toolManifest: 1');
    // The plain notice is still there, behind "Detalhes".
    expect(screen.queryByTestId('tool-manifest-notice')).toBeNull();
    fireEvent.click(screen.getByTestId('tool-manifest-details'));
    expect(screen.getByTestId('tool-manifest-notice').textContent).toContain('foi gravado como item NIM.14');
    expect(screen.getByTestId('tool-manifest-details').getAttribute('aria-expanded')).toBe('true');
  });

  it('speaks English in English', async () => {
    resolveToolManifest.mockResolvedValue({ ...M2, manifestId: 'M-1', itemId: 'tmf-1', confidence: 'medium', supersedes: [], architectTitle: null, architectSessionId: 'arch-1-session-id' });
    await renderIn('en', [manifestNotice(0, EN_NOTICE_M1)]);
    expect(screen.getByTestId('tool-manifest-title').textContent).toBe('Tool Manifest M-1');
    expect(screen.getByTestId('tool-manifest-status').textContent).toBe('Draft');
    expect(screen.getByTestId('tool-manifest-confidence').textContent).toBe('Confidence: medium');
    // Without a title the architect is named by the short session id, never the whole one.
    expect(screen.getByTestId('tool-manifest-architect').textContent).toBe('Architect: arch-1-s');
    expect(screen.queryByTestId('tool-manifest-supersedes')).toBeNull();
    expect(screen.getByTestId('tool-manifest-open').textContent).toBe('Open manifest');
  });

  it('"Abrir manifesto" opens the stored tracker item through the app\'s Tracker navigation', async () => {
    const navigated = vi.fn();
    window.addEventListener('nimbalyst:navigate-tracker-item', navigated);
    try {
      await renderIn('pt-BR', [manifestNotice(0, PT_NOTICE_M2)]);
      const open = screen.getByTestId('tool-manifest-open') as HTMLButtonElement;
      expect(open.disabled).toBe(false);
      fireEvent.click(open);
      expect(navigated).toHaveBeenCalledTimes(1);
      expect((navigated.mock.calls[0][0] as CustomEvent).detail).toEqual({ itemId: 'tmf-2' });
    } finally {
      window.removeEventListener('nimbalyst:navigate-tracker-item', navigated);
    }
  });

  it('shows a superseded manifest as superseded, and an accepted one as accepted', async () => {
    resolveToolManifest.mockResolvedValueOnce({ ...M2, status: 'superseded' });
    await renderIn('pt-BR', [manifestNotice(0, PT_NOTICE_M2)]);
    expect(screen.getByTestId('tool-manifest-status').textContent).toBe('Substituído');
    expect(cards()[0].getAttribute('data-state')).toBe('superseded');

    // The coordinator accepts it (tracker_update, status only): the Tracker
    // reports the change and the card follows, without a reload of the transcript.
    expect(trackerListeners).toHaveLength(1);
    resolveToolManifest.mockResolvedValueOnce({ ...M2, status: 'accepted' });
    await act(async () => {
      trackerListeners[0]({ updated: [{ id: 'tmf-2', type: 'tool-manifest', status: 'accepted' }] });
      await Promise.resolve();
    });
    expect(screen.getByTestId('tool-manifest-status').textContent).toBe('Aceito');
    expect(cards()[0].getAttribute('data-state')).toBe('accepted');
    expect(resolveToolManifest).toHaveBeenCalledTimes(2);

    // A change to something else is not a reason to ask again.
    await act(async () => {
      trackerListeners[0]({ updated: [{ id: 'task-9', type: 'task', status: 'done' }] });
      await Promise.resolve();
    });
    expect(resolveToolManifest).toHaveBeenCalledTimes(2);
  });

  it('stops following the Tracker when it leaves', async () => {
    const { unmount } = await renderIn('pt-BR', [manifestNotice(0, PT_NOTICE_M2)]);
    expect(unsubscribe).not.toHaveBeenCalled();
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('two notices are two cards, each for its own manifest', async () => {
    resolveToolManifest.mockImplementation(async (_root, id) => (id === 'M-1'
      ? { ...M2, itemId: 'tmf-1', manifestId: 'M-1', status: 'superseded', confidence: 'medium', supersedes: [] }
      : M2));
    await renderIn('pt-BR', [manifestNotice(0, EN_NOTICE_M1), makeMessage(1, { text: 'Pedi o M-2 ao mesmo arquiteto.' }), manifestNotice(2, PT_NOTICE_M2)]);
    expect(cards().map((card) => [card.getAttribute('data-manifest-id'), card.getAttribute('data-state')])).toEqual([['M-1', 'superseded'], ['M-2', 'draft']]);
  });
});

describe('nothing is invented', () => {
  it('a TOO LONG or INVALID manifest has no notice and gets no card; the 1A.1 text stays where it is', async () => {
    await renderIn('pt-BR', [tooLongUpdate(0), makeMessage(1, { text: 'Pedi a reemissão compactada como M-4.' }), invalidUpdate(2)]);
    expect(cards()).toHaveLength(0);
    expect(resolveToolManifest).not.toHaveBeenCalled();
    expect(screen.getByText(/MANIFEST TOO LONG/)).toBeTruthy();
    expect(screen.getByText(/MANIFEST INVALID/)).toBeTruthy();
  });

  it('a notice whose item the Tracker no longer has says so instead of showing a manifest', async () => {
    resolveToolManifest.mockResolvedValue(null);
    await renderIn('pt-BR', [manifestNotice(0, PT_NOTICE_M2)]);
    expect(cards()).toHaveLength(1);
    expect(cards()[0].getAttribute('data-state')).toBe('missing');
    expect(screen.getByTestId('tool-manifest-missing').textContent).toBe('O manifesto gravado não está no Tracker desta área de trabalho.');
    expect(screen.queryByTestId('tool-manifest-status')).toBeNull();
    expect((screen.getByTestId('tool-manifest-open') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a host that fails to read the Tracker gets the plain notice, never "not found"', async () => {
    resolveToolManifest.mockRejectedValue(new Error('ipc down'));
    await renderIn('pt-BR', [manifestNotice(0, PT_NOTICE_M2)]);
    expect(cards()).toHaveLength(0);
    expect(screen.queryByTestId('tool-manifest-missing')).toBeNull();
    expect(screen.getByTestId('system-reminder-card').getAttribute('data-reminder-kind')).toBe('tool_manifest');
  });

  it('a late answer never overwrites a newer one (reviewer case: draft arriving after accepted)', async () => {
    const pending: Array<{ resolve: (data: ToolManifestCardData | null) => void }> = [];
    resolveToolManifest.mockImplementation(() => new Promise<ToolManifestCardData | null>((resolve) => { pending.push({ resolve }); }));
    await renderIn('pt-BR', [manifestNotice(0, PT_NOTICE_M2)]);
    expect(pending).toHaveLength(1);
    // The Tracker changes before the first read answered: a second read starts.
    await act(async () => {
      trackerListeners[0]({ updated: [{ id: 'tmf-2', type: 'tool-manifest', status: 'accepted' }] });
      await Promise.resolve();
    });
    expect(pending).toHaveLength(2);
    await act(async () => {
      pending[1].resolve({ ...M2, status: 'accepted' });
      await Promise.resolve();
    });
    expect(screen.getByTestId('tool-manifest-status').textContent).toBe('Aceito');
    // The first, older read answers last with the stale state: dropped.
    await act(async () => {
      pending[0].resolve({ ...M2, status: 'draft' });
      await Promise.resolve();
    });
    expect(screen.getByTestId('tool-manifest-status').textContent).toBe('Aceito');
    expect(cards()[0].getAttribute('data-state')).toBe('accepted');
  });

  it('on a host that cannot read the Tracker the notice stays the plain system status line', async () => {
    await renderIn('pt-BR', [manifestNotice(0, PT_NOTICE_M2)], {});
    expect(cards()).toHaveLength(0);
    const notice = screen.getByTestId('system-reminder-card');
    expect(notice.getAttribute('data-reminder-kind')).toBe('tool_manifest');
    expect(notice.textContent).toContain('Tool Manifest gravado');
    expect(screen.queryByText('You')).toBeNull();
  });

  it('other system notices and ordinary messages render exactly as before', async () => {
    await renderIn('pt-BR', [
      makeMessage(0, { type: 'user_message', text: 'Oi' }),
      makeMessage(1, { text: 'Olá! Em que posso ajudar?' }),
      makeMessage(2, { type: 'system_message', text: '[Checkpoint da equipe] O usuário autorizou a continuação.', systemMessage: { systemType: 'status', reminderKind: 'team_checkpoint' } }),
    ]);
    expect(cards()).toHaveLength(0);
    expect(resolveToolManifest).not.toHaveBeenCalled();
    expect(onTrackerItemsChanged).not.toHaveBeenCalled();
    expect(screen.getByTestId('system-reminder-card').getAttribute('data-reminder-kind')).toBe('team_checkpoint');
    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.getByText('Olá! Em que posso ajudar?')).toBeTruthy();
  });
});
