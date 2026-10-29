/**
 * `team_front_propose` (F1.1, M-13 ADR-1): the host handler. The Team
 * coordinator proposes fronts; this posts a confirmation card and returns at
 * once. It is not an interactive prompt and it does not wait: the user decides
 * on the card, a renderer IPC settles it (S3), and the host writes. Nothing is
 * written to the tracker here.
 *
 * Who may call: the TEAM ROOT, read from the caller's own session row and
 * failing closed (team mode, not a team child, standard role, not archived, the
 * workspace the call came from). A member of any role is refused here by the
 * host; the tool policy (toolPolicy.ts) also denies the tool to every team
 * child role, but this check does not depend on it.
 *
 * The messages are agent-facing (English), not UI strings.
 */

import { resolveTeamContext } from '@nimbalyst/runtime/ai/server/providers/teamContext';
import { sameWorkspaceIdentity } from '../../utils/workspaceIdentity';
import {
  TeamFrontProposalError,
  parseTeamFrontProposalArgs,
  validateTeamFrontProposal,
  type PendingTeamFrontProposal,
  type TeamFrontProposalPorts,
  type TeamFrontProposalRegistry,
} from './teamFrontProposals';

/** The part of a session row the caller check reads. */
export interface TeamFrontProposeSessionRow {
  metadata?: unknown;
  agentRole?: string | null;
  workspacePath?: string | null;
  isArchived?: boolean | null;
}

export interface TeamFrontProposeDeps {
  /** Rejects when the row cannot be read (the call is then refused, fail closed). */
  readSession: (sessionId: string) => Promise<TeamFrontProposeSessionRow | null>;
  ports: TeamFrontProposalPorts;
  registry: TeamFrontProposalRegistry;
  /** Shows the card; rejects when it cannot be shown. */
  postCard: (proposal: PendingTeamFrontProposal) => Promise<void>;
  now?: () => number;
}

export const TEAM_FRONT_PROPOSE_ROOT_ONLY =
  'team_front_propose is available only to the Team mode coordinator (the team root session). ' +
  'A team member does not propose fronts: tell your coordinator what the team needs.';

function refuse(message: string): never {
  throw new TeamFrontProposalError('invalid-arguments', message);
}

/**
 * The caller's session row must be a live Team mode root of this workspace.
 * Everything the check needs comes from the host's own row, never from the
 * arguments or the transport.
 */
export function assertTeamRoot(session: TeamFrontProposeSessionRow | null, workspaceId: string): void {
  if (!session) refuse('The calling session could not be verified, so nothing was proposed.');
  const metadata = session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
    ? (session.metadata as Record<string, unknown>)
    : null;
  const team = resolveTeamContext(metadata, session.agentRole);
  if (team.teamChild) refuse(TEAM_FRONT_PROPOSE_ROOT_ONLY);
  if (!team.teamMode) refuse(TEAM_FRONT_PROPOSE_ROOT_ONLY);
  if ((session.agentRole ?? 'standard') !== 'standard') refuse(TEAM_FRONT_PROPOSE_ROOT_ONLY);
  if (session.isArchived === true) refuse('This team session is archived, so nothing was proposed.');
  if (!session.workspacePath || !sameWorkspaceIdentity(session.workspacePath, workspaceId)) {
    refuse('The calling session does not belong to this workspace, so nothing was proposed.');
  }
}

/**
 * Validate a proposal, register it, show the card, and return at once. Throws
 * (a tool error) on any refusal, and then nothing is registered or posted.
 */
export async function proposeTeamFronts(
  deps: TeamFrontProposeDeps,
  callerSessionId: string,
  workspaceId: string,
  rawArgs: unknown,
): Promise<string> {
  let session: TeamFrontProposeSessionRow | null;
  try {
    session = await deps.readSession(callerSessionId);
  } catch {
    return refuse('The calling session could not be verified, so nothing was proposed. Try again.');
  }
  assertTeamRoot(session, workspaceId);
  const workspacePath = session!.workspacePath as string;

  // A cheap early refusal; register() enforces it atomically.
  if (deps.registry.pendingForRoot(callerSessionId)) {
    throw new TeamFrontProposalError(
      'proposal-pending',
      'A front proposal is already waiting for the user\'s decision. Wait for Nimbalyst to report the result before proposing again.',
    );
  }

  const items = parseTeamFrontProposalArgs(rawArgs);
  const resolved = await validateTeamFrontProposal(items, workspaceId, deps.ports);
  const proposal = deps.registry.register({ rootSessionId: callerSessionId, workspacePath, items: resolved, now: deps.now?.() });
  try {
    await deps.postCard(proposal);
  } catch (error) {
    deps.registry.discard(proposal.id);
    console.warn('[team] Failed to show the front proposal card:', error);
    return refuse('The proposal card could not be shown to the user, so nothing was proposed. Try again.');
  }

  return JSON.stringify(
    {
      status: 'awaiting_user_decision',
      proposalId: proposal.id,
      items: proposal.items.length,
      note:
        'The proposal is on the user\'s screen in this session\'s transcript. Nothing has been created or changed. ' +
        'The user approves, edits or rejects each item; Nimbalyst then writes the approved ones and tells you the result. ' +
        'Do not call team_front_propose again, and do not ask the user to approve it in chat, until that result arrives.',
    },
    null,
    2,
  );
}
