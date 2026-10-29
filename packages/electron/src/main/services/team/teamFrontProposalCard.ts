/**
 * The front proposal card (F1.1): what the user sees in the team root's
 * transcript when the coordinator calls `team_front_propose`. Same mechanism as
 * the checkpoint card (teamCheckpoint.ts): a synthetic `nimbalyst_tool_use` row
 * the transcript renders with a custom widget (S4), display only.
 *
 * Deliberately NOT an interactive prompt (permission / question): those can be
 * answered by any session of the workspace through `respond_to_prompt`, which
 * would let a coordinator approve its own proposal. The decision is made only
 * through a renderer IPC (S3) against the proposal in the registry.
 *
 * The card input carries plain data only (the widget renders it as text). Unlike
 * the checkpoint card, a failure to post is NOT swallowed: a proposal the user
 * cannot see must not stay registered, so the caller discards it and refuses.
 */

import { BrowserWindow } from 'electron';
import { AgentMessagesRepository } from '@nimbalyst/runtime/storage/repositories/AgentMessagesRepository';
import { TEAM_FRONT_PROPOSAL_TOOL_NAME } from '@nimbalyst/runtime/ai/server/providers/teamContext';
import type { PendingTeamFrontProposal, ResolvedTeamFrontProposalItem } from './teamFrontProposals';

export function teamFrontProposalCardId(proposalId: string): string {
  return `team-front-proposal-${proposalId}`;
}

export interface TeamFrontProposalCardInput {
  proposalId: string;
  rootSessionId: string;
  items: ResolvedTeamFrontProposalItem[];
}

export interface TeamFrontProposalCardDeps {
  createMessage: (row: {
    sessionId: string;
    source: 'claude-code';
    direction: 'output';
    content: string;
    hidden: boolean;
    createdAt: Date;
  }) => Promise<unknown>;
  /** Tell the open transcripts to reload (`ai:message-logged`). */
  notifyMessageLogged: (sessionId: string, workspacePath: string) => void;
  now: () => Date;
}

const productionDeps: TeamFrontProposalCardDeps = {
  createMessage: (row) => AgentMessagesRepository.create(row),
  notifyMessageLogged: (sessionId, workspacePath) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('ai:message-logged', { sessionId, workspacePath });
      }
    }
  },
  now: () => new Date(),
};

/** Show the proposal in the root's transcript. Rejects when the row cannot be written. */
export async function postTeamFrontProposalCard(
  proposal: PendingTeamFrontProposal,
  deps: TeamFrontProposalCardDeps = productionDeps,
): Promise<void> {
  const input: TeamFrontProposalCardInput = {
    proposalId: proposal.id,
    rootSessionId: proposal.rootSessionId,
    items: structuredClone([...proposal.items]),
  };
  await deps.createMessage({
    sessionId: proposal.rootSessionId,
    source: 'claude-code',
    direction: 'output',
    content: JSON.stringify({
      type: 'nimbalyst_tool_use',
      id: teamFrontProposalCardId(proposal.id),
      name: TEAM_FRONT_PROPOSAL_TOOL_NAME,
      input,
    }),
    hidden: false,
    createdAt: deps.now(),
  });
  // The row is written; a failed refresh only delays the card until the next reload.
  try {
    deps.notifyMessageLogged(proposal.rootSessionId, proposal.workspacePath);
  } catch (error) {
    console.warn('[team] Failed to refresh the transcript after the front proposal card:', error);
  }
}

/**
 * Close the card in the transcript with the per-item results (the card's
 * `nimbalyst_tool_result`, so the widget stops offering the decision). Rejects
 * when the row cannot be written; the caller treats that as a delivery failure
 * only, after the writes are done.
 */
export async function resolveTeamFrontProposalCard(
  args: { proposal: PendingTeamFrontProposal; results: unknown[] },
  deps: TeamFrontProposalCardDeps = productionDeps,
): Promise<void> {
  const { proposal } = args;
  await deps.createMessage({
    sessionId: proposal.rootSessionId,
    source: 'claude-code',
    direction: 'output',
    content: JSON.stringify({
      type: 'nimbalyst_tool_result',
      tool_use_id: teamFrontProposalCardId(proposal.id),
      result: JSON.stringify({ decided: true, results: args.results }),
      is_error: false,
    }),
    hidden: false,
    createdAt: deps.now(),
  });
  try {
    deps.notifyMessageLogged(proposal.rootSessionId, proposal.workspacePath);
  } catch (error) {
    console.warn('[team] Failed to refresh the transcript after the front proposal result:', error);
  }
}
