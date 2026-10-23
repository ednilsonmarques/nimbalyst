// @vitest-environment node
/**
 * Portal F1.2 -- the native confirmation main shows before the test-data mark is
 * enabled or its interaction ports are widened. Same pattern as
 * teamInviteConfirmation: Cancel is the default and the escape answer, only an
 * explicit OK resolves true, anything else (including an error) resolves false.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ dialog: { showMessageBox: vi.fn() } }));

import { setLanguage } from '@nimbalyst/runtime/i18n';
import { buildPortalMarkConfirmDialog, confirmPortalMark } from '../portalMarkConfirmation';

afterEach(async () => {
  await setLanguage('en');
});

const ENABLE = { kind: 'enable', projectPath: '/work/My Project', ports: [3000, 5173] } as const;

describe('the dialog', () => {
  it('names the project and what agents will be allowed to do, and Cancel is default and Esc', () => {
    const o = buildPortalMarkConfirmDialog(ENABLE);
    expect(o.message).toContain('My Project');
    expect(o.detail).toContain('click, type and run scripts');
    expect(o.detail).toContain('3000, 5173');
    expect(o.buttons).toEqual(['Allow', 'Cancel']);
    expect(o.defaultId).toBe(1);
    expect(o.cancelId).toBe(1);
  });

  it('says localhost stays view-only when no port is declared', () => {
    const o = buildPortalMarkConfirmDialog({ ...ENABLE, ports: [] });
    expect(o.detail).toMatch(/view-only/);
    expect(o.detail).not.toContain('{{');
    expect(o.detail).not.toContain('undefined');
  });

  it('has a ports variant that lists the ports', () => {
    const o = buildPortalMarkConfirmDialog({ kind: 'ports', projectPath: '/work/My Project', ports: [8080] });
    expect(o.message).toContain('My Project');
    expect(o.detail).toContain('8080');
    expect(o.defaultId).toBe(1);
    expect(o.cancelId).toBe(1);
  });

  it('strips control and bidi characters from the project name and bounds its length', () => {
    const o = buildPortalMarkConfirmDialog({ ...ENABLE, projectPath: '/x/Evil\u202eProj\u0007ect' + 'a'.repeat(200) });
    expect(o.message).not.toMatch(/[\u202e\u0007]/);
    expect(o.message.length).toBeLessThan(200);
  });

  it('is localised in pt-BR', async () => {
    await setLanguage('pt-BR');
    const o = buildPortalMarkConfirmDialog(ENABLE);
    expect(o.buttons).toEqual(['Permitir', 'Cancelar']);
    expect(o.message).toContain('My Project');
    expect(o.defaultId).toBe(1);
    expect(o.cancelId).toBe(1);
  });
});

describe('confirmPortalMark', () => {
  it('resolves true only when the user clicks Allow (button 0)', async () => {
    expect(await confirmPortalMark(ENABLE, async () => ({ response: 0, checkboxChecked: false }))).toBe(true);
  });

  it('resolves false for Cancel, Esc / closing (also Cancel) and any other result', async () => {
    for (const response of [1, 2, -1, 99]) {
      expect(await confirmPortalMark(ENABLE, async () => ({ response, checkboxChecked: false })), String(response)).toBe(false);
    }
    expect(await confirmPortalMark(ENABLE, async () => ({}) as never)).toBe(false);
    expect(await confirmPortalMark(ENABLE, async () => undefined as never)).toBe(false);
  });

  it('resolves false when the dialog throws or rejects', async () => {
    expect(await confirmPortalMark(ENABLE, async () => { throw new Error('no display'); })).toBe(false);
    expect(await confirmPortalMark(ENABLE, () => { throw new Error('sync'); })).toBe(false);
  });

  it('shows the dialog on the project window when it is given', async () => {
    const { dialog } = await import('electron');
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 0, checkboxChecked: false });
    const parent = { isDestroyed: () => false } as never;
    expect(await confirmPortalMark(ENABLE, undefined, parent)).toBe(true);
    expect(vi.mocked(dialog.showMessageBox).mock.calls.at(-1)![0]).toBe(parent);
  });
});
