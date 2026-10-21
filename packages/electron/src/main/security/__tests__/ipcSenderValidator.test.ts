import { describe, it, expect, vi } from 'vitest';

const fromWebContents = vi.fn();
vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: (...a: unknown[]) => fromWebContents(...a) } }));

import { createIpcSenderValidator } from '../ipcSenderValidator';
import { buildAppOriginConfig } from '../navigationPolicy';

const cfg = buildAppOriginConfig({ env: { ELECTRON_RENDERER_URL: 'http://localhost:5173', NODE_ENV: 'development' }, appPath: '/x' });
const validate = createIpcSenderValidator(cfg);

function event(frame: Record<string, unknown> | null, sender: Record<string, unknown> = {}) {
  return { sender: { isDestroyed: () => false, getURL: () => 'http://localhost:5173/', mainFrame: { processId: 1, routingId: 1 }, ...sender }, senderFrame: frame };
}

describe('createIpcSenderValidator', () => {
  it('accepts a top frame (no parent) at the app origin in an app window', () => {
    fromWebContents.mockReturnValue({});
    expect(validate(event({ url: 'http://localhost:5173/?theme=dark', parent: null, processId: 1, routingId: 1 }), 'x')).toEqual({ allowed: true });
  });

  it('still accepts the top frame while sender.mainFrame points at another frame object (reload race)', () => {
    fromWebContents.mockReturnValue({});
    const e = event({ url: 'http://localhost:5173/', parent: null, processId: 2, routingId: 9 }, { mainFrame: { processId: 1, routingId: 1 } });
    expect(validate(e, 'workspace:get-state')).toEqual({ allowed: true });
  });

  it('treats an event without a sender as an internal emit (ipcMain.emit from the main process) and allows it', () => {
    fromWebContents.mockReturnValue(null);
    expect(validate(null, 'console-log')).toEqual({ allowed: true });
    expect(validate(undefined, 'console-log')).toEqual({ allowed: true });
    expect(validate({}, 'ask-user-question-response:x')).toEqual({ allowed: true });
  });

  it('still validates a renderer event that has a sender', () => {
    fromWebContents.mockReturnValue({});
    expect(validate(event({ url: 'https://evil.example/', parent: null }), 'console-log')).toEqual({ allowed: false, reason: 'foreign-url' });
    expect(validate(event({ url: 'http://localhost:5173/', parent: { url: 'x' } }), 'console-log')).toEqual({ allowed: false, reason: 'subframe' });
  });

  it('rejects a renderer event that has a sender but no frame, even when the window document is the app', () => {
    fromWebContents.mockReturnValue({});
    expect(validate(event(null), 'console-log')).toEqual({ allowed: false, reason: 'no-frame' });
    expect(validate(event(null, { getURL: () => 'https://evil.example/' }), 'console-log')).toEqual({ allowed: false, reason: 'no-frame' });
  });

  it('rejects a subframe, a foreign URL, a missing frame and a window that is not an app window', () => {
    fromWebContents.mockReturnValue({});
    expect(validate(event({ url: 'http://localhost:5173/', parent: { url: 'x' } }), 'x')).toEqual({ allowed: false, reason: 'subframe' });
    expect(validate(event({ url: 'http://127.0.0.1:9490/', parent: null }), 'x')).toEqual({ allowed: false, reason: 'foreign-url' });
    expect(validate(event(null, { getURL: () => 'https://evil.example/' }), 'x')).toEqual({ allowed: false, reason: 'no-frame' });
    fromWebContents.mockReturnValue(null);
    expect(validate(event({ url: 'http://localhost:5173/', parent: null }), 'x')).toEqual({ allowed: false, reason: 'not-app-window' });
  });
});
