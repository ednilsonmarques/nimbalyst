/**
 * What a TeamFrontProposal transcript card says, read from its tool call, and the
 * user's decision state for it (F1.1). Shared by the card (TeamFrontProposalWidget).
 *
 * Everything in the card input is text the coordinator (an agent) wrote: it is
 * coerced to plain strings here and rendered as plain text, never as markdown or
 * HTML. The decision the user submits names items by index only; the host takes the
 * action, the target front and the other fields from the proposal it stored.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { interactiveWidgetHostAtom, getInteractiveWidgetHost } from '../../../../store/atoms/interactiveWidgetHost';
import { stripMcpPrefix } from '../../../../ai/server/interactivePromptTools';
import { TEAM_FRONT_PROPOSAL_TOOL_NAME } from '../../../../ai/server/providers/teamContext';
import type {
  TeamFrontItemOutcome,
  TeamFrontProposalItemDecision,
  TeamFrontStatusValue,
} from './InteractiveWidgetHost';

export const TEAM_FRONT_STATUS_VALUES: readonly TeamFrontStatusValue[] = ['active', 'paused', 'closed'];
/** The host's bounds (teamFrontProposals.ts); the host re-validates, these only keep the form honest. */
export const TEAM_FRONT_TITLE_MAX = 120;
export const TEAM_FRONT_DESCRIPTION_MAX = 2000;

export interface CardCreateItem {
  action: 'create';
  title: string;
  description: string;
  status: TeamFrontStatusValue;
}

export interface CardStatusItem {
  action: 'status';
  frontId: string;
  frontTitle: string;
  fromStatus: string | null;
  status: TeamFrontStatusValue;
  /** Set when the front has an active mission: pausing is allowed, with a warning. */
  activeMission: { title: string | null } | null;
}

export type CardItem = CardCreateItem | CardStatusItem;

export interface TeamFrontProposalCard {
  proposalId: string;
  rootSessionId: string | null;
  items: CardItem[];
  /** The host's outcome once decided, or null while the card is pending. */
  outcome: TeamFrontItemOutcome[] | null;
}

interface ProposalToolCall {
  toolName?: string | null;
  arguments?: unknown;
  result?: unknown;
}

function asStatus(value: unknown): TeamFrontStatusValue | null {
  return typeof value === 'string' && (TEAM_FRONT_STATUS_VALUES as readonly string[]).includes(value) ? (value as TeamFrontStatusValue) : null;
}

const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

function readItem(raw: unknown): CardItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const status = asStatus(item.status);
  if (!status) return null;
  if (item.action === 'create') {
    return { action: 'create', title: asText(item.title), description: asText(item.description), status };
  }
  if (item.action === 'status') {
    const mission = item.activeMission && typeof item.activeMission === 'object' ? (item.activeMission as Record<string, unknown>) : null;
    return {
      action: 'status',
      frontId: asText(item.frontId),
      frontTitle: asText(item.frontTitle),
      fromStatus: typeof item.fromStatus === 'string' ? item.fromStatus : null,
      status,
      activeMission: mission ? { title: typeof mission.title === 'string' && mission.title ? mission.title : null } : null,
    };
  }
  return null;
}

function readOutcome(result: unknown): TeamFrontItemOutcome[] | null {
  if (typeof result !== 'string' || !result) return null;
  try {
    const parsed = JSON.parse(result);
    if (parsed?.decided !== true || !Array.isArray(parsed.results)) return null;
    return parsed.results.flatMap((entry: unknown): TeamFrontItemOutcome[] => {
      if (!entry || typeof entry !== 'object') return [];
      const r = entry as Record<string, unknown>;
      if (typeof r.index !== 'number' || !['written', 'rejected', 'refused', 'failed', 'unconfirmed'].includes(String(r.result))) return [];
      return [{
        index: r.index,
        action: r.action === 'status' ? 'status' : 'create',
        label: asText(r.label),
        result: r.result as TeamFrontItemOutcome['result'],
        ...(typeof r.id === 'string' ? { id: r.id } : {}),
        ...(typeof r.status === 'string' ? { status: r.status } : {}),
        ...(typeof r.code === 'string' ? { code: r.code } : {}),
        ...(typeof r.syncWarning === 'string' ? { syncWarning: r.syncWarning } : {}),
        ...(typeof r.followUpWarning === 'string' ? { followUpWarning: r.followUpWarning } : {}),
      }];
    });
  } catch {
    return null;
  }
}

