/**
 * Front proposals (F1.1, M-13): the contract between the Team coordinator and
 * the user. The coordinator PROPOSES team-fronts (new ones, or a new status for
 * an existing one); the user decides on a card in the coordinator's transcript;
 * the host writes. This module is the first third of that: the closed argument
 * contract, the proposal-time rules, and the in-memory one-shot registry the
 * decision (S3) will consume. It writes nothing: no tracker item, no session.
 *
 * Rules enforced here, at proposal time (and re-checked at write time by S3):
 *  - the arguments are a closed shape; an unknown key, `currentMission`, a
 *    control character or an oversize value refuses the whole proposal;
 *  - D2 (NIB.180): a create whose title equals, case-insensitively, a
 *    non-archived team-front title (or another create in the same batch) is
 *    refused;
 *  - D1 (NIB.180): closing a front that has an active mission is refused;
 *    pausing it is allowed and the card carries a warning;
 *  - one pending proposal per root; a card is settled once (one-shot), and only
 *    by the root and workspace it was registered for.
 *
 * The registry is memory only on purpose: a restart leaves no approvable card
 * (R7), and nothing about a proposal is trusted from the renderer: the front id
 * and the values a decision applies come from what is stored here.
 */

import { randomUUID } from 'node:crypto';
import { TEAM_FRONT_DESCRIPTION_MAX_CHARS, TEAM_FRONT_STATUSES, TEAM_FRONT_TYPE } from '@nimbalyst/tracker-core';
import { sameWorkspaceIdentity } from '../../utils/workspaceIdentity';
import type { TeamMissionPorts } from './teamMissions';

export const TEAM_FRONT_PROPOSAL_MAX_ITEMS = 10;
export const TEAM_FRONT_PROPOSAL_TITLE_MAX_CHARS = 120;
export const TEAM_FRONT_PROPOSAL_DESCRIPTION_MAX_CHARS = TEAM_FRONT_DESCRIPTION_MAX_CHARS;
const FRONT_ID_MAX_CHARS = 128;
const FRONT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type TeamFrontStatus = (typeof TEAM_FRONT_STATUSES)[number];

export type TeamFrontProposalErrorCode =
  | 'invalid-arguments'
  | 'duplicate-title'
  | 'front-not-found'
  | 'front-not-changeable'
  | 'no-change'
  | 'close-with-active-mission'
  | 'proposal-pending';

export class TeamFrontProposalError extends Error {
  constructor(readonly code: TeamFrontProposalErrorCode, message: string) {
    super(message);
    this.name = 'TeamFrontProposalError';
  }
}

function invalid(message: string): never {
  throw new TeamFrontProposalError('invalid-arguments', message);
}

// ---------------------------------------------------------------------------
// The closed argument contract
// ---------------------------------------------------------------------------

export interface TeamFrontCreateItem {
  action: 'create';
  title: string;
  description: string;
  status: TeamFrontStatus;
}

export interface TeamFrontStatusItem {
  action: 'status';
  frontId: string;
  status: TeamFrontStatus;
}

export type TeamFrontProposalItem = TeamFrontCreateItem | TeamFrontStatusItem;

/**
 * A status item as it is shown to the user and stored: the host adds what it
 * read of the front (title, current status) and the pause warning. These
 * fields come from the tracker, never from the agent.
 */
export interface ResolvedTeamFrontStatusItem extends TeamFrontStatusItem {
  frontTitle: string;
  fromStatus: string | null;
  /** Pausing a front that has an active mission is allowed, with this warning. */
  activeMission: { title: string | null } | null;
}

export type ResolvedTeamFrontProposalItem = TeamFrontCreateItem | ResolvedTeamFrontStatusItem;

// C0 and C1 controls, line/paragraph separators and bidirectional overrides: none
// may reach a card or a notice. A description is a multi-line template, so it
// keeps tab, line feed and carriage return; a title keeps none.

