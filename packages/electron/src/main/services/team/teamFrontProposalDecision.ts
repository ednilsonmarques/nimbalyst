/**
 * The user's decision on a front proposal and the approval executor (F1.1,
 * M-13 S3). This is the only place a proposal turns into tracker writes, and it
 * runs only from the renderer IPC (`team:front-proposal:decide`), never from a
 * tool: ADR-1.
 *
 * Order of a decision, and why:
 *  1. The payload is closed and checked against the STORED proposal. Anything
 *     malformed, foreign or mismatched is refused WITHOUT consuming the
 *     proposal, so a stray or forged request cannot burn the user's card.
 *  2. The root is re-checked as a live, unarchived team root of this workspace;
 *     a root that is gone discards the proposal (nothing can be approved).
 *  3. Only then the proposal is taken (one-shot). A second submit finds nothing
 *     and writes nothing.
 *  4. Items run in order. Each is independent: a refusal or failure of one does
 *     not stop the next. A status change holds the `front:<id>` lock (the one
 *     mission creation takes) through the re-read of the front and of its active
 *     mission and the write; a create holds the workspace create lock through
 *     the duplicate-title re-check and the write.
 *  5. The outcome goes to the coordinator (card result row + notice). A failure
 *     there never repeats a write and never says nothing happened.
 *
 * What the renderer can send is only `{proposalId, rootSessionId?, items:
 * [{index, decision, edits?}]}`. The action, the target front and every other
 * field come from the stored proposal; edits are limited to the fields the
 * stored action allows and re-validated with the S1 bounds. Nothing here
 * accepts a type, a field bag, `currentMission` or an authority flag.
 */

import path from 'node:path';
import { sameWorkspaceIdentity, resolveCallerWorkspaceId } from '../../utils/workspaceIdentity';
import {
  TeamFrontProposalError,
  normalizeTeamFrontTitle,
  parseTeamFrontProposalItem,
  type PendingTeamFrontProposal,
  type ResolvedTeamFrontProposalItem,
  type TeamFrontCreateItem,
  type TeamFrontProposalPorts,
  type TeamFrontProposalRegistry,
  type TeamFrontStatus,
  type TeamFrontStatusItem,
} from './teamFrontProposals';
import { assertTeamRoot, type TeamFrontProposeSessionRow } from './teamFrontProposeTool';
import { TeamFrontWriteUnconfirmedError, type TeamFrontWriter } from './teamFrontProposalWriter';

// ---------------------------------------------------------------------------
// The decision payload
// ---------------------------------------------------------------------------

export type TeamFrontItemDecision =
  | { index: number; decision: 'reject' }
  | { index: number; decision: 'approve'; edits: Record<string, unknown> };

export class TeamFrontDecisionPayloadError extends Error {}

const CREATE_EDITABLE = ['title', 'description', 'status'] as const;
const STATUS_EDITABLE = ['status'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function badPayload(message: string): never {
  throw new TeamFrontDecisionPayloadError(message);
}

function assertClosedKeys(record: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(record)) {
    if (key === 'currentMission') badPayload(`${where}: currentMission cannot be set.`);
    if (!allowed.includes(key)) badPayload(`${where}: unknown key "${key}".`);
  }
}

/** The proposal id the payload names, validated as far as the closed shape goes (no stored data needed). */
export function readDecisionProposalId(raw: unknown): { proposalId: string; rootSessionId: string | null } {
  if (!isPlainObject(raw)) badPayload('The decision must be an object.');
  assertClosedKeys(raw, ['proposalId', 'rootSessionId', 'items'], 'decision');
  if (typeof raw.proposalId !== 'string' || !/^tfp_[0-9a-f-]{36}$/.test(raw.proposalId)) badPayload('decision.proposalId is not a proposal id.');
  if (raw.rootSessionId !== undefined && (typeof raw.rootSessionId !== 'string' || !raw.rootSessionId)) {
    badPayload('decision.rootSessionId must be a session id.');
  }
  return { proposalId: raw.proposalId, rootSessionId: (raw.rootSessionId as string | undefined) ?? null };
}

/**
 * One decision per stored item, exactly once each, in any order. Validates the
 * edits against the stored action and the S1 bounds. Throws
 * TeamFrontDecisionPayloadError; the proposal is not consumed by a throw.
 */
