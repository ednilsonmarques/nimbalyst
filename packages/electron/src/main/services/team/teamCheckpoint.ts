/**
 * The Team checkpoint card: what the user sees in the team root's transcript
 * when a creation is refused because the team used its authorized budget.
 *
 * The card is a synthetic `nimbalyst_tool_use` row (the transcript renders it
 * with TeamCheckpointWidget) and its outcome a `nimbalyst_tool_result` row.
 * Both are display only: the authorization itself lives in the root's
 * `metadata.teamBudget` and is written by `authorizeTeamContinuation`.
 *
 * Deliberately NOT an interactive prompt (permission / question): those can be
 * answered by any session of the workspace through `respond_to_prompt`, which
 * would let a coordinator approve its own budget.
 */

import { BrowserWindow } from 'electron';
import { AgentMessagesRepository } from '@nimbalyst/runtime/storage/repositories/AgentMessagesRepository';
import {
  TEAM_CHECKPOINT_PROMPT_ORIGIN,
  TEAM_CHECKPOINT_TOOL_NAME,
} from '@nimbalyst/runtime/ai/server/providers/teamContext';
import { t } from '@nimbalyst/runtime/i18n';
import { database as databaseWorker } from '../../database/PGLiteDatabaseWorker';
import { TEAM_LIMITS } from './teamPolicy';

/** One card per authorized level, so a refused retry never posts a second one. */
export function teamCheckpointCardId(rootSessionId: string, authorized: number): string {
  return `team-checkpoint-${rootSessionId}-${authorized}`;
}

export interface TeamCheckpointCardInput {
  rootSessionId: string;
  /** Sessions the team has created so far. */
  created: number;
  /** Sessions the team is authorized to create (the level it just reached). */
  authorized: number;
  /** Sessions one "Continue team" adds. */
  extension: number;
  /** Unchanged by continuing: sessions that may be active at once. */
  maxActive: number;
}

export interface TeamCheckpointDeps {
  hasCard: (rootSessionId: string, cardId: string) => Promise<boolean>;
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

const productionDeps: TeamCheckpointDeps = {
  hasCard: async (rootSessionId, cardId) => {
    const { rows } = await databaseWorker.query<{ id: unknown }>(
      `SELECT id FROM ai_agent_messages WHERE session_id = $1 AND content LIKE $2 LIMIT 1`,
      [rootSessionId, `%"id":"${cardId}"%`],
    );
    return rows.length > 0;
  },
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

/**
 * Show the checkpoint in the root's transcript, once per authorized level.
 * Best-effort: a failure here must never replace the refusal the caller is
 * about to return to the model.
 */
export async function postTeamCheckpointCard(
  args: { rootSessionId: string; workspacePath: string; created: number; authorized: number },
  deps: TeamCheckpointDeps = productionDeps,
): Promise<void> {
  const cardId = teamCheckpointCardId(args.rootSessionId, args.authorized);
  try {
    if (await deps.hasCard(args.rootSessionId, cardId)) return;
    const input: TeamCheckpointCardInput = {
      rootSessionId: args.rootSessionId,
      created: args.created,
      authorized: args.authorized,
      extension: TEAM_LIMITS.budgetExtension,
      maxActive: TEAM_LIMITS.maxActive,
    };
    await deps.createMessage({
      sessionId: args.rootSessionId,
      source: 'claude-code',
      direction: 'output',
      content: JSON.stringify({ type: 'nimbalyst_tool_use', id: cardId, name: TEAM_CHECKPOINT_TOOL_NAME, input }),
      hidden: false,
      createdAt: deps.now(),
    });
    deps.notifyMessageLogged(args.rootSessionId, args.workspacePath);
  } catch (error) {
    console.warn('[team] Failed to post the Team checkpoint card:', error);
  }
}

/** Mark the card of the level the user just continued from as done. Best-effort. */
export async function resolveTeamCheckpointCard(
  args: { rootSessionId: string; workspacePath: string; previousAuthorized: number; authorized: number },
  deps: TeamCheckpointDeps = productionDeps,
): Promise<void> {
  try {
    await deps.createMessage({
      sessionId: args.rootSessionId,
      source: 'claude-code',
      direction: 'output',
      content: JSON.stringify({
        type: 'nimbalyst_tool_result',
        tool_use_id: teamCheckpointCardId(args.rootSessionId, args.previousAuthorized),
        result: JSON.stringify({ continued: true, authorized: args.authorized }),
        is_error: false,
      }),
      hidden: false,
      createdAt: deps.now(),
    });
    deps.notifyMessageLogged(args.rootSessionId, args.workspacePath);
  } catch (error) {
    console.warn('[team] Failed to resolve the Team checkpoint card:', error);
  }
}

/**
 * The checkpoint action's name as the user sees it on the card, in the UI
 * language. The refusal carries it so the coordinator names a button that
 * exists ("Continuar equipe" in pt-BR, "Continue team" in English).
 */
export function teamContinueActionLabel(): string {
  return t('ai:teamCheckpoint.continue');
}

/**
 * What the coordinator is told once the user continues the team. Written in
 * the UI language: the user reads it in the transcript (as a system status
 * line, see TEAM_CHECKPOINT_PROMPT_ORIGIN), and the coordinator understands it
 * either way.
 */
export function buildTeamContinuationNotice(args: { total: number; authorized: number }): string {
  return t('ai:teamCheckpoint.notice', {
    authorized: args.authorized,
    total: args.total,
    maxActive: TEAM_LIMITS.maxActive,
    maxDepth: TEAM_LIMITS.maxDepth,
  });
}

/** How the notice is queued: system provenance, shown as a status line. */
export const TEAM_CONTINUATION_NOTICE_CONTEXT = Object.freeze({
  promptOrigin: TEAM_CHECKPOINT_PROMPT_ORIGIN,
  promptProvenance: Object.freeze({ actor: 'system', origin: 'session-orchestration', messageKind: 'status' } as const),
});
