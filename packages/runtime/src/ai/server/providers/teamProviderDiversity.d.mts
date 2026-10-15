export type TeamProviderDiversity = 'diverse' | 'same';

/**
 * Whether a member's provider differs from the team root's: `diverse` when the
 * two differ, `same` when they are equal, null when either is unknown. The one
 * definition shared with scripts/team-pilot-report.mjs (see the .mjs next to
 * this declaration).
 */
export function teamProviderDiversity(
  memberProvider: string | null | undefined,
  rootProvider: string | null | undefined,
): TeamProviderDiversity | null;