export function parseTeamFrontDecisions(raw: unknown, proposal: PendingTeamFrontProposal): TeamFrontItemDecision[] {
  if (!isPlainObject(raw)) badPayload('The decision must be an object.');
  const entries = raw.items;
  if (!Array.isArray(entries) || entries.length !== proposal.items.length) {
    badPayload(`decision.items must hold exactly one decision for each of the ${proposal.items.length} proposed items.`);
  }
  const seen = new Set<number>();
  const decisions: TeamFrontItemDecision[] = [];
  for (const [position, entry] of entries.entries()) {
    const where = `decision.items[${position}]`;
    if (!isPlainObject(entry)) badPayload(`${where} must be an object.`);
    assertClosedKeys(entry, ['index', 'decision', 'edits'], where);
    const index = entry.index;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= proposal.items.length) {
      badPayload(`${where}.index does not name a proposed item.`);
    }
    if (seen.has(index)) badPayload(`${where}.index ${index} is decided twice.`);
    seen.add(index);
    if (entry.decision === 'reject') {
      if (entry.edits !== undefined) badPayload(`${where}: a rejected item cannot carry edits.`);
      decisions.push({ index, decision: 'reject' });
      continue;
    }
    if (entry.decision !== 'approve') badPayload(`${where}.decision must be "approve" or "reject".`);
    const edits = entry.edits === undefined ? {} : entry.edits;
    if (!isPlainObject(edits)) badPayload(`${where}.edits must be an object.`);
    const stored = proposal.items[index];
    assertClosedKeys(edits, stored.action === 'create' ? CREATE_EDITABLE : STATUS_EDITABLE, `${where}.edits`);
    // Validate now, so a bad edit is refused before anything is consumed.
    try {
      effectiveItem(stored, edits, index);
    } catch (error) {
      if (error instanceof TeamFrontProposalError) badPayload(error.message);
      throw error;
    }
    decisions.push({ index, decision: 'approve', edits });
  }
  return decisions;
}

/** The stored action with the user's edits applied and re-validated; never anything the renderer named beyond the edits. */
function effectiveItem(stored: ResolvedTeamFrontProposalItem, edits: Record<string, unknown>, index: number): TeamFrontCreateItem | TeamFrontStatusItem {
  if (stored.action === 'create') {
    return parseTeamFrontProposalItem({
      action: 'create',
      title: edits.title ?? stored.title,
      description: edits.description ?? stored.description,
      status: edits.status ?? stored.status,
    }, index) as TeamFrontCreateItem;
  }
  return parseTeamFrontProposalItem({ action: 'status', frontId: stored.frontId, status: edits.status ?? stored.status }, index) as TeamFrontStatusItem;
}

// ---------------------------------------------------------------------------
// The outcome
// ---------------------------------------------------------------------------

export interface TeamFrontItemResult {
  index: number;
  action: 'create' | 'status';
  /** The title the item had when it was decided (create) or the front's title (status). Plain text. */
  label: string;
  /** `unconfirmed`: the write threw and could not be read back, so it may or may not have persisted. */
  result: 'written' | 'rejected' | 'refused' | 'failed' | 'unconfirmed';
  /** The new front's id (create) or the changed front's id (status), when written. */
  id?: string;
  status?: TeamFrontStatus;
  /** Machine-readable cause of a refusal or failure. */
  code?: string;
  /** Human-readable detail of a refusal or failure; plain text, quoted as JSON in the notice. */
  detail?: string;
  /** A written item whose team sharing step did not complete. The item is saved; nothing is retried. */
  syncWarning?: string;
  /** A written item whose save went through but a later step inside the Tracker threw. The item is saved (read back); nothing is retried. */
  followUpWarning?: string;
}

/**
 * What the coordinator is told. Plain text; every value that came from a person
 * or an agent (titles, details, ids) is JSON-quoted, so no markup or
 * instruction can ride in it. Agent-facing; the user sees the same results on
 * the card (S4).
 */
