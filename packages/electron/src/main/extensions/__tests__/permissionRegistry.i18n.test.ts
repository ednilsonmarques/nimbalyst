// @vitest-environment node
/** Extension permission descriptors sent to the consent prompt are localized on request. */
import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage } from '@nimbalyst/runtime/i18n';
import { listPermissionDescriptors, localizePermissionDescriptor } from '../permissionRegistry';

afterEach(async () => {
  await setLanguage('en');
});

describe('permission descriptor i18n', () => {
  it('keeps every English label and description identical to the catalog', () => {
    for (const descriptor of listPermissionDescriptors()) {
      expect(localizePermissionDescriptor(descriptor)).toEqual(descriptor);
    }
  });

  it('translates every descriptor to pt-BR without touching id or risk', async () => {
    await setLanguage('pt-BR');
    for (const descriptor of listPermissionDescriptors()) {
      const localized = localizePermissionDescriptor(descriptor);
      expect(localized.id).toBe(descriptor.id);
      expect(localized.risk).toBe(descriptor.risk);
      expect(localized.label).not.toBe(descriptor.label);
      expect(localized.description).not.toBe(descriptor.description);
      expect(localized.label).not.toContain('extensionPermissions');
    }
    const files = listPermissionDescriptors().find((d) => d.id === 'workspace-files')!;
    expect(localizePermissionDescriptor(files).label).toBe('Arquivos do espaço de trabalho');
  });
});
