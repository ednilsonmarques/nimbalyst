export interface InviteDeepLinkTarget {
  orgId: string;
  /**
   * Address the invitation was sent to. Advisory: it selects which signed-in
   * account should own the acceptance and prefills the sign-in prompt when no
   * account matches. Membership itself is decided by the server, never by this
   * value.
   */
  email?: string;
}

/**
 * The one definition of "this URL is the team-invitation route", shared by the
 * deep-link handler (main/index.ts), the parser below and the in-app
 * navigation policy (NIB.98), so they cannot disagree. Takes a parsed URL; the
 * protocol is checked by the callers that care.
 */
export function isInviteRoute(parsed: { host: string; pathname: string }): boolean {
  return parsed.host === 'invite' || parsed.pathname.startsWith('/invite/');
}

/**
 * Parse and validate a team-invitation deep link at the main-process routing
 * boundary: `nimbalyst://invite/{orgId}?email={email}`.
 *
 * The link deliberately carries no Stytch token. The desktop app accepts an
 * invitation by exchanging an already-signed-in session for the org
 * (`TeamService.acceptInvite`), so an emailed link never needs to transport
 * credentials — and the auth deep-link nonce gate stays closed.
 */
export function parseInviteDeepLink(rawUrl: string): InviteDeepLinkTarget {
  const parsed = new URL(rawUrl);
  if (!(parsed.protocol === 'nimbalyst:' && isInviteRoute(parsed))) {
    throw new Error('URL is not a Nimbalyst invite deep link');
  }

  const encodedOrgId = parsed.host === 'invite'
    ? parsed.pathname.replace(/^\//, '')
    : parsed.pathname.replace('/invite/', '');

  let orgId: string;
  try {
    orgId = decodeURIComponent(encodedOrgId);
  } catch {
    throw new Error('Invite deep link has a malformed orgId');
  }

  if (!orgId) {
    throw new Error('Invite deep link requires an orgId');
  }

  const email = parsed.searchParams.get('email')?.trim().toLowerCase();

  return {
    orgId,
    ...(email ? { email } : {}),
  };
}
