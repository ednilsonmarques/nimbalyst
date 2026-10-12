/**
 * What a TeamCheckpoint transcript card says, read from its tool call. Shared
 * by the card (TeamCheckpointWidget) and the bar that keeps a pending
 * checkpoint reachable at the bottom of the transcript (TeamCheckpointBar), so
 * both agree on when a checkpoint is pending.
 */

import { useCallback, useState } from 'react';
import { useAtomValue } from 'jotai';
import { interactiveWidgetHostAtom, getInteractiveWidgetHost } from '../../../../store/atoms/interactiveWidgetHost';
import { stripMcpPrefix } from '../../../../ai/server/interactivePromptTools';
import { TEAM_CHECKPOINT_TOOL_NAME } from '../../../../ai/server/providers/teamContext';

interface CheckpointToolCall {
  toolName?: string | null;
  arguments?: unknown;
  result?: unknown;
}

export interface TeamCheckpointCard {
  rootSessionId: string | null;
  /** Sessions the team had created when the checkpoint was reached. */
  created: number;
  /** The authorized level the team reached: what identifies this checkpoint. */
  authorized: number;
  extension: number;
  maxActive: number;
  /** The level the user continued to, or null while the checkpoint is pending. */
  continuedTo: number | null;
}

const asCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** The card of a TeamCheckpoint tool call, or null for any other tool call. */
export function readTeamCheckpointCard(toolCall: CheckpointToolCall | null | undefined): TeamCheckpointCard | null {
  if (!toolCall?.toolName || stripMcpPrefix(toolCall.toolName) !== TEAM_CHECKPOINT_TOOL_NAME) return null;
  const args = (toolCall.arguments && typeof toolCall.arguments === 'object' ? toolCall.arguments : {}) as Record<string, unknown>;
  const created = asCount(args.created) ?? 0;

  // Only the host's own outcome closes a card: `{ continued: true, authorized }`.
  let continuedTo: number | null = null;
  if (typeof toolCall.result === 'string' && toolCall.result) {
    try {
      const parsed = JSON.parse(toolCall.result);
      if (parsed?.continued === true) continuedTo = asCount(parsed.authorized);
    } catch {
      // Not the host's outcome: the card stays pending.
    }
  }

  return {
    rootSessionId: typeof args.rootSessionId === 'string' && args.rootSessionId ? args.rootSessionId : null,
    created,
    authorized: asCount(args.authorized) ?? created,
    extension: asCount(args.extension) ?? 0,
    maxActive: asCount(args.maxActive) ?? 0,
    continuedTo,
  };
}

/**
 * The checkpoint still waiting for the user in a transcript: the pending card
 * of the highest level, or null. Repeated rows of one level are one checkpoint.
 */
export function findPendingTeamCheckpoint(
  messages: ReadonlyArray<{ toolCall?: CheckpointToolCall | null }>,
): TeamCheckpointCard | null {
  const byLevel = new Map<number, TeamCheckpointCard>();
  for (const message of messages) {
    const card = readTeamCheckpointCard(message.toolCall);
    if (!card) continue;
    const known = byLevel.get(card.authorized);
    // A level is settled as soon as any of its rows carries the outcome.
    if (!known || (known.continuedTo === null && card.continuedTo !== null)) byLevel.set(card.authorized, card);
  }
  let pending: TeamCheckpointCard | null = null;
  let highestContinued = 0;
  for (const card of byLevel.values()) {
    if (card.continuedTo !== null) highestContinued = Math.max(highestContinued, card.continuedTo);
    else if (!pending || card.authorized > pending.authorized) pending = card;
  }
  // A card left behind by a level the team has already passed is not pending.
  return pending && pending.authorized >= highestContinued ? pending : null;
}

/**
 * "Continue team" for one checkpoint card. The click is the user's
 * authorization: it goes through the host's own channel (teamContinue).
 */
export function useTeamContinue(sessionId: string, card: TeamCheckpointCard | null) {
  const host = useAtomValue(interactiveWidgetHostAtom(sessionId));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [continuedTo, setContinuedTo] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  const rootSessionId = card?.rootSessionId ?? sessionId;
  const level = card?.authorized;

  // Read the host at click time: see ToolPermissionWidget (#276).
  const continueTeam = useCallback(async () => {
    const liveHost = host || getInteractiveWidgetHost(sessionId);
    if (!liveHost?.teamContinue || isSubmitting) return;
    setIsSubmitting(true);
    setFailed(false);
    try {
      const result = await liveHost.teamContinue(rootSessionId, level);
      if (result.success && typeof result.authorized === 'number') setContinuedTo(result.authorized);
      else setFailed(true);
    } catch (error) {
      console.error('[TeamCheckpoint] Failed to continue the team:', error);
      setFailed(true);
    } finally {
      setIsSubmitting(false);
    }
  }, [host, sessionId, rootSessionId, level, isSubmitting]);

  return {
    canContinue: !!(host || getInteractiveWidgetHost(sessionId))?.teamContinue,
    continueTeam,
    isSubmitting,
    failed,
    /** Level reached by this click, before the persisted outcome arrives. */
    continuedTo,
  };
}
