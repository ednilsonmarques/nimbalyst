// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `nimbalyst://invite/{orgId}?email=...` carries no Stytch token — the desktop
 * app accepts an invitation by exchanging a session it already holds. That makes
 * the email in the link the only thing tying the link to an identity, and it is
 * attacker-supplied. These tests pin the guard: a link is only ever acted on by
 * a signed-in account that owns the invited address.
 */

const { accountsMock, authenticatedMock, fetchMock } = vi.hoisted(() => ({
  accountsMock: vi.fn(() => [{
    personalOrgId: 'personal-1',
    email: 'invitee@test.com',
    sessionStatus: 'active',
  }] as Array<Record<string, unknown>>),
  authenticatedMock: vi.fn(() => true),
  fetchMock: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: class {},
  net: { fetch: fetchMock },
}));

vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn(), safeOn: vi.fn() }));

vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

const gitRemoteFnMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/gitUtils', () => ({
  getNormalizedGitRemote: gitRemoteFnMock,
  getRawGitRemote: gitRemoteFnMock,
  normalizeGitRemote: (url: string | null) => url,
  getGitRemoteIdentities: async (workspacePath: string) => {
    const remote = await gitRemoteFnMock(workspacePath);
    return remote ? { canonical: remote, legacy: remote } : null;
  },
}));

vi.mock('../teamProjectResolver', () => ({ resolveTeamForRemoteHash: vi.fn() }));

vi.mock('../../window/WindowManager', () => ({
  createWindow: vi.fn(),
  windows: new Map(),
  windowStates: new Map(),
}));

vi.mock('../../window/windowState', () => ({
  windowReferencesWorkspace: vi.fn(() => false),
}));

vi.mock('../../utils/collabSyncUrl', () => ({ getCollabSyncHttpUrl: () => 'https://sync.test' }));

vi.mock('../jwtOrg', () => ({
  assertJwtMatchesOrg: vi.fn(),
  getJwtExp: vi.fn(() => Math.floor(Date.now() / 1000) + 300),
  AuthContextMismatchError: class AuthContextMismatchError extends Error {},
}));

vi.mock('../StytchAuthService', () => ({
  getAccounts: accountsMock,
  getPersonalSessionJwt: vi.fn(() => 'personal-jwt'),
  getPersonalSessionJwtForAccount: vi.fn(() => 'personal-jwt'),
  getSessionToken: vi.fn(() => 'session-token'),
  getSessionTokenForAccount: vi.fn(() => 'session-token'),
  isAuthenticated: authenticatedMock,
  refreshSession: vi.fn(async () => false),
  refreshSessionForAccount: vi.fn(async () => null),
  refreshPersonalSessionForAccount: vi.fn(async () => null),
  onAuthStateChange: vi.fn(() => () => {}),
  updateSessionToken: vi.fn(),
  updateSessionTokenForAccount: vi.fn(),
  getStytchUserId: vi.fn(() => 'user-1'),
  getUserEmail: vi.fn(() => 'invitee@test.com'),
  getPersonalOrgId: vi.fn(() => 'personal-1'),
  getPersonalUserId: vi.fn(() => 'user-1'),
}));

vi.mock('@nimbalyst/runtime', () => ({
  asPersonalJwt: (jwt: string) => jwt,
  asPersonalMemberId: (id: string) => id,
  asTeamJwt: (jwt: string) => jwt,
  asTeamMemberId: (id: string) => id,
}));

vi.mock('../../menu/organizationMenuState', () => ({ setHasOrganizationsForMenu: vi.fn() }));

vi.mock('../../database/initialize', () => ({}));
vi.mock('../OrgProjectionService', () => ({}));
vi.mock('../OrgAccessResolver', () => ({}));
vi.mock('../TrackerSyncManager', () => ({}));
vi.mock('../CollabBackupService', () => ({}));
vi.mock('../TeamAuthBootstrap', () => ({ createTeamAuthBootstrap: (fn: unknown) => fn }));

import { invalidateListTeamsCache, resolveInviteDeepLink } from '../TeamService';

/**
 * Number of org session exchanges. This is the call that actually joins a team
 * (Stytch promotes pending -> active_member on exchange), so it is the thing a
 * refused invitation must never trigger.
 */
function sessionExchangeCallCount(): number {
  return fetchMock.mock.calls.filter((call: unknown[]) =>
    String(call[0]).endsWith('/switch')).length;
}

