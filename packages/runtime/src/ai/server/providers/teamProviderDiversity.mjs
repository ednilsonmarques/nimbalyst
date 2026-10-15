// The one definition of provider diversity between a team member and its
// root (NIB.43 item B). Plain JavaScript so the host (teamPolicy.ts, through
// the declaration next to this file) and the pilot report script
// (scripts/team-pilot-report.mjs, run by node on the source tree) share it
// instead of each keeping a copy of the rule.
//
//  - 'diverse': the member runs on a provider other than the root's;
//  - 'same':    the member runs on the root's provider (an independent opinion
//               by session, context and instructions, not by provider);
//  - null:      either provider is unknown, so nothing is claimed.

/**
 * @param {string | null | undefined} memberProvider
 * @param {string | null | undefined} rootProvider
 * @returns {'diverse' | 'same' | null}
 */
export function teamProviderDiversity(memberProvider, rootProvider) {
  if (!memberProvider || !rootProvider) return null;
  return memberProvider === rootProvider ? 'same' : 'diverse';
}
