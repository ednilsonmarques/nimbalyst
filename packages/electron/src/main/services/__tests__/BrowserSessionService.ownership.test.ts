// @vitest-environment node
/**
 * Portal F0 -- per-session ownership and the in-view guards of
 * BrowserSessionService. Drives the real service against a fake Electron
 * (WebContentsView, session) so no app launch is needed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => (await import('./helpers/fakeElectronBrowser')).createElectronMock());
vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } },
}));
vi.mock('../../protocols/nimPreviewProtocol', () => ({
  ensureNimPreviewProtocolForSession: vi.fn(),
}));

import { BrowserSessionService } from '../BrowserSessionService';
import { fakeState } from './helpers/fakeElectronBrowser';

const AGENT_A = 'ai-session-A';
const AGENT_B = 'ai-session-B';
const EDITOR_ID = 'browser:doc.html:1111';

function service(): BrowserSessionService {
  return BrowserSessionService.getInstance();
}

function openAgentSession(id: string, owner: string): void {
  service().createSession({ sessionId: id, url: 'https://example.com', headless: true, ownerSessionId: owner });
}

function openEditorSession(id = EDITOR_ID): void {
  service().createSession({ sessionId: id, url: 'about:blank' });
}

function viewOf(index: number) {
  return fakeState.views[index];
}

beforeEach(() => {
  BrowserSessionService.__resetForTests();
  fakeState.reset();
});

describe('session ownership', () => {
  it('records the owning AI session, and no owner for editor sessions', () => {
    openAgentSession('agent-browser:a1', AGENT_A);
    openEditorSession();
    expect(service().getOwner('agent-browser:a1')).toBe(AGENT_A);
    expect(service().getOwner(EDITOR_ID)).toBeNull();
  });

  it('lets an agent act only on a session it owns', () => {
    openAgentSession('agent-browser:a1', AGENT_A);
    expect(() => service().assertAccess('agent-browser:a1', AGENT_A)).not.toThrow();
    expect(() => service().assertAccess('agent-browser:a1', AGENT_B)).toThrow(/No browser session/);
  });

  it("never lets an agent act on the user's editor session", () => {
    openEditorSession();
    expect(() => service().assertAccess(EDITOR_ID, AGENT_A)).toThrow(/No browser session/);
  });

  it('answers a foreign session exactly like a missing one (no existence leak)', () => {
    openAgentSession('agent-browser:a1', AGENT_A);
    let foreign = '';
    let missing = '';
    try { service().assertAccess('agent-browser:a1', AGENT_B); } catch (e) { foreign = (e as Error).message.replace('agent-browser:a1', 'ID'); }
    try { service().assertAccess('agent-browser:nope', AGENT_B); } catch (e) { missing = (e as Error).message.replace('agent-browser:nope', 'ID'); }
    expect(foreign).toBe(missing);
    expect(foreign).not.toBe('');
  });

  it("keeps the user's own UI in full control of every session", () => {
    openAgentSession('agent-browser:a1', AGENT_A);
    openEditorSession();
    expect(() => service().assertAccess('agent-browser:a1', undefined)).not.toThrow();
    expect(() => service().assertAccess(EDITOR_ID, undefined)).not.toThrow();
  });

  it('lists only the sessions the calling agent owns', () => {
    openAgentSession('agent-browser:a1', AGENT_A);
    openAgentSession('agent-browser:b1', AGENT_B);
    openEditorSession();
    expect(service().listSessions(AGENT_B)).toEqual(['agent-browser:b1']);
    expect(service().listSessions(AGENT_A)).toEqual(['agent-browser:a1']);
    expect(service().listSessions('ai-session-nobody')).toEqual([]);
    expect(service().listSessions().sort()).toEqual(['agent-browser:a1', 'agent-browser:b1', EDITOR_ID].sort());
  });

  it("refuses to let an agent re-open or take over another owner's session id", () => {
    openAgentSession('agent-browser:a1', AGENT_A);
    openEditorSession();
    expect(() =>
      service().createSession({ sessionId: 'agent-browser:a1', url: 'https://example.com', headless: true, ownerSessionId: AGENT_B }),
    ).toThrow();
    expect(() =>
      service().createSession({ sessionId: EDITOR_ID, url: 'about:blank', ownerSessionId: AGENT_B }),
    ).toThrow();
    expect(service().getOwner('agent-browser:a1')).toBe(AGENT_A);
    expect(service().getOwner(EDITOR_ID)).toBeNull();
  });

  it('keeps the agent id namespace apart from editor ids so an agent cannot squat a future editor id', () => {
    expect(() =>
      service().createSession({ sessionId: 'browser-virtual:tab-9', url: 'about:blank', ownerSessionId: AGENT_A }),
    ).toThrow(/agent-/);
    expect(service().hasSession('browser-virtual:tab-9')).toBe(false);
  });
});

describe('page-initiated navigation guard (will-navigate / will-redirect)', () => {
  const blocked = ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,<b>x</b>', 'chrome://gpu', 'blob:https://x/abc', 'nimbalyst://open?x=1'];
  const allowed = ['https://example.com/a', 'http://localhost:3000/', 'nim-preview://abcd/index.html', 'about:blank'];

  it.each(['will-navigate', 'will-redirect'])('%s: blocks schemes outside the allow-list', (eventName) => {
    openAgentSession('agent-browser:a1', AGENT_A);
    for (const url of blocked) {
      const event = { url, preventDefault: vi.fn() };
      viewOf(0).webContents.emit(eventName, event, url);
      expect(event.preventDefault, `${eventName} ${url}`).toHaveBeenCalled();
    }
  });

  it.each(['will-navigate', 'will-redirect'])('%s: lets allowed schemes through', (eventName) => {
    openAgentSession('agent-browser:a1', AGENT_A);
    for (const url of allowed) {
      const event = { url, preventDefault: vi.fn() };
      viewOf(0).webContents.emit(eventName, event, url);
      expect(event.preventDefault, `${eventName} ${url}`).not.toHaveBeenCalled();
    }
  });

  it('also guards the user-owned editor view', () => {
    openEditorSession();
    const event = { url: 'file:///etc/passwd', preventDefault: vi.fn() };
    viewOf(0).webContents.emit('will-navigate', event, 'file:///etc/passwd');
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('reads the url from the legacy positional argument when the event carries none', () => {
    openAgentSession('agent-browser:a1', AGENT_A);
    const event = { preventDefault: vi.fn() };
    viewOf(0).webContents.emit('will-navigate', event, 'file:///etc/passwd');
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('blocks when the target cannot be read at all (fail closed)', () => {
    openAgentSession('agent-browser:a1', AGENT_A);
    const event = { preventDefault: vi.fn() };
    viewOf(0).webContents.emit('will-navigate', event);
    expect(event.preventDefault).toHaveBeenCalled();
  });
});

describe('popups (window.open / target=_blank)', () => {
  it('always denies the popup and never forwards a disallowed scheme', () => {
    openAgentSession('agent-browser:a1', AGENT_A);
    const forwarded: string[] = [];
    service().on('external-navigation-requested', (p: { url: string }) => forwarded.push(p.url));
    const handler = viewOf(0).webContents.windowOpenHandler!;
    expect(handler({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' });
    expect(handler({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' });
    expect(handler({ url: 'https://example.com/next' })).toEqual({ action: 'deny' });
    // F1.1: an agent portal never forwards a popup to the external browser.
    expect(forwarded).toEqual([]);
  });
});

describe('downloads', () => {
  it('cancels a download started by an agent-owned session', () => {
    openAgentSession('agent-browser:a1', AGENT_A);
    const ses = fakeState.sessions.get(service().getPartitionName('agent-browser:a1')!)!;
    const event = { preventDefault: vi.fn() };
    ses.emit('will-download', event, {}, viewOf(0).webContents);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("leaves the user's editor session download behaviour alone", () => {
    openEditorSession();
    const ses = fakeState.sessions.get('browser-preview')!;
    const event = { preventDefault: vi.fn() };
    ses.emit('will-download', event, {}, viewOf(0).webContents);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('tells the two apart (separate partitions since F1.1)', () => {
    openEditorSession();
    openAgentSession('agent-browser:a1', AGENT_A);
    const editorSes = fakeState.sessions.get('browser-preview')!;
    const agentSes = fakeState.sessions.get(service().getPartitionName('agent-browser:a1')!)!;
    const editorEvent = { preventDefault: vi.fn() };
    const agentEvent = { preventDefault: vi.fn() };
    editorSes.emit('will-download', editorEvent, {}, viewOf(0).webContents);
    agentSes.emit('will-download', agentEvent, {}, viewOf(1).webContents);
    expect(editorEvent.preventDefault).not.toHaveBeenCalled();
    expect(agentEvent.preventDefault).toHaveBeenCalled();
  });
});
