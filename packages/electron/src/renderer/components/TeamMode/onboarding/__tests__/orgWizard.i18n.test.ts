// @vitest-environment node
/** Wizard errors follow the UI language without changing the analytics category. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLanguage } from '@nimbalyst/runtime/i18n';

import { categorizeTeamAnalyticsError } from '../../../../../shared/analytics/teamAnalytics';
import { createOrgWizardState, type OrgWizardState } from '../orgWizardModel';
import { runCreateOrganization, runSendInvites, type OrgWizardApi } from '../orgWizardRunner';

function fakeApi(overrides: Partial<OrgWizardApi> = {}): OrgWizardApi {
  return {
    findPendingInvitation: vi.fn(async () => null),
    acceptInvitation: vi.fn(async (orgId: string) => ({ orgId })),
    createOrganization: vi.fn(async () => ({ orgId: 'org-1' })),
    inviteMember: vi.fn(async () => {}),
    publishFolder: vi.fn(async () => true),
    ...overrides,
  };
}

function created(overrides: Partial<OrgWizardState> = {}): OrgWizardState {
  return { ...createOrgWizardState({ orgName: 'Acme' }), createdOrgId: 'org-1', step: 'invite', ...overrides };
}

afterEach(async () => {
  await setLanguage('en');
});

describe('org wizard i18n', () => {
  it('keeps the English invite failure text and translates it in pt-BR', async () => {
    const api = fakeApi({ inviteMember: vi.fn(async () => { throw new Error('seat limit reached'); }) });
    await setLanguage('en');
    expect((await runSendInvites(created({ emails: ['a@x.com'] }), api)).error)
      .toBe('Some invitations failed — a@x.com: seat limit reached');

    await setLanguage('pt-BR');
    expect((await runSendInvites(created({ emails: ['a@x.com'] }), api)).error)
      .toBe('Alguns convites falharam — a@x.com: seat limit reached');
  });

  it('keeps the create-organization analytics category in pt-BR', async () => {
    const failing = fakeApi({ createOrganization: vi.fn(async () => { throw new Error('Organization already exists'); }) });
    const categories: string[] = [];
    for (const language of ['en', 'pt-BR'] as const) {
      await setLanguage(language);
      const empty = await runCreateOrganization(createOrgWizardState({ orgName: '  ' }), fakeApi());
      const conflict = await runCreateOrganization(createOrgWizardState({ orgName: 'Acme' }), failing);
      categories.push(
        categorizeTeamAnalyticsError('organization', empty.error),
        categorizeTeamAnalyticsError('organization', conflict.error),
      );
    }
    expect(categories.slice(2)).toEqual(categories.slice(0, 2));
    expect(categories[1]).toBe('conflict');
  });
});
