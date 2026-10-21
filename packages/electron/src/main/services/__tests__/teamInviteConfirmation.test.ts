// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('electron', () => ({ dialog: { showMessageBox: vi.fn() } }));

import { I18N_RESOURCES, setLanguage } from '@nimbalyst/runtime/i18n';
import { buildTeamInviteConfirmDialog, confirmTeamInviteJoin, runExclusiveInviteFlow } from '../teamInviteConfirmation';

const INFO = { orgId: 'org_123', teamName: 'Acme', email: 'invitee@test.com' };

afterEach(async () => {
  await setLanguage('en');
});

describe('team invite confirmation dialog', () => {
  it('shows the organisation and the invited email, with Cancel as default and Esc', () => {
    const o = buildTeamInviteConfirmDialog(INFO);
    expect(o.message).toContain('Acme');
    expect(o.detail).toContain('invitee@test.com');
    expect(o.buttons).toEqual(['Join organization', 'Cancel']);
    expect(o.defaultId).toBe(1);
    expect(o.cancelId).toBe(1);
  });

  it('falls back to the org id when the name is missing and has a no-email variant', () => {
    const o = buildTeamInviteConfirmDialog({ orgId: 'org_123', teamName: '  ' });
    expect(o.message).toContain('org_123');
    expect(o.detail).not.toContain('{{');
    expect(o.detail).not.toContain('undefined');
  });

  it('is localised in pt-BR with the requested button labels', async () => {
    await setLanguage('pt-BR');
    const o = buildTeamInviteConfirmDialog(INFO);
    expect(o.buttons).toEqual(['Entrar na organização', 'Cancelar']);
    expect(o.message).toContain('Acme');
    expect(o.defaultId).toBe(1);
    expect(o.cancelId).toBe(1);
  });

  it('has the same keys in en and pt-BR', () => {
    const keys = (lang: 'en' | 'pt-BR') => Object.keys((I18N_RESOURCES as any)[lang].dialogs.teamInviteDeepLink).sort();
    expect(keys('pt-BR')).toEqual(keys('en'));
  });

  it('strips control and bidi characters and bounds the length of untrusted text', () => {
    const o = buildTeamInviteConfirmDialog({ orgId: 'o', teamName: `Evil‮\n\u0007${'x'.repeat(300)}`, email: 'a@b.c⁦' });
    expect(o.message).not.toMatch(/[\u0000-\u001f‮⁦]/);
    expect((o.message ?? '').length).toBeLessThan(140);
  });

  it('resolves true only on the join button', async () => {
    const show = vi.fn().mockResolvedValue({ response: 0, checkboxChecked: false });
    expect(await confirmTeamInviteJoin(INFO, show)).toBe(true);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('resolves false on Cancel, Esc (cancelId) and a dialog error', async () => {
    expect(await confirmTeamInviteJoin(INFO, vi.fn().mockResolvedValue({ response: 1, checkboxChecked: false }))).toBe(false);
    expect(await confirmTeamInviteJoin(INFO, vi.fn().mockResolvedValue({ response: -1, checkboxChecked: false }))).toBe(false);
    expect(await confirmTeamInviteJoin(INFO, vi.fn().mockRejectedValue(new Error('no display')))).toBe(false);
    expect(await confirmTeamInviteJoin(INFO, vi.fn(() => { throw new Error('sync'); }))).toBe(false);
  });
});

describe('untrusted text sanitisation (widened)', () => {
  const HIDDEN = [0x200e, 0x200f, 0x061c, 0x200b, 0x200c, 0x200d, 0xfeff, 0x202e, 0x2066, 0x0007].map((c) => String.fromCharCode(c));

  it('strips LRM/RLM/ALM, zero-width characters, BOM, bidi controls and control characters', () => {
    for (const ch of HIDDEN) {
      const o = buildTeamInviteConfirmDialog({ orgId: 'o', teamName: `Ac${ch}me`, email: `a${ch}@b.c` });
      expect(o.message, JSON.stringify(ch)).toBe('Join "Ac me"?');
      expect(o.detail, JSON.stringify(ch)).toContain('a @b.c');
      expect(o.message).not.toContain(ch);
      expect(o.detail).not.toContain(ch);
    }
  });

  it('a name made only of invisible characters falls back to the org id', () => {
    const o = buildTeamInviteConfirmDialog({ orgId: 'org_9', teamName: [0x200b, 0x200e, 0xfeff].map((c) => String.fromCharCode(c)).join('') });
    expect(o.message).toContain('org_9');
  });
});

describe('invite confirmations are serialised', () => {
  it('ignores (and reports) a second invite while the first is still open, then accepts new ones', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = vi.fn(() => gate);
    const second = vi.fn(async () => undefined);
    const busy = vi.fn();

    const running = runExclusiveInviteFlow(first, busy);
    await runExclusiveInviteFlow(second, busy);
    await runExclusiveInviteFlow(second, busy);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(busy).toHaveBeenCalledTimes(2);

    release();
    await running;
    await runExclusiveInviteFlow(second, busy);
    expect(second).toHaveBeenCalledTimes(1);
    expect(busy).toHaveBeenCalledTimes(2);
  });

  it('releases the lock when the flow throws', async () => {
    await expect(runExclusiveInviteFlow(async () => { throw new Error('boom'); }, vi.fn())).rejects.toThrow('boom');
    const next = vi.fn(async () => undefined);
    await runExclusiveInviteFlow(next, vi.fn());
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('index.ts routes the invite handler through the exclusive flow', () => {
    const index = fs.readFileSync(path.join(path.resolve(__dirname, '../..'), 'index.ts'), 'utf8');
    expect(index).toContain('runExclusiveInviteFlow(');
    expect(index).toContain('() => resolveAndSurfaceTeamInvite(orgId, email)');
  });
});

describe('every invite deep link goes through the confirmation', () => {
  const mainDir = path.resolve(__dirname, '../..');
  const read = (p: string) => fs.readFileSync(path.join(mainDir, p), 'utf8');

  it('resolveInviteDeepLink has a single production caller and it passes the native confirmation', () => {
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p);
        } else if (/\.tsx?$/.test(e.name) && fs.readFileSync(p, 'utf8').includes('resolveInviteDeepLink(')) {
          callers.push(path.relative(mainDir, p).split(path.sep).join('/'));
        }
      }
    };
    walk(mainDir);
    expect(callers.sort()).toEqual(['index.ts', 'services/TeamService.ts']);
    expect(read('index.ts')).toMatch(/resolveInviteDeepLink\(orgId, email, \(info\) =>\s*confirmTeamInviteJoin\(info/);
  });

  it('second-instance, open-url and startup argv reach the invite branch only through handleDeepLink', () => {
    const index = read('index.ts');
    expect((index.match(/openTeamInviteFromDeepLink\(/g) ?? []).length).toBe(2); // definition + the single call in handleDeepLink
    expect(index).toContain('isInviteRoute(parsed)');
  });
});