const SEPARATORS_AND_BIDI = '\u2028\u2029\u202A-\u202E\u2066-\u2069';
// A title also refuses every Unicode format character (\p{Cf}: zero-width, BOM, soft hyphen, invisible
// operators, bidi, tag characters) and the blank-looking Hangul fillers U+3164, U+115F and U+1160: invisible,
// they would make two titles that look identical differ for D2. A description keeps its looser rule.
const TITLE_FORBIDDEN = new RegExp(`[\u0000-\u001F\u007F-\u009F\\p{Cf}\u3164\u115F\u1160${SEPARATORS_AND_BIDI}]`, 'u');
const DESCRIPTION_FORBIDDEN = new RegExp(`[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F${SEPARATORS_AND_BIDI}]`);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertKeys(record: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(record)) {
    if (key === 'currentMission') {
      invalid(`${where}: currentMission is written only by Nimbalyst and cannot be proposed.`);
    }
    if (!allowed.includes(key)) {
      invalid(`${where}: unknown key "${key}". Allowed: ${allowed.join(', ')}.`);
    }
  }
}

function requireString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== 'string') invalid(`${where}: ${key} must be a string.`);
  return value;
}

function parseStatus(value: unknown, where: string): TeamFrontStatus {
  if (typeof value !== 'string' || !(TEAM_FRONT_STATUSES as readonly string[]).includes(value)) {
    invalid(`${where}: status must be one of: ${TEAM_FRONT_STATUSES.join(', ')}.`);
  }
  return value as TeamFrontStatus;
}

/** Parse one item with the contract's bounds (also used to validate a user's edits, F1.1 S3). */
export function parseTeamFrontProposalItem(raw: unknown, index: number): TeamFrontProposalItem {
  const where = `items[${index}]`;
  if (!isPlainObject(raw)) invalid(`${where} must be an object.`);
  const action = raw.action;
  if (action === 'create') {
    assertKeys(raw, ['action', 'title', 'description', 'status'], where);
    const title = requireString(raw, 'title', where).trim();
    if (!title) invalid(`${where}: title must not be empty.`);
    if (title.length > TEAM_FRONT_PROPOSAL_TITLE_MAX_CHARS) {
      invalid(`${where}: title is ${title.length} characters; the limit is ${TEAM_FRONT_PROPOSAL_TITLE_MAX_CHARS}.`);
    }
    if (TITLE_FORBIDDEN.test(title)) invalid(`${where}: title must not contain control or invisible characters.`);
    const description = requireString(raw, 'description', where).trim();
    if (!description) invalid(`${where}: description must not be empty (it is the state of the front).`);
    if (description.length > TEAM_FRONT_PROPOSAL_DESCRIPTION_MAX_CHARS) {
      invalid(`${where}: description is ${description.length} characters; the limit is ${TEAM_FRONT_PROPOSAL_DESCRIPTION_MAX_CHARS}.`);
    }
    if (DESCRIPTION_FORBIDDEN.test(description)) invalid(`${where}: description must not contain control characters.`);
    const status = raw.status === undefined ? 'active' : parseStatus(raw.status, where);
    return { action: 'create', title, description, status };
  }
  if (action === 'status') {
    assertKeys(raw, ['action', 'frontId', 'status'], where);
    const frontId = requireString(raw, 'frontId', where);
    if (frontId.length > FRONT_ID_MAX_CHARS || !FRONT_ID_PATTERN.test(frontId)) {
      invalid(`${where}: frontId must be the id of a team-front item (letters, digits, "-", "_" and "."), not a title.`);
    }
    if (raw.status === undefined) invalid(`${where}: status is required.`);
    return { action: 'status', frontId, status: parseStatus(raw.status, where) };
  }
  return invalid(`${where}: action must be "create" or "status".`);
}