export function buildTeamFrontDecisionNotice(proposalId: string, results: readonly TeamFrontItemResult[]): string {
  const lines = results.map((r) => {
    const subject = `item ${r.index} (${r.action}) ${JSON.stringify(r.label)}`;
    switch (r.result) {
      case 'written':
        return `- ${subject}: written; id ${JSON.stringify(r.id)}, status ${JSON.stringify(r.status)}${r.followUpWarning ? `; a step after saving failed, but the item is saved (read back; nothing was retried): ${JSON.stringify(r.followUpWarning)}` : ''}${r.syncWarning ? `; team sharing did not complete (the item is saved, nothing was retried): ${JSON.stringify(r.syncWarning)}` : ''}`;
      case 'rejected':
        return `- ${subject}: rejected by the user`;
      case 'refused':
        return `- ${subject}: refused (${JSON.stringify(r.code)}); ${JSON.stringify(r.detail)}`;
      case 'unconfirmed':
        return `- ${subject}: UNCONFIRMED; the write may or may not have been saved (item id ${JSON.stringify(r.id)}); ${JSON.stringify(r.detail)}`;
      default:
        return `- ${subject}: failed (${JSON.stringify(r.code)}); ${JSON.stringify(r.detail)}`;
    }
  });
  const written = results.filter((r) => r.result === 'written').length;
  const unconfirmed = results.filter((r) => r.result === 'unconfirmed').length;
  const closing = unconfirmed > 0
    ? 'Items marked written changed the Tracker; items marked UNCONFIRMED may have, and their outcome is unknown: the user must check the Tracker before you propose them (or anything for those fronts) again, and you must not retry them. Refused, failed and rejected items did not change it.'
    : 'Only the items marked written changed anything. A refused item was not written; you may propose it again if it still makes sense.';
  return [
    `The user decided your front proposal ${JSON.stringify(proposalId)}: ${written} of ${results.length} items written${unconfirmed > 0 ? `, ${unconfirmed} unconfirmed` : ''}.`,
    ...lines,
    closing,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------

export interface TeamFrontDeliveryReport {
  card: boolean;
  notice: boolean;
}

export interface TeamFrontDecisionDeps {
  registry: TeamFrontProposalRegistry;
  ports: TeamFrontProposalPorts;
  writer: TeamFrontWriter;
  /** The root's current session row. Rejects when it cannot be read. */
  readRoot: (rootSessionId: string) => Promise<TeamFrontProposeSessionRow | null>;
  withFrontLock: <T>(frontId: string, task: () => Promise<T>) => Promise<T>;
  withCreateLock: <T>(workspaceKey: string, task: () => Promise<T>) => Promise<T>;
  /** Tell the root's transcript and the coordinator. May reject: the caller treats that as a delivery failure only. */
  deliver: (args: { proposal: PendingTeamFrontProposal; results: TeamFrontItemResult[]; notice: string }) => Promise<TeamFrontDeliveryReport>;
}

export type TeamFrontDecisionResponse =
  | { ok: true; proposalId: string; results: TeamFrontItemResult[]; delivery: TeamFrontDeliveryReport }
  | { ok: false; code: 'invalid' | 'expired' | 'forbidden' | 'root-ineligible' | 'unavailable'; message: string };

/** The window's open project that is the proposal's workspace, or null. */
function matchSenderWorkspace(proposalWorkspace: string, senderWorkspaces: string | readonly string[]): string | null {
  const candidates = typeof senderWorkspaces === 'string' ? [senderWorkspaces] : senderWorkspaces;
  return candidates.find((candidate) => sameWorkspaceIdentity(proposalWorkspace, candidate)) ?? null;
}

/** Lock key of a workspace: its canonical spelling, case-folded (over-serialising on a case-sensitive disk is harmless). */
export function teamFrontWorkspaceKey(workspacePath: string): string {
  return path.normalize(resolveCallerWorkspaceId(workspacePath)).toLowerCase();
}

function failureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}...` : message;
}

async function runCreate(
  deps: TeamFrontDecisionDeps,
  proposal: PendingTeamFrontProposal,
  item: TeamFrontCreateItem,
  index: number,
  createdInBatch: Set<string>,
): Promise<TeamFrontItemResult> {
  const base = { index, action: 'create' as const, label: item.title };
  return deps.withCreateLock(teamFrontWorkspaceKey(proposal.workspacePath), async () => {
    // D2 at write time, fresh: every non-archived front (other coordinators' creates
    // included) and every create this batch already made.
    const key = normalizeTeamFrontTitle(item.title);
    const taken = new Set((await deps.ports.listFronts(proposal.workspacePath)).filter((f) => !f.archived).map((f) => normalizeTeamFrontTitle(f.title)));
    if (taken.has(key) || createdInBatch.has(key)) {
      return { ...base, result: 'refused', code: 'duplicate-title', detail: `A front titled "${item.title}" already exists (titles are compared ignoring case).` };
    }
    const created = await deps.writer.createFront({
      workspacePath: proposal.workspacePath,
      title: item.title,
      description: item.description,
      status: item.status,
    });
    createdInBatch.add(key);
    return { ...base, result: 'written', id: created.id, status: item.status, ...(created.syncWarning ? { syncWarning: created.syncWarning } : {}), ...(created.followUpWarning ? { followUpWarning: created.followUpWarning } : {}) };
  });
}

async function runStatusChange(
  deps: TeamFrontDecisionDeps,
  proposal: PendingTeamFrontProposal,
  stored: Extract<ResolvedTeamFrontProposalItem, { action: 'status' }>,
  item: TeamFrontStatusItem,
  index: number,
): Promise<TeamFrontItemResult> {
  const base = { index, action: 'status' as const, label: stored.frontTitle };
  const refused = (code: string, detail: string): TeamFrontItemResult => ({ ...base, result: 'refused', code, detail });
  // The front lock mission creation takes, held through the re-read of the front
  // and of its active mission and the write: a mission cannot start in between.
  return deps.withFrontLock(item.frontId, async () => {
    const front = await deps.ports.getFront(item.frontId, proposal.workspacePath);
    if (!front || front.type !== 'team-front') return refused('front-not-found', `The front "${stored.frontTitle}" no longer exists in this workspace.`);
    if (front.archived) return refused('front-not-changeable', `The front "${front.title}" is archived.`);
    if (front.status === item.status) return refused('no-change', `The front "${front.title}" is already ${item.status}.`);
    const mission = item.status === 'active' ? null : await deps.ports.findActiveMissionRoot(front.id);
    if (mission && item.status === 'closed') {
      return refused('close-with-active-mission', `The front "${front.title}" has an active mission${mission.title ? ` ("${mission.title}")` : ''}; it cannot be closed. Close the mission first.`);
    }
    if (mission && item.status === 'paused' && !stored.activeMission) {
      // The card never warned the user about this mission (it started after the card was shown, or the user changed the status): do not approve silently.
      return refused('mission-started-after-card', `A mission started on "${front.title}" after the proposal was shown, so pausing it was not approved. Propose it again if it still makes sense.`);
    }
    const outcome = await deps.writer.setFrontStatus({ workspacePath: proposal.workspacePath, frontId: front.id, status: item.status });
    return { ...base, label: front.title, result: 'written', id: front.id, status: item.status, ...(outcome?.syncWarning ? { syncWarning: outcome.syncWarning } : {}), ...(outcome?.followUpWarning ? { followUpWarning: outcome.followUpWarning } : {}) };
  });
}

async function runItem(
  deps: TeamFrontDecisionDeps,
  proposal: PendingTeamFrontProposal,
  decision: TeamFrontItemDecision,
  createdInBatch: Set<string>,
): Promise<TeamFrontItemResult> {
  const stored = proposal.items[decision.index];
  const label = stored.action === 'create' ? stored.title : stored.frontTitle;
  const base = { index: decision.index, action: stored.action, label };
  if (decision.decision === 'reject') return { ...base, result: 'rejected' };
  try {
    const item = effectiveItem(stored, decision.edits, decision.index);
    if (item.action === 'create') return await runCreate(deps, proposal, item, decision.index, createdInBatch);
    return await runStatusChange(deps, proposal, stored as Extract<ResolvedTeamFrontProposalItem, { action: 'status' }>, item, decision.index);
  } catch (error) {
    // The write may have persisted: never reported as failed, never retried.
    if (error instanceof TeamFrontWriteUnconfirmedError) {
      return { ...base, result: 'unconfirmed', id: error.itemId, code: 'write-unconfirmed', detail: failureDetail(error) };
    }
    return { ...base, result: 'failed', code: 'write-failed', detail: failureDetail(error) };
  }
}

/**
 * Decide a proposal. `senderWorkspace` is the workspace the HOST knows the
 * sending window shows (teamFrontProposalSender.ts); the payload names none.
 */
export async function decideTeamFrontProposal(
  deps: TeamFrontDecisionDeps,
  senderWorkspaces: string | readonly string[],
  rawPayload: unknown,
): Promise<TeamFrontDecisionResponse> {
  // 1. Closed shape and stored-proposal checks, none of which consumes anything.
  let named: { proposalId: string; rootSessionId: string | null };
  try {
    named = readDecisionProposalId(rawPayload);
  } catch (error) {
    return { ok: false, code: 'invalid', message: failureDetail(error) };
  }
  const proposal = deps.registry.get(named.proposalId);
  if (!proposal) return { ok: false, code: 'expired', message: 'This proposal is no longer pending.' };
  // The root's workspace must be one the sending window has open (host state); which one it is binds the settle below.
  const senderWorkspace = matchSenderWorkspace(proposal.workspacePath, senderWorkspaces);
  if (senderWorkspace === null || (named.rootSessionId !== null && named.rootSessionId !== proposal.rootSessionId)) {
    return { ok: false, code: 'forbidden', message: 'This proposal does not belong to this window.' };
  }
  let decisions: TeamFrontItemDecision[];
  try {
    decisions = parseTeamFrontDecisions(rawPayload, proposal);
  } catch (error) {
    if (error instanceof TeamFrontDecisionPayloadError) return { ok: false, code: 'invalid', message: error.message };
    throw error;
  }

  // 2. The root must still be a live team root of this workspace.
  let root: TeamFrontProposeSessionRow | null;
  try {
    root = await deps.readRoot(proposal.rootSessionId);
  } catch {
    return { ok: false, code: 'unavailable', message: 'The team session could not be verified. Try again.' };
  }
  try {
    assertTeamRoot(root, proposal.workspacePath);
  } catch (error) {
    deps.registry.discard(proposal.id);
    return { ok: false, code: 'root-ineligible', message: error instanceof Error ? error.message : 'The team session is no longer a live team root.' };
  }

  // 3. Settle once. A mismatch (or a concurrent submit that won) writes nothing.
  const taken = deps.registry.take(proposal.id, { rootSessionId: proposal.rootSessionId, workspacePath: senderWorkspace });
  if (!taken.ok) {
    return taken.reason === 'unknown'
      ? { ok: false, code: 'expired', message: 'This proposal is no longer pending.' }
      : { ok: false, code: 'forbidden', message: 'This proposal does not belong to this window.' };
  }

  // 4. Execute, item by item, in the order proposed.
  const createdInBatch = new Set<string>();
  const results: TeamFrontItemResult[] = [];
  for (const decision of [...decisions].sort((a, b) => a.index - b.index)) {
    results.push(await runItem(deps, taken.proposal, decision, createdInBatch));
  }

  // 5. Tell the coordinator. The writes are done: nothing below repeats them or hides them.
  let delivery: TeamFrontDeliveryReport = { card: false, notice: false };
  try {
    delivery = await deps.deliver({ proposal: taken.proposal, results, notice: buildTeamFrontDecisionNotice(taken.proposal.id, results) });
  } catch (error) {
    console.warn('[team] Front proposal decided and written, but the outcome could not be delivered:', error);
  }
  return { ok: true, proposalId: taken.proposal.id, results, delivery };
}

// ---------------------------------------------------------------------------
// State (read-only)
// ---------------------------------------------------------------------------

export type TeamFrontProposalStateResponse =
  | { ok: true; state: 'pending'; proposalId: string; items: readonly ResolvedTeamFrontProposalItem[] }
  | { ok: true; state: 'expired' }
  | { ok: false; code: 'invalid'; message: string };

/**
 * Whether a card can still be decided, for the widget (a restart or a settled
 * card says expired). Read-only and workspace-bound: a proposal of another
 * workspace is reported exactly like one that does not exist.
 */
export function getTeamFrontProposalState(
  registry: TeamFrontProposalRegistry,
  senderWorkspaces: string | readonly string[],
  rawPayload: unknown,
): TeamFrontProposalStateResponse {
  if (!isPlainObject(rawPayload) || Object.keys(rawPayload).some((key) => key !== 'proposalId')
    || typeof rawPayload.proposalId !== 'string' || !/^tfp_[0-9a-f-]{36}$/.test(rawPayload.proposalId)) {
    return { ok: false, code: 'invalid', message: 'The request must be {proposalId}.' };
  }
  const proposal = registry.get(rawPayload.proposalId);
  if (!proposal || matchSenderWorkspace(proposal.workspacePath, senderWorkspaces) === null) return { ok: true, state: 'expired' };
  return { ok: true, state: 'pending', proposalId: proposal.id, items: proposal.items };
}
