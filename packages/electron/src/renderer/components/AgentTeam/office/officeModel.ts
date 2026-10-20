/**
 * Office view-model (POC F1): a pure projection of state the renderer already
 * has. Nothing here is stored or sent anywhere; it is recalculated from the
 * session registry and the per-session atoms on every change.
 *
 * Only what the current state can assert is derived:
 * - principal state: from the member's own processing flag and an error not
 *   yet seen (`sessionProcessingAtom`, `sessionErrorAtom`). The error atom is
 *   cleared only when the session's transcript shows it, and it is lost on
 *   reload: "error" therefore means "an error this window received and the
 *   user has not opened yet", not "the last turn failed";
 * - waiting-for-you marker: from the durable pending-prompt bit
 *   (`sessionHasPendingInteractivePromptAtom`), with the prompt kind only when
 *   the pending prompt list (`sessionPendingPromptsAtom`) already names it.
 *
 * Deliberately absent, because no structured state exists for them: member
 * completion, "blocked", "waiting for a child", advisor availability, required
 * independent review, reviewer verdicts. Nothing is read from message text.
 */

import type { SessionMeta } from '@nimbalyst/runtime';
import type { PendingPrompt } from '../../../store/atoms/sessions';
import { teamTreeMembers, type TeamTreeNode } from '../agentTeamGraph';
import { isTeamRoot, teamMemberRole, type TeamMemberRole } from '../teamMembership';

export const OFFICE_PRINCIPAL_STATES = ['working', 'error', 'idle'] as const;
export type OfficePrincipalState = (typeof OFFICE_PRINCIPAL_STATES)[number];

export const OFFICE_WAITING_KINDS = ['question', 'input', 'permission', 'commit', 'plan', 'unknown'] as const;
export type OfficeWaitingKind = (typeof OFFICE_WAITING_KINDS)[number];

/** Raw per-session signals, read from existing atoms only. */
export interface OfficeMemberSignals {
  /** sessionProcessingAtom: a turn of this session is open (its own, not its children's). */
  processing: boolean;
  /** sessionHasPendingInteractivePromptAtom: the session waits for the user. */
  awaitingUser: boolean;
  /** promptType of each entry in sessionPendingPromptsAtom, when already loaded. */
  pendingPromptTypes: readonly PendingPrompt['promptType'][];
  /** sessionErrorAtom is set: an error was reported and not yet shown in the transcript. */
  errorReported: boolean;
}

export const NO_SIGNALS: OfficeMemberSignals = {
  processing: false,
  awaitingUser: false,
  pendingPromptTypes: [],
  errorReported: false,
};

export interface OfficeMemberView {
  sessionId: string;
  title: string;
  /** 'coordinator' for a Team mode root, the member role for a member, null otherwise. */
  role: 'coordinator' | TeamMemberRole | null;
  isRoot: boolean;
  provider: string;
  model?: string;
  effortLevel?: string;
  /**
   * SessionMeta.teamMission: the mission the host stored when the member was
   * created (metadata.teamChild.mission, immutable). Undefined when there is
   * none; never derived from titles or messages.
   */
  mission?: string;
  /** createdBySessionId when the creator is another member, not the root. */
  createdBySessionId?: string;
  principal: OfficePrincipalState;
  /** Present only while the session waits for the user; never replaces `principal`. */
  waitingUser: OfficeWaitingKind[] | null;
  /** The session currently shown in the Agent mode panel (activeSessionIdAtom). */
  isActiveSession: boolean;
}

export interface OfficeRoomView {
  rootId: string;
  title: string;
  isTeamModeRoot: boolean;
  members: OfficeMemberView[];
  /**
   * Members working and not stopped on the user. A session waiting for the
   * user keeps its turn open (processing stays true), so it is counted under
   * waitingUserCount instead of here; its principal state is unchanged.
   */
  workingCount: number;
  waitingUserCount: number;
  errorCount: number;
}

/**
 * A running turn wins over an unseen error: the error atom is only cleared
 * when the transcript shows it, so while a new turn runs it is the current
 * truth. Once that turn ends, the unseen error shows again until opened.
 */
export function officePrincipalState(signals: OfficeMemberSignals): OfficePrincipalState {
  if (signals.processing) return 'working';
  if (signals.errorReported) return 'error';
  return 'idle';
}

const WAITING_KIND_BY_PROMPT: Record<PendingPrompt['promptType'], OfficeWaitingKind> = {
  ask_user_question_request: 'question',
  request_user_input_request: 'input',
  permission_request: 'permission',
  git_commit_proposal_request: 'commit',
  exit_plan_mode_request: 'plan',
};

/**
 * The marker follows the same durable bit as the sidebar and the Tree, so the
 * views never disagree; the kind is added only when the prompt list names it.
 */
export function officeWaitingKinds(signals: OfficeMemberSignals): OfficeWaitingKind[] | null {
  if (!signals.awaitingUser) return null;
  const kinds: OfficeWaitingKind[] = [];
  for (const promptType of signals.pendingPromptTypes) {
    const kind = WAITING_KIND_BY_PROMPT[promptType];
    if (kind && !kinds.includes(kind)) kinds.push(kind);
  }
  return kinds.length > 0 ? kinds : ['unknown'];
}

function memberRole(session: SessionMeta, isRoot: boolean): OfficeMemberView['role'] {
  if (isRoot && isTeamRoot(session)) return 'coordinator';
  return session.teamRole ? teamMemberRole(session) : null;
}

/** Every session of a delegation tree, root first, in the Tree's order. */
export function officeRoomSessions(root: TeamTreeNode): SessionMeta[] {
  return [root.session, ...teamTreeMembers(root)];
}

export function buildOfficeRoom(
  root: TeamTreeNode,
  signalsById: ReadonlyMap<string, OfficeMemberSignals>,
  activeSessionId: string | null,
  untitled: string,
): OfficeRoomView {
  const rootId = root.session.id;
  const members = officeRoomSessions(root).map((session): OfficeMemberView => {
    const isRoot = session.id === rootId;
    const signals = signalsById.get(session.id) ?? NO_SIGNALS;
    const creatorId = session.createdBySessionId;
    return {
      sessionId: session.id,
      title: session.title || untitled,
      role: memberRole(session, isRoot),
      isRoot,
      provider: session.provider,
      model: session.model,
      effortLevel: session.effortLevel,
      mission: session.teamMission?.trim() || undefined,
      createdBySessionId: !isRoot && creatorId && creatorId !== rootId ? creatorId : undefined,
      principal: officePrincipalState(signals),
      waitingUser: officeWaitingKinds(signals),
      isActiveSession: activeSessionId === session.id,
    };
  });
  return {
    rootId,
    title: root.session.title || untitled,
    isTeamModeRoot: isTeamRoot(root.session),
    members,
    workingCount: members.filter((member) => member.principal === 'working' && member.waitingUser === null).length,
    waitingUserCount: members.filter((member) => member.waitingUser !== null).length,
    errorCount: members.filter((member) => member.principal === 'error').length,
  };
}