function respondWithTeams(teams: Array<Record<string, unknown>>): void {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes('/api/teams') && !url.includes('/api/teams/')) {
      return { ok: true, status: 200, json: async () => ({ teams }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

const PENDING_TEAM = {
  orgId: 'org-acme',
  name: 'Acme',
  gitRemoteHash: null,
  createdAt: new Date(0).toISOString(),
  role: 'member',
  membershipType: 'invited_member',
  sourcePersonalOrgId: 'personal-1',
  sourceEmail: 'invitee@test.com',
};

describe('resolveInviteDeepLink', () => {
  const confirmJoin = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    confirmJoin.mockReset();
    confirmJoin.mockResolvedValue(true);
    fetchMock.mockReset();
    authenticatedMock.mockReturnValue(true);
    accountsMock.mockReturnValue([{
      personalOrgId: 'personal-1',
      email: 'invitee@test.com',
      sessionStatus: 'active',
    }]);
    invalidateListTeamsCache();
  });

  it('refuses to accept an invitation addressed to an email no signed-in account owns', async () => {
    respondWithTeams([PENDING_TEAM]);

    const outcome = await resolveInviteDeepLink('org-acme', 'someone-else@test.com', confirmJoin);

    expect(outcome).toEqual({
      status: 'sign-in-required',
      orgId: 'org-acme',
      email: 'someone-else@test.com',
    });
    // The guard has to short-circuit before any join: joining under the
    // signed-in account would put the wrong identity in the team.
    expect(sessionExchangeCallCount()).toBe(0);
  });

  it('reports sign-in-required rather than throwing when no account is signed in', async () => {
    authenticatedMock.mockReturnValue(false);
    respondWithTeams([PENDING_TEAM]);

    const outcome = await resolveInviteDeepLink('org-acme', 'invitee@test.com', confirmJoin);

    expect(outcome).toEqual({
      status: 'sign-in-required',
      orgId: 'org-acme',
      email: 'invitee@test.com',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a membership the console already activated as already-member, not a fresh join', async () => {
    respondWithTeams([{ ...PENDING_TEAM, membershipType: 'active_member' }]);

    const outcome = await resolveInviteDeepLink('org-acme', 'INVITEE@Test.com', confirmJoin);

    expect(outcome).toEqual({ status: 'already-member', orgId: 'org-acme', teamName: 'Acme' });
    expect(sessionExchangeCallCount()).toBe(0);
  });

  it('reports not-found when the invitation is no longer in the account directory', async () => {
    respondWithTeams([]);

    const outcome = await resolveInviteDeepLink('org-acme', 'invitee@test.com', confirmJoin);

    expect(outcome).toEqual({
      status: 'not-found',
      orgId: 'org-acme',
      email: 'invitee@test.com',
    });
  });
  describe('explicit confirmation before joining', () => {
    it('does not ask when there is nothing to join (sign-in, already a member, not found)', async () => {
      respondWithTeams([{ ...PENDING_TEAM, membershipType: 'active_member' }]);
      await resolveInviteDeepLink('org-acme', 'invitee@test.com', confirmJoin);
      respondWithTeams([]);
      invalidateListTeamsCache();
      await resolveInviteDeepLink('org-acme', 'invitee@test.com', confirmJoin);
      expect(confirmJoin).not.toHaveBeenCalled();
    });

    it('asks with the team name and the invited email, then joins on confirm', async () => {
      respondWithTeams([PENDING_TEAM]);
      await resolveInviteDeepLink('org-acme', 'INVITEE@Test.com', confirmJoin);
      expect(confirmJoin).toHaveBeenCalledTimes(1);
      expect(confirmJoin).toHaveBeenCalledWith({ orgId: 'org-acme', teamName: 'Acme', email: 'invitee@test.com' });
      // confirm -> acceptInvite ran: it exchanges the session for the org
      expect(sessionExchangeCallCount()).toBe(1);
    });

    it('does not join when the user cancels', async () => {
      respondWithTeams([PENDING_TEAM]);
      confirmJoin.mockResolvedValue(false);
      const outcome = await resolveInviteDeepLink('org-acme', 'invitee@test.com', confirmJoin);
      expect(outcome).toEqual({ status: 'declined', orgId: 'org-acme', reason: 'user' });
      expect(sessionExchangeCallCount()).toBe(0);
    });

    it('does not join when the confirmation fails or answers anything but true', async () => {
      respondWithTeams([PENDING_TEAM]);
      confirmJoin.mockRejectedValue(new Error('dialog failed'));
      expect(await resolveInviteDeepLink('org-acme', 'invitee@test.com', confirmJoin)).toEqual({ status: 'declined', orgId: 'org-acme', reason: 'user' });
      confirmJoin.mockResolvedValue('yes' as unknown as boolean);
      expect(await resolveInviteDeepLink('org-acme', 'invitee@test.com', confirmJoin)).toEqual({ status: 'declined', orgId: 'org-acme', reason: 'user' });
      confirmJoin.mockImplementation(() => { throw new Error('sync throw'); });
      expect(await resolveInviteDeepLink('org-acme', 'invitee@test.com', confirmJoin)).toEqual({ status: 'declined', orgId: 'org-acme', reason: 'user' });
      expect(sessionExchangeCallCount()).toBe(0);
    });

    describe('the account shown is the account that joins (A5)', () => {
      it('shows the owning account and joins with exactly that account', async () => {
        respondWithTeams([PENDING_TEAM]);
        await resolveInviteDeepLink('org-acme', undefined, confirmJoin);
        expect(confirmJoin).toHaveBeenCalledWith({ orgId: 'org-acme', teamName: 'Acme', email: 'invitee@test.com' });
        // the exchange ran once, for the account that was confirmed
        expect(sessionExchangeCallCount()).toBe(1);
      });

      it('declines when the signed-in account changes while the dialog is open', async () => {
        respondWithTeams([PENDING_TEAM]);
        confirmJoin.mockImplementation(async () => {
          accountsMock.mockReturnValue([{ personalOrgId: 'personal-2', email: 'other@test.com', sessionStatus: 'active' }]);
          return true;
        });
        const outcome = await resolveInviteDeepLink('org-acme', 'invitee@test.com', confirmJoin);
        expect(outcome).toEqual({ status: 'declined', orgId: 'org-acme', reason: 'account-changed' });
        expect(sessionExchangeCallCount()).toBe(0);
      });

      it('declines when the user signs out while the dialog is open', async () => {
        respondWithTeams([PENDING_TEAM]);
        confirmJoin.mockImplementation(async () => { authenticatedMock.mockReturnValue(false); return true; });
        const outcome = await resolveInviteDeepLink('org-acme', 'invitee@test.com', confirmJoin);
        expect(outcome).toEqual({ status: 'declined', orgId: 'org-acme', reason: 'account-changed' });
        expect(sessionExchangeCallCount()).toBe(0);
      });

      it('declines when the second listing binds the invitation to a different account, and does not switch', async () => {
        accountsMock.mockReturnValue([
          { personalOrgId: 'personal-1', email: 'invitee@test.com', sessionStatus: 'active' },
          { personalOrgId: 'personal-2', email: 'other@test.com', sessionStatus: 'active' },
        ]);
        respondWithTeams([PENDING_TEAM]);
        confirmJoin.mockImplementation(async () => {
          // by the time the user confirms, the directory binds this invitation to the other account
          invalidateListTeamsCache();
          respondWithTeams([{ ...PENDING_TEAM, owningPersonalOrgId: 'personal-2', teamMemberId: 'member-2' }]);
          return true;
        });
        const outcome = await resolveInviteDeepLink('org-acme', 'invitee@test.com', confirmJoin);
        expect(confirmJoin).toHaveBeenCalledWith({ orgId: 'org-acme', teamName: 'Acme', email: 'invitee@test.com' });
        expect(outcome).toEqual({ status: 'declined', orgId: 'org-acme', reason: 'account-changed' });
        expect(sessionExchangeCallCount()).toBe(0);
      });

      it('re-checks the active account after the second listing: if it changed meanwhile, declines without switching', async () => {
        let teamListings = 0;
        fetchMock.mockImplementation(async (url: string) => {
          if (url.includes('/api/teams') && !url.includes('/api/teams/')) {
            teamListings++;
            // the second listing is the fresh one after the confirmation: the signed-in account changes during it,
            // after the listing already took its snapshot of the accounts and after the first isActiveAccount() check
            if (teamListings === 2) {
              accountsMock.mockReturnValue([{ personalOrgId: 'personal-2', email: 'other@test.com', sessionStatus: 'active' }]);
            }
            return { ok: true, status: 200, json: async () => ({ teams: [PENDING_TEAM] }) };
          }
          return { ok: true, status: 200, json: async () => ({}) };
        });
        const outcome = await resolveInviteDeepLink('org-acme', 'invitee@test.com', confirmJoin);
        expect(teamListings).toBe(2);
        expect(confirmJoin).toHaveBeenCalledTimes(1);
        expect(outcome).toEqual({ status: 'declined', orgId: 'org-acme', reason: 'account-changed' });
        expect(sessionExchangeCallCount()).toBe(0); // acceptInvite never ran: no session exchange, no account switch
      });

      it('does not join twice when the membership became active while the dialog was open', async () => {
        respondWithTeams([PENDING_TEAM]);
        confirmJoin.mockImplementation(async () => {
          respondWithTeams([{ ...PENDING_TEAM, membershipType: 'active_member' }]);
          return true;
        });
        const outcome = await resolveInviteDeepLink('org-acme', 'invitee@test.com', confirmJoin);
        expect(outcome).toEqual({ status: 'already-member', orgId: 'org-acme', teamName: 'Acme' });
        expect(sessionExchangeCallCount()).toBe(0);
      });
    });
  });
});