/** The card of a TeamFrontProposal tool call, or null for any other tool call or an unreadable one. */
export function readTeamFrontProposalCard(toolCall: ProposalToolCall | null | undefined): TeamFrontProposalCard | null {
  if (!toolCall?.toolName || stripMcpPrefix(toolCall.toolName) !== TEAM_FRONT_PROPOSAL_TOOL_NAME) return null;
  const args = (toolCall.arguments && typeof toolCall.arguments === 'object' ? toolCall.arguments : {}) as Record<string, unknown>;
  if (typeof args.proposalId !== 'string' || !args.proposalId || !Array.isArray(args.items) || args.items.length === 0) return null;
  const items = args.items.map(readItem);
  if (items.some((item) => item === null)) return null;
  return {
    proposalId: args.proposalId,
    rootSessionId: typeof args.rootSessionId === 'string' && args.rootSessionId ? args.rootSessionId : null,
    items: items as CardItem[],
    outcome: readOutcome(toolCall.result),
  };
}

// ---------------------------------------------------------------------------
// The user's decision
// ---------------------------------------------------------------------------

export type ItemDecision = 'approve' | 'reject' | null;

export interface ItemEdits {
  title?: string;
  description?: string;
  status?: TeamFrontStatusValue;
}

/** The values an item would be written with: the proposal's, with the user's edits on top. */
export function effectiveItem(item: CardItem, edits: ItemEdits | undefined): CardItem {
  if (item.action === 'create') {
    return { ...item, title: edits?.title ?? item.title, description: edits?.description ?? item.description, status: edits?.status ?? item.status };
  }
  return { ...item, status: edits?.status ?? item.status };
}

/**
 * Why an approved item's values cannot be submitted, or null. 'blocked' is a close of a front that has an
 * active mission (the host refuses it too; the card does not let it be approved). The host re-validates everything.
 */
export function itemProblem(item: CardItem, edits: ItemEdits | undefined): 'title' | 'description' | 'blocked' | null {
  const effective = effectiveItem(item, edits);
  if (effective.action === 'status') return effective.status === 'closed' && effective.activeMission !== null ? 'blocked' : null;
  const title = effective.title.trim();
  if (!title || title.length > TEAM_FRONT_TITLE_MAX) return 'title';
  const description = effective.description.trim();
  if (!description || description.length > TEAM_FRONT_DESCRIPTION_MAX) return 'description';
  return null;
}