/** Parse the tool arguments into items. Pure: no I/O, nothing stored. Throws TeamFrontProposalError. */
export function parseTeamFrontProposalArgs(raw: unknown): TeamFrontProposalItem[] {
  if (!isPlainObject(raw)) invalid('The arguments must be an object with an "items" array.');
  assertKeys(raw, ['items'], 'arguments');
  const items = raw.items;
  if (!Array.isArray(items) || items.length === 0) invalid('items must be a non-empty array.');
  if (items.length > TEAM_FRONT_PROPOSAL_MAX_ITEMS) {
    invalid(`items has ${items.length} entries; the limit is ${TEAM_FRONT_PROPOSAL_MAX_ITEMS} per proposal.`);
  }
  return items.map((item, index) => parseTeamFrontProposalItem(item, index));
}

// ---------------------------------------------------------------------------
// Proposal-time rules (D1, D2, existence)
// ---------------------------------------------------------------------------

/** The comparison key of a front title: D2 is "equal, ignoring case and spacing". */
export function normalizeTeamFrontTitle(title: string): string {
  return title.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

export interface TeamFrontListEntry {
  id: string;
  title: string;
  status: string | null;
  archived: boolean;
}

/** What the proposal rules read of the tracker. Read-only: nothing here writes. */
export interface TeamFrontProposalPorts {
  getFront: TeamMissionPorts['getFront'];
  findActiveMissionRoot: TeamMissionPorts['findActiveMissionRoot'];
  /** Every team-front of the workspace, archived ones included (the caller filters). */
  listFronts(workspaceId: string): Promise<TeamFrontListEntry[]>;
}

/**
 * Apply D1, D2 and the existence rules to parsed items and return the items the
 * card will show. Throws on the first violation, naming the item.
 */
export async function validateTeamFrontProposal(
  items: readonly TeamFrontProposalItem[],
  workspaceId: string,
  ports: TeamFrontProposalPorts,
): Promise<ResolvedTeamFrontProposalItem[]> {
  const taken = new Set(
    (await ports.listFronts(workspaceId)).filter((front) => !front.archived).map((front) => normalizeTeamFrontTitle(front.title)),
  );
  const seenCreates = new Set<string>();
  const seenFronts = new Set<string>();
  const resolved: ResolvedTeamFrontProposalItem[] = [];
  for (const [index, item] of items.entries()) {
    const where = `items[${index}]`;
    if (item.action === 'create') {
      const key = normalizeTeamFrontTitle(item.title);
      if (seenCreates.has(key)) {
        throw new TeamFrontProposalError('duplicate-title', `${where}: another item of this proposal creates a front with the same title (ignoring case): "${item.title}".`);
      }
      if (taken.has(key)) {
        throw new TeamFrontProposalError('duplicate-title', `${where}: a front titled "${item.title}" already exists (titles are compared ignoring case). Propose a status change for it, or choose another title.`);
      }
      seenCreates.add(key);
      resolved.push({ ...item });
      continue;
    }
    if (seenFronts.has(item.frontId)) {
      throw new TeamFrontProposalError('invalid-arguments', `${where}: front ${item.frontId} appears twice in this proposal.`);
    }
    seenFronts.add(item.frontId);
    const front = await ports.getFront(item.frontId, workspaceId);
    if (!front || front.type !== TEAM_FRONT_TYPE) {
      throw new TeamFrontProposalError('front-not-found', `${where}: no team-front with id ${item.frontId} in this workspace.`);
    }
    if (front.archived) {
      throw new TeamFrontProposalError('front-not-changeable', `${where}: front "${front.title}" is archived; its status cannot be changed.`);
    }
    if (front.status === item.status) {
      throw new TeamFrontProposalError('no-change', `${where}: front "${front.title}" is already ${item.status}.`);
    }
    // Read for every target: a reactivation the user later edits to a pause must carry the warning the user
    // was shown, so the write step can tell a mission that was already there from one that started later.
    const mission = await ports.findActiveMissionRoot(front.id);
    if (mission && item.status === 'closed') {
      throw new TeamFrontProposalError(
        'close-with-active-mission',
        `${where}: front "${front.title}" has an active mission${mission.title ? ` ("${mission.title}")` : ''} and cannot be closed by a proposal. Close the mission first, or propose pausing the front.`,
      );
    }
    resolved.push({
      ...item,
      frontTitle: front.title,
      fromStatus: front.status,
      activeMission: mission ? { title: mission.title } : null,
    });
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// The one-shot registry
// ---------------------------------------------------------------------------

export interface PendingTeamFrontProposal {
  readonly id: string;
  readonly rootSessionId: string;
  readonly workspacePath: string;
  readonly items: readonly ResolvedTeamFrontProposalItem[];
  readonly createdAt: number;
}

export type TakeTeamFrontProposalResult =
  | { ok: true; proposal: PendingTeamFrontProposal }
  | { ok: false; reason: 'unknown' | 'mismatch' };

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Proposals awaiting the user, in memory. A proposal is bound to the root
 * session and the workspace it was posted for, is settled at most once, and
 * there is at most one pending proposal per root. Its content is frozen: what
 * the user sees is what the decision applies.
 */
export class TeamFrontProposalRegistry {
  private readonly byId = new Map<string, PendingTeamFrontProposal>();
  private readonly byRoot = new Map<string, string>();

  register(args: {
    rootSessionId: string;
    workspacePath: string;
    items: readonly ResolvedTeamFrontProposalItem[];
    now?: number;
  }): PendingTeamFrontProposal {
    if (this.byRoot.has(args.rootSessionId)) {
      throw new TeamFrontProposalError(
        'proposal-pending',
        'A front proposal is already waiting for the user\'s decision. Wait for Nimbalyst to report the result before proposing again.',
      );
    }
    const proposal = deepFreeze<PendingTeamFrontProposal>({
      id: `tfp_${randomUUID()}`,
      rootSessionId: args.rootSessionId,
      workspacePath: args.workspacePath,
      items: structuredClone(args.items),
      createdAt: args.now ?? Date.now(),
    });
    this.byId.set(proposal.id, proposal);
    this.byRoot.set(proposal.rootSessionId, proposal.id);
    return proposal;
  }

  get(proposalId: string): PendingTeamFrontProposal | null {
    return this.byId.get(proposalId) ?? null;
  }

  pendingForRoot(rootSessionId: string): PendingTeamFrontProposal | null {
    const id = this.byRoot.get(rootSessionId);
    return id ? this.byId.get(id) ?? null : null;
  }

  /**
   * Settle a proposal: returns it and forgets it, once. A caller that is not
   * the root and workspace it was registered for gets `mismatch` and the
   * proposal stays pending (a foreign or forged attempt must not burn it).
   */
  take(proposalId: string, binding: { rootSessionId: string; workspacePath: string }): TakeTeamFrontProposalResult {
    const proposal = this.byId.get(proposalId);
    if (!proposal) return { ok: false, reason: 'unknown' };
    if (proposal.rootSessionId !== binding.rootSessionId || !sameWorkspaceIdentity(proposal.workspacePath, binding.workspacePath)) {
      return { ok: false, reason: 'mismatch' };
    }
    this.discard(proposalId);
    return { ok: true, proposal };
  }

  discard(proposalId: string): void {
    const proposal = this.byId.get(proposalId);
    if (!proposal) return;
    this.byId.delete(proposalId);
    if (this.byRoot.get(proposal.rootSessionId) === proposalId) this.byRoot.delete(proposal.rootSessionId);
  }

  /** Drop whatever a root has pending (the root was archived or stopped). */
  discardRoot(rootSessionId: string): void {
    const id = this.byRoot.get(rootSessionId);
    if (id) this.discard(id);
  }

  size(): number {
    return this.byId.size;
  }
}

/** The app's registry: one per process, so a restart leaves no approvable card. */
export const teamFrontProposalRegistry = new TeamFrontProposalRegistry();