/** Only the fields the user actually changed, and only those the item's action lets them change. */
export function changedEdits(item: CardItem, edits: ItemEdits | undefined): ItemEdits | undefined {
  if (!edits) return undefined;
  const out: ItemEdits = {};
  if (item.action === 'create') {
    if (edits.title !== undefined && edits.title.trim() !== item.title) out.title = edits.title.trim();
    if (edits.description !== undefined && edits.description.trim() !== item.description) out.description = edits.description.trim();
  }
  if (edits.status !== undefined && edits.status !== item.status) out.status = edits.status;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The submission for a card: one decision per item, nothing the host did not propose. */
export function buildDecisionItems(
  card: TeamFrontProposalCard,
  decisions: readonly ItemDecision[],
  edits: ReadonlyArray<ItemEdits | undefined>,
): TeamFrontProposalItemDecision[] | null {
  const out: TeamFrontProposalItemDecision[] = [];
  for (const [index, item] of card.items.entries()) {
    const decision = decisions[index];
    if (!decision) return null;
    if (decision === 'reject') {
      out.push({ index, decision: 'reject' });
      continue;
    }
    if (itemProblem(item, edits[index])) return null;
    const changed = changedEdits(item, edits[index]);
    out.push({ index, decision: 'approve', ...(changed ? { edits: changed } : {}) });
  }
  return out;
}

export type ProposalRemoteState = 'checking' | 'pending' | 'expired' | 'unsupported';
export type ProposalFailure = 'invalid' | 'forbidden' | 'root-ineligible' | 'unavailable' | null;

/**
 * The state of one card: whether the host still holds the proposal, the user's
 * choices, and the single submit. The click goes through the host's own channel
 * (teamFrontProposalDecide), never an interactive-prompt answer.
 */
export function useTeamFrontProposal(sessionId: string, card: TeamFrontProposalCard | null) {
  const host = useAtomValue(interactiveWidgetHostAtom(sessionId));
  const count = card?.items.length ?? 0;
  const [remote, setRemote] = useState<ProposalRemoteState>('checking');
  const [decisions, setDecisions] = useState<ItemDecision[]>(() => Array(count).fill(null));
  const [edits, setEdits] = useState<Array<ItemEdits | undefined>>(() => Array(count).fill(undefined));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [failure, setFailure] = useState<ProposalFailure>(null);
  const [results, setResults] = useState<TeamFrontItemOutcome[] | null>(null);

  const decided = card?.outcome !== null && card?.outcome !== undefined;
  const proposalId = card?.proposalId;

  useEffect(() => {
    if (!proposalId || decided) return;
    const liveHost = host || getInteractiveWidgetHost(sessionId);
    if (!liveHost?.teamFrontProposalState || !liveHost.teamFrontProposalDecide) {
      setRemote('unsupported');
      return;
    }
    let cancelled = false;
    liveHost.teamFrontProposalState(proposalId)
      .then((state) => { if (!cancelled) setRemote(state.success && state.state === 'pending' ? 'pending' : 'expired'); })
      .catch(() => { if (!cancelled) setRemote('expired'); });
    return () => { cancelled = true; };
  }, [host, sessionId, proposalId, decided]);

  const decide = useCallback((index: number, value: ItemDecision) => {
    setDecisions((current) => current.map((d, i) => (i === index ? value : d)));
  }, []);
  const decideAll = useCallback((value: 'approve' | 'reject') => {
    setDecisions(Array(count).fill(value));
  }, [count]);
  const edit = useCallback((index: number, patch: ItemEdits) => {
    setEdits((current) => current.map((e, i) => (i === index ? { ...e, ...patch } : e)));
  }, []);

  const items = useMemo(() => (card ? buildDecisionItems(card, decisions, edits) : null), [card, decisions, edits]);
  const canSubmit = remote === 'pending' && !isSubmitting && results === null && items !== null;

  const submit = useCallback(async () => {
    const liveHost = host || getInteractiveWidgetHost(sessionId);
    if (!card || !items || !liveHost?.teamFrontProposalDecide || isSubmitting || results !== null) return;
    setIsSubmitting(true);
    setFailure(null);
    try {
      const response = await liveHost.teamFrontProposalDecide({
        proposalId: card.proposalId,
        rootSessionId: card.rootSessionId ?? sessionId,
        items,
      });
      if (response.success && response.results) {
        setResults(response.results);
      } else if (response.code === 'expired') {
        setRemote('expired');
      } else {
        setFailure(response.code === 'invalid' || response.code === 'forbidden' || response.code === 'root-ineligible' ? response.code : 'unavailable');
        if (response.code === 'root-ineligible') setRemote('expired');
      }
    } catch (error) {
      console.error('[TeamFrontProposal] Failed to send the decision:', error);
      setFailure('unavailable');
    } finally {
      setIsSubmitting(false);
    }
  }, [host, sessionId, card, items, isSubmitting, results]);

  return { remote, decisions, edits, decide, decideAll, edit, canSubmit, submit, isSubmitting, failure, results };
}
