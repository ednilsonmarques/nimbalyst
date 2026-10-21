import type { OrchestrationMessageKind } from '@nimbalyst/runtime/ai/server/types';
import path from 'path';
import * as fs from 'fs';
import { CODEX_MIN_CLI_VERSION, isCodexCliVersionSupported } from '@nimbalyst/runtime/ai/server/providers/codex/codexRestrictedProcess';
import { sessionAuthorizedRoot } from '../mcp/sessionToolPolicy';
import { BrowserWindow } from 'electron';
import { randomUUID } from 'crypto';
import { safeHandle } from '../utils/ipcRegistry';
import { SessionManager } from '@nimbalyst/runtime/ai/server';
import type { AgentMessage, AIProviderType, PromptProvenance } from '@nimbalyst/runtime/ai/server/types';
import { ModelIdentifier } from '@nimbalyst/runtime/ai/server/types';
import {
  EFFORT_LEVELS,
  clampEffortLevel,
  type EffortLevel,
} from '@nimbalyst/runtime/ai/server/effortLevels';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { AgentMessagesRepository } from '@nimbalyst/runtime/storage/repositories/AgentMessagesRepository';
import { SessionFilesRepository } from '@nimbalyst/runtime/storage/repositories/SessionFilesRepository';
import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';
import { getDefaultAIModel, isTrackersAgentToolsEnabled } from '../utils/store';
import { resolveStoredWorkspaceId, sameWorkspaceIdentity } from '../utils/workspaceIdentity';
import {
  assertChildSpawnCapacity,
  assertTeamSpawnCapacity,
  authorizeTeamContinuation,
  getSessionStatusRow as querySessionStatusRow,
  getSpawnedSessionRows,
  type TeamContinuationResult,
} from './metaAgentSessionQueries';
import { toMillis } from '../utils/timestampUtils';
import { createWorktreeStore } from './WorktreeStore';
import { GitWorktreeService } from './GitWorktreeService';
import { database as databaseWorker } from '../database/PGLiteDatabaseWorker';
import { getDatabase } from '../database/initialize';
import { gitRefWatcher } from '../file/GitRefWatcher';
import { AIService } from './ai/AIService';
import { setMetaAgentToolFns } from '../mcp/metaAgentServer';
import { computeNotificationSignature } from './metaAgentNotificationSignature';
import { deletePendingChildUpdates, deletePendingToolManifestNotices } from './ai/pendingChildUpdates';
import { inheritedOwnership, isParentNotificationSuppressed } from './extensionSessions/sessionOwnership';
import { startExtensionSessionService } from './extensionSessions/extensionSessionsService';
import { broadcastSessionCreated } from './session/broadcastSessionCreated';
import { extractMessageText, extractUserPrompts } from './metaAgentMessageText';
import { TEAM_CHILD_METADATA_KEY, resolveTeamContext, type TeamRole } from '@nimbalyst/runtime/ai/server/providers/teamContext';
import { renderArchitectReportForUpdate } from '@nimbalyst/runtime/ai/server/providers/toolManifest';
import { TOOL_MANIFEST_NOTICE_CONTEXT, buildToolManifestNotice, buildToolManifestReference, persistArchitectManifest } from './team/toolManifests';
import { withToolManifestTrackerPort } from './team/toolManifestTrackerPort';
import {
  buildTeamChild,
  callerWorktreeRequest,
  resolveRequestedMemberTitle,
  resolveRequestedTeamMission,
  resolveRequestedTeamRole,
  resolveTeamCaller,
  teamRoleDefaultEffort,
  teamRoleDefaultModel,
  resolveChildToolScopeRequest,
  resolveTeamMemberProvider,
  teamMemberProviderRefusal,
  teamProviderDiversity,
  teamRoleProvider,
  teamRoleModelForProvider,
  type TeamMemberProviderCheck,
  TEAM_LIMITS,
  TeamBudgetReachedError,
  type TeamCaller,
  type TeamMemberProviderRequest,
  type TeamProviderDiversity,
} from './team/teamPolicy';
import { describeTeamMemberProvider, teamMemberProviderReadiness } from './team/teamProviders';
import { applySessionTitleThroughNaming } from '../mcp/sessionNamingServer';
import { resolveChildToolScope, type ChildToolScope } from '@nimbalyst/runtime/ai/server/providers/claudeCode/toolPolicy';
import { isKnownCodexModelId } from '@nimbalyst/runtime/ai/server/providers/codex/codexModelCatalog';

/**
 * Consecutive error settles of one Team mode member that wake its coordinator
 * before the member settles successfully again. Each one is a distinct failure
 * (a repeated event of the same failure is dropped by the signature gate); the
 * limit only stops a coordinator/member pair that keeps failing in a loop.
 */
const TEAM_ERROR_WAKE_LIMIT = 3;

/** Newest stored messages read to build a session result (get_session_result and child updates). */
const SESSION_RESULT_MESSAGE_WINDOW = 500;
/** Oldest messages read to recover the original prompt when the newest window no longer reaches it. */
const SESSION_RESULT_HEAD_WINDOW = 50;

function isExistingDirectory(candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The model a member creation named, for the provider check: its bare id and
 * whether this build knows it. Only openai-codex has a static catalog to
 * check against; claude-code variants are validated by ModelIdentifier when
 * the identifier is normalized, and other providers at their first turn.
 */
function describeRequestedMemberModel(provider: string, requestedModel: unknown): { id: string; known: boolean | null } | undefined {
  if (typeof requestedModel !== 'string' || !requestedModel) return undefined;
  const separator = requestedModel.indexOf(':');
  const bare = separator > 0 ? requestedModel.slice(separator + 1) : requestedModel;
  const prefixed = separator > 0 ? requestedModel : `${provider}:${requestedModel}`;
  if (provider === 'openai-codex') return { id: prefixed, known: isKnownCodexModelId(bare) };
  return { id: prefixed, known: null };
}
import {
  TEAM_CONTINUATION_NOTICE_CONTEXT,
  buildTeamContinuationNotice,
  postTeamCheckpointCard,
  resolveTeamCheckpointCard,
  teamContinueActionLabel,
} from './team/teamCheckpoint';
import { describeChildToolScope, isToolScopeEnforced } from './ai/childToolScope';
import type { NotificationOptions, NotificationResult } from './NotificationService';
import type { MobilePushResult } from '@nimbalyst/runtime/sync/types';
import { composeNotificationTitle } from '../../shared/notificationTitle';

type SessionStatusValue = 'idle' | 'running' | 'waiting_for_input' | 'error' | 'interrupted';
type PromptType = 'permission_request' | 'ask_user_question_request' | 'exit_plan_mode_request';

interface PendingInteractivePrompt {
  id: string;
  promptId: string;
  promptType: PromptType;
  createdAt: number;
  content: Record<string, any>;
}

interface SessionResultData {
  sessionId: string;
  title: string;
  provider: string;
  model: string | null;
  status: SessionStatusValue;
  lastActivity: number | null;
  originalPrompt: string | null;
  userPrompts: string[];
  lastResponse: string | null;
  /** Full final assistant response (large cap), for get_session_result so the
   *  meta-agent can synthesize from the child's real work, not a 500-char stub.
   *  The notification preview deliberately uses lastResponse, not this. */
  fullResponse: string | null;
  recentMessages: Array<{ direction: 'input' | 'output'; text: string }>;
  editedFiles: string[];
  pendingPrompt: PendingInteractivePrompt | null;
  errorMessage?: string | null;
  createdAt: number;
  updatedAt: number;
  worktreeId?: string | null;
  /** Capability scope the child was granted (read|write|full). The objective
   *  record of what the child COULD do; null/full means all tools. */
  toolScope?: string | null;
  /** Whether the child's provider actually withholds what toolScope denies. */
  toolScopeEnforced?: boolean;
  /** Team role of a member (metadata.teamChild.role); null or absent outside a team. */
  teamRole?: TeamRole | null;
  /**
   * Whether the member's provider differs from its team root's
   * (teamProviderDiversity); null when unknown, absent outside a team. Read
   * from the two session rows, never stored.
   */
  providerDiversity?: TeamProviderDiversity | null;
}

interface CreateChildSessionArgs {
  title?: string;
  provider?: string;
  model?: string;
  prompt?: string;
  useWorktree?: boolean;
  worktreeId?: string;
  toolScope?: string;
  /**
   * Reasoning effort for the new session. Omit to leave the child on the
   * app-wide default (what every spawn did before this existed) — an omitted
   * value is NOT inherited from the caller.
   */
  effortLevel?: string;
  /** Team mode role (explorer | implementer | reviewer | other); ignored outside a team. */
  role?: string;
  /** Team mode mission of the member (stored on teamChild.mission); ignored outside a team. */
  mission?: string;
}

/**
 * Validate a caller-supplied effort level. Deliberately throws instead of
 * using `parseEffortLevel`, which returns the 'high' default for unrecognized
 * input — that would turn a typo ('mid') into a silent, plausible-looking
 * choice the caller never made.
 */
function validateRequestedEffortLevel(value: string | undefined): EffortLevel | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const match = EFFORT_LEVELS.find((entry) => entry.key === value);
  if (!match) {
    throw new Error(
      `Invalid effortLevel "${value}". Expected one of: ${EFFORT_LEVELS.map((entry) => entry.key).join(', ')}`
    );
  }
  return match.key;
}

function normalizeStoredChildModelIdentifier(
  provider: string | null | undefined,
  model: string | null | undefined
): string | null {
  if (!model) {
    return null;
  }

  if (provider === 'claude-code' || model.startsWith('claude-code:')) {
    const parsed = ModelIdentifier.parse(model);
    if (provider === 'claude-code' && parsed.provider !== 'claude-code') {
      throw new Error(`Claude Agent child sessions require a claude-code:* model identifier. Received: ${model}`);
    }
    return parsed.combined;
  }

  return model;
}

/**
 * The session that queued an input row, from the prompt provenance providers
 * copy into `ai_agent_messages.metadata` (AIProvider.withPromptProvenanceMetadata).
 * Null for user-typed prompts and rows written before provenance existed.
 */
export function promptOriginSessionId(metadata?: Record<string, unknown> | null): string | null {
  const provenance = metadata?.promptProvenance;
  if (!provenance || typeof provenance !== 'object') return null;
  const origin = (provenance as Record<string, unknown>).originSessionId;
  return typeof origin === 'string' && origin ? origin : null;
}

interface SpawnSessionArgs {
  title?: string;
  prompt: string;
  useWorktree?: boolean;
  model?: string;
  /**
   * When true and `model` is not explicitly set, the new session uses the
   * caller's model instead of the global app default. Ignored if `model` is
   * provided explicitly.
   */
  inheritModel?: boolean;
  /**
   * If false (the default for /launch-new-session), the parent will not receive
   * `[Child Session Update]` notifications when the spawned session completes,
   * errors, or waits for input. Use this for fire-and-forget hand-offs where the
   * parent is just kicking off work to escape a long context.
   */
  notifyOnComplete?: boolean;
  /**
   * When true, the new session is created at the top level — no parent, no
   * workstream container, no shared files-edited or tabs with the caller.
   * Use for fix-and-commit-separately work that should not pollute the
   * caller's workstream.
   */
  isolated?: boolean;
  /**
   * Reasoning effort for the new session (e.g. spawn an
   * `openai-codex:gpt-6-astra` session at 'medium'). Clamped to the resolved
   * model's ceiling. Omit to leave the child on the app-wide default; unlike
   * `model` there is no inherit-from-caller mode.
   */
  effortLevel?: string;
  /** Team mode role (explorer | implementer | reviewer | other); ignored outside a team. */
  role?: string;
  /** Team mode mission of the member (stored on teamChild.mission); ignored outside a team. */
  mission?: string;
}

interface NotifyUserArgs {
  title?: string;
  body?: string;
  sessionId?: string;
  bypassFocusCheck?: boolean;
  silent?: boolean;
  urgency?: 'normal' | 'critical' | 'low';
}

type ShowNotificationWithResult = (
  options: NotificationOptions
) => Promise<NotificationResult>;

/**
 * Injected rather than imported: `SyncManager` pulls in the runtime barrel, the
 * window manager and the Stytch client, and this service is imported by a lot of
 * tests that have no business loading any of that.
 */
type RequestMobilePush = (
  sessionId: string,
  title: string,
  body: string,
  options: { force?: boolean; reason?: string }
) => Promise<MobilePushResult | null>;

/** Cap of a child's final report inside a [Child Session Update]. */
export const CHILD_UPDATE_FINAL_REPORT_MAX_CHARS = 8000;

/**
 * Phase 1A.1: an architect's final report is its Tool Manifest. Within the
 * 7,500-character contract it travels whole (the update's own cap is 8,000, so
 * a valid manifest never depends on it). Above the contract the YAML is kept
 * whole and the Markdown, with its "Preparation" line, is replaced by a notice
 * telling the coordinator to ask for a compacted re-emission; the YAML is never
 * cut. A final message that is not a manifest gets the ordinary cap and marker.
 */
export function renderArchitectFinalReport(text: string): string {
  try {
    return renderArchitectReportForUpdate(text, CHILD_UPDATE_FINAL_REPORT_MAX_CHARS);
  } catch (error) {
    // Judging the report must never cost the coordinator the report itself.
    console.warn('[MetaAgentService] Could not judge an architect report; delivering it capped:', error);
    return text.length > CHILD_UPDATE_FINAL_REPORT_MAX_CHARS
      ? `${text.slice(0, CHILD_UPDATE_FINAL_REPORT_MAX_CHARS)}... [truncated: ${text.length - CHILD_UPDATE_FINAL_REPORT_MAX_CHARS} more characters; get_session_result has the full text]`
      : text;
  }
}

export class MetaAgentService {
  private static instance: MetaAgentService | null = null;
  private starting: Promise<void> | null = null;
  private started = false;
  private serverPort: number | null = null;
  private aiService: AIService | null = null;
  private sessionManager: SessionManager | null = null;
  private unsubscribeStateListener: (() => void) | null = null;
  private notificationSignatures = new Map<string, string>();
  /** Team mode: error wakes delivered per member since its last successful settle (anti-loop backstop). */
  private teamErrorWakes = new Map<string, number>();
  /** Phase 1B: one Tool Manifest persistence at a time per team root, so two architects settling together never both become M-1. */
  private readonly manifestPersistenceChains = new Map<string, Promise<unknown>>();
  /** Phase 1B: a hung tracker never holds the [Child Session Update] back; past this the update goes out without a notice. */
  manifestPersistenceTimeoutMs = 15_000;
  private ipcHandlersRegistered = false;
  private showNotificationWithResult: ShowNotificationWithResult | null = null;
  private requestMobilePush: RequestMobilePush | null = null;

  private constructor() {}

  public static getInstance(): MetaAgentService {
    if (!MetaAgentService.instance) {
      MetaAgentService.instance = new MetaAgentService();
    }
    return MetaAgentService.instance;
  }

  public getPort(): number | null {
    return this.serverPort;
  }

  private shouldBypassChildAgentExecutionForTests(): boolean {
    return (
      process.env.PLAYWRIGHT === '1' ||
      process.env.PLAYWRIGHT_TEST === 'true' ||
      process.env.NODE_ENV === 'test'
    );
  }

  private async persistSyntheticInputMessage(
    sessionId: string,
    prompt: string,
    promptProvenance?: PromptProvenance,
  ): Promise<void> {
    await AgentMessagesRepository.create({
      sessionId,
      source: 'nimbalyst-meta-agent',
      direction: 'input',
      content: prompt,
      createdAt: new Date(),
      searchable: true,
      metadata: promptProvenance ? { promptProvenance } : undefined,
    });
  }

  public async start(
    aiService: AIService,
    showNotificationWithResult: ShowNotificationWithResult,
    requestMobilePush?: RequestMobilePush
  ): Promise<void> {
    if (this.started) {
      return;
    }

    if (this.starting) {
      await this.starting;
      return;
    }

    this.starting = (async () => {
      this.aiService = aiService;
      this.showNotificationWithResult = showNotificationWithResult;
      this.requestMobilePush = requestMobilePush ?? null;
      this.sessionManager = new SessionManager();
      await this.sessionManager.initialize();
      // Extension backend modules drive their owned sessions through the same
      // prompt queue, and receive their settles from the same state feed.
      startExtensionSessionService(aiService);

      setMetaAgentToolFns({
        listWorktrees: (metaSessionId, workspaceId) =>
          this.listWorktreesJson(metaSessionId, workspaceId),
        createSession: (metaSessionId, workspaceId, args) =>
          this.createChildSession(metaSessionId, workspaceId, args),
        spawnSession: (callerSessionId, workspaceId, args) =>
          this.spawnSession(callerSessionId, workspaceId, args),
        getSessionStatus: (_metaSessionId, workspaceId, targetSessionId) =>
          this.getSessionStatusJson(targetSessionId, workspaceId),
        getSessionResult: (_metaSessionId, workspaceId, targetSessionId, options) =>
          this.getSessionResultJson(targetSessionId, workspaceId, options),
        listQueuedPrompts: (_metaSessionId, workspaceId, targetSessionId, options) =>
          this.listQueuedPromptsJson(targetSessionId, workspaceId, options),
        sendPrompt: (metaSessionId, workspaceId, targetSessionId, prompt, interrupt, messageKind, options) =>
          this.sendPromptToSession(metaSessionId, targetSessionId, workspaceId, prompt, interrupt, messageKind, options),
        notifyUser: (callerSessionId, workspaceId, args) =>
          this.notifyUserJson(callerSessionId, workspaceId, args),
        respondToPrompt: (_metaSessionId, workspaceId, args) =>
          this.respondToPrompt(workspaceId, args),
        listSpawnedSessions: (metaSessionId, workspaceId) =>
          this.listSpawnedSessionsJson(metaSessionId, workspaceId),
        resolveSessionWorkspaceRoot: (sessionId) => this.resolveSessionWorkspaceRoot(sessionId),
      });

      // MCP consolidation Phase 7: meta-agent tools are served by the unified
      // server's `/mcp/host` endpoint via `dispatchMetaAgentTool`, which uses the
      // toolFns injected above. This service no longer starts a standalone HTTP
      // server.

      this.unsubscribeStateListener = getSessionStateManager().subscribe((event) => {
        // NIM-6 follow-up: dedup signatures only describe one turn; clear them
        // when a child becomes active again so two distinct turns whose final
        // text happens to match (e.g. "done", "ok") still each notify the
        // parent.
        if (event.type === 'session:started' || event.type === 'session:streaming') {
          this.notificationSignatures.delete(event.sessionId);
          return;
        }
        if (event.type === 'session:completed' || event.type === 'session:error' || event.type === 'session:waiting' || event.type === 'session:interrupted') {
          void this.handleChildSessionEvent(event.sessionId, event.type);
        }
      });

      this.registerIpcHandlers();
      this.started = true;
    })();

    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  public async shutdown(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.unsubscribeStateListener?.();
    this.unsubscribeStateListener = null;
    this.notificationSignatures.clear();
    this.teamErrorWakes.clear();
    this.showNotificationWithResult = null;
    // No standalone HTTP server to tear down (Phase 7); the injected toolFns are
    // process-lifetime singletons.
    this.serverPort = null;
    this.started = false;
  }

  /**
   * Launch a sibling session in the same workstream from a user-triggered
   * action prompt (the Actions dropdown in the AI composer). This is the
   * non-MCP entry point: unlike `spawnSession` (called from the meta-agent
   * MCP server), this is invoked from a human IPC and returns a typed
   * result, not stringified JSON.
   *
   * Workstream/worktree/model resolution mirrors `spawnSession` exactly:
   * - sibling under the parent's workstream (creating the container if needed)
   * - inherit parent's worktree unless `useWorktree=true`
   * - explicit `model` wins; otherwise inherit caller's model
   *
   * When `autoSubmit=true` the prompt is queued and processing starts; when
   * `autoSubmit=false` the session is created with no queued prompt so the
   * renderer can prefill the draft input for the user to edit before sending.
   */
  public async launchActionSession(
    parentSessionId: string,
    workspaceId: string,
    args: {
      prompt: string;
      title?: string;
      model?: string;
      autoSubmit: boolean;
      useWorktree?: boolean;
    }
  ): Promise<{
    sessionId: string;
    workstreamId: string | null;
    worktreeId: string | null;
    promotedParent: boolean;
    queuedInitialPrompt: boolean;
  }> {
    if (!args?.prompt?.trim()) {
      throw new Error('prompt is required');
    }

    const parent = await AISessionsRepository.get(parentSessionId);
    if (!parent || !sameWorkspaceIdentity(parent.workspacePath, workspaceId)) {
      throw new Error(`Parent session ${parentSessionId} not found in this workspace`);
    }

    // Everything this launch writes goes under the parent's own key, not the
    // canonicalized one the tool dispatcher handed us (#1551).
    const workspaceKey = resolveStoredWorkspaceId(parent.workspacePath, workspaceId);

    // Explicit model wins; otherwise inherit caller's model (e.g. keep "opus"
    // on "opus") rather than dropping to the global default.
    const effectiveModel = args.model ?? parent.model ?? undefined;

    // A launch from inside a team creates a team member (role `other`): its
    // provider is refused here, before the workstream below exists, by the
    // same rule as create_session and spawn_session.
    const parentTeam = resolveTeamCaller(parentSessionId, parent.metadata, parent.agentRole);
    if (parentTeam) {
      const callerProvider = parent.provider ?? null;
      await this.assertTeamMemberProvider(
        'other',
        resolveTeamMemberProvider({ role: 'other', model: effectiveModel, modelInherited: !args.model && !!parent.model, callerProvider }),
        callerProvider,
        workspaceKey,
        'full',
        effectiveModel,
      );
    }

    const resolved = await this.resolveOrCreateWorkstream(parent, workspaceKey);
    const workstreamId = resolved.workstreamId;

    // Meta-agent children ALWAYS run in the parent's working directory (the
    // shared workspace), never a fresh isolated worktree. The parent synthesizes
    // by reading each child's written deliverable; a child that writes into its
    // own worktree leaves the parent unable to find the file. So we ignore the
    // requested useWorktree and inherit the parent's worktree (the main checkout
    // for a top-level meta-agent).
    const inheritedWorktreeId = parent.worktreeId ?? undefined;

    // Pass prompt only when autoSubmit is true; createChildSessionInternal
    // queues + triggers only when a prompt is supplied. For prefill mode we
    // omit it so nothing runs until the user hits Send in the new session.
    const childResult = await this.createChildSessionInternal(parentSessionId, workspaceKey, {
      title: args.title,
      prompt: args.autoSubmit ? args.prompt : undefined,
      useWorktree: false,
      worktreeId: inheritedWorktreeId,
      model: effectiveModel,
      // A user-triggered launch keeps the parent's model; no team role defaults.
      skipTeamRoleModelDefaults: true,
      parentSessionIdOverride: workstreamId,
      // Always fire-and-forget for human-triggered launches — the user can
      // watch the new session themselves; no need to surface child-completion
      // notifications back to the originating session.
      notifyParent: false,
    });

    return {
      sessionId: childResult.sessionId,
      workstreamId,
      worktreeId: childResult.worktreeId ?? null,
      promotedParent: resolved.promotedParent,
      queuedInitialPrompt: childResult.queuedInitialPrompt,
    };
  }

  private registerIpcHandlers(): void {
    if (this.ipcHandlersRegistered) {
      return;
    }

    safeHandle('meta-agent:list-spawned-sessions', async (_event, metaSessionId: string, workspaceId: string) => {
      try {
        const sessions = await this.getSpawnedSessions(metaSessionId, workspaceId);
        return { success: true, sessions };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error), sessions: [] };
      }
    });

    // "Continue team" on the checkpoint card. Renderer-only on purpose: the
    // user's click is the authorization, and no MCP tool reaches this.
    safeHandle('team:continue', async (_event, payload: { sessionId?: unknown; checkpointLevel?: unknown } | undefined) => {
      try {
        const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
        if (!sessionId) return { success: false, error: 'sessionId is required' };
        const checkpointLevel = typeof payload?.checkpointLevel === 'number' ? payload.checkpointLevel : undefined;
        return { success: true, ...(await this.continueTeam(sessionId, checkpointLevel)) };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

    if (process.env.PLAYWRIGHT === '1' || process.env.PLAYWRIGHT_TEST === 'true' || process.env.NODE_ENV === 'test') {
      safeHandle('meta-agent:get-server-port', async () => {
        return { success: true, port: this.serverPort };
      });
    }

    this.ipcHandlersRegistered = true;
  }

  private async createChildSession(
    metaSessionId: string,
    workspaceId: string,
    args: CreateChildSessionArgs
  ): Promise<string> {
    // NIB.49: a Team mode member runs in its caller's checkout, as with
    // spawn_session. The worktree comes from the caller's persisted row; a
    // worktree id or a new-worktree request in the agent's arguments is
    // ignored, so no text can move a member to another checkout.
    const caller = await AISessionsRepository.get(metaSessionId);
    const team = caller ? resolveTeamCaller(metaSessionId, caller.metadata, caller.agentRole) : null;
    const effectiveArgs = team
      ? { ...args, ...callerWorktreeRequest((caller as { worktreeId?: string | null }).worktreeId, false) }
      : args;
    const result = await this.createChildSessionInternal(metaSessionId, workspaceId, effectiveArgs);
    return JSON.stringify(result, null, 2);
  }

  /**
   * Single entry point for every child-session creation path (create_session,
   * spawn_session, Actions launches). Resolves whether the caller belongs to a
   * Team mode team; outside a team the creation is exactly what it was before.
   */
  private async createChildSessionInternal(
    metaSessionId: string,
    workspaceId: string,
    args: Parameters<MetaAgentService['createChildSessionCore']>[2],
  ): ReturnType<MetaAgentService['createChildSessionCore']> {
    const caller = await AISessionsRepository.get(metaSessionId);
    const team = caller ? resolveTeamCaller(metaSessionId, caller.metadata, caller.agentRole) : null;
    if (!team) {
      return this.createChildSessionCore(metaSessionId, workspaceId, args, null);
    }
    // Team limits are checked before any side effect (worktree, row, prompt),
    // and check + creation run under one lock per team so parallel calls from
    // the same team cannot both pass a limit that only one of them fits.
    return this.withTeamSpawnLock(team.rootSessionId, async () => {
      await this.assertTeamSpawnCapacityOrShowCheckpoint(team);
      return this.createChildSessionCore(metaSessionId, workspaceId, args, team);
    });
  }

  /**
   * The team gate every creation path goes through (including spawn_session's
   * early check). At a checkpoint the creation stays refused, and the user is
   * shown the "Continue team" card in the root's transcript, whoever was
   * refused: the refusal tells the model that the card is there.
   */
  private async assertTeamSpawnCapacityOrShowCheckpoint(team: TeamCaller): Promise<void> {
    try {
      await assertTeamSpawnCapacity(team, teamContinueActionLabel());
    } catch (error) {
      if (error instanceof TeamBudgetReachedError) {
        await this.showTeamCheckpoint(team.rootSessionId, error.total, error.authorized);
      }
      throw error;
    }
  }

  private async showTeamCheckpoint(rootSessionId: string, created: number, authorized: number): Promise<void> {
    try {
      const root = await AISessionsRepository.get(rootSessionId);
      if (!root?.workspacePath) return;
      await postTeamCheckpointCard({ rootSessionId, workspacePath: root.workspacePath, created, authorized });
    } catch (error) {
      console.warn('[MetaAgentService] Failed to show the Team checkpoint:', error);
    }
  }

  /**
   * The user continues a team at its checkpoint ("Continue team" in the root's
   * transcript). Human-only entry point: it is reached from the renderer IPC
   * `team:continue` and from no MCP tool, so a session cannot extend its own
   * budget. The budget is read and extended under the team's spawn lock, like
   * every creation.
   *
   * `checkpointLevel` is the level of the card (or bar) that was clicked. It
   * authorizes nothing: it only lets a card left behind by a level the team
   * already passed be closed, so it stops showing as pending.
   */
  public async continueTeam(rootSessionId: string, checkpointLevel?: number): Promise<TeamContinuationResult> {
    const result = await this.withTeamSpawnLock(rootSessionId, () => authorizeTeamContinuation(rootSessionId));
    if (!result.extended) {
      if (
        result.reason === 'not-at-checkpoint' && typeof result.authorized === 'number' &&
        typeof checkpointLevel === 'number' && Number.isSafeInteger(checkpointLevel) &&
        checkpointLevel >= TEAM_LIMITS.budget && checkpointLevel < result.authorized
      ) {
        try {
          const root = await AISessionsRepository.get(rootSessionId);
          if (root?.workspacePath) {
            await resolveTeamCheckpointCard({
              rootSessionId,
              workspacePath: root.workspacePath,
              previousAuthorized: checkpointLevel,
              authorized: result.authorized,
            });
          }
        } catch (error) {
          console.warn('[MetaAgentService] Failed to close a stale Team checkpoint card:', error);
        }
      }
      return result;
    }

    // Everything below runs outside the lock: waking the coordinator starts a
    // turn that may create a member, which needs the lock itself. The budget is
    // already extended, so a failure here must not undo the answer.
    try {
      const root = await AISessionsRepository.get(rootSessionId);
      const workspacePath = root?.workspacePath;
      if (!workspacePath) return result;
      await resolveTeamCheckpointCard({
        rootSessionId,
        workspacePath,
        previousAuthorized: result.previousAuthorized,
        authorized: result.authorized,
      });
      // Tell the coordinator, so one click is enough to resume the team. The
      // drive is fire-and-forget: the click must not wait for the turn it starts.
      if (this.aiService) {
        await this.aiService.queuePromptForSession(
          rootSessionId,
          buildTeamContinuationNotice({ total: result.total, authorized: result.authorized }),
          undefined,
          // System provenance and its own origin: the transcript shows it as a
          // status line, not as something the user typed.
          { promptOrigin: TEAM_CONTINUATION_NOTICE_CONTEXT.promptOrigin, promptProvenance: { ...TEAM_CONTINUATION_NOTICE_CONTEXT.promptProvenance } },
        );
        this.aiService.requestQueueDrive(rootSessionId, workspacePath, 'meta-agent');
      }
    } catch (error) {
      console.warn('[MetaAgentService] Team continued, but the coordinator could not be notified:', error);
    }
    return result;
  }

  private readonly teamSpawnLocks = new Map<string, Promise<unknown>>();

  /** Run `task` after every earlier task of the same team has settled. */
  private async withTeamSpawnLock<T>(rootSessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.teamSpawnLocks.get(rootSessionId) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.then(() => undefined, () => undefined);
    this.teamSpawnLocks.set(rootSessionId, tail);
    try {
      return await run;
    } finally {
      if (this.teamSpawnLocks.get(rootSessionId) === tail) this.teamSpawnLocks.delete(rootSessionId);
    }
  }

  private async createChildSessionCore(
    metaSessionId: string,
    workspaceId: string,
    args: CreateChildSessionArgs & {
      parentSessionIdOverride?: string | null;
      /** false = fire-and-forget; written on the row before the first prompt is queued. */
      notifyParent?: boolean;
      /**
       * The model was chosen by inheritance (Actions launch, spawn inheritModel):
       * treat it as an explicit choice and skip the team role's model/effort defaults.
       */
      skipTeamRoleModelDefaults?: boolean;
    },
    /** The caller's team, or null outside Team mode. */
    team: TeamCaller | null,
  ): Promise<{
    sessionId: string;
    title: string;
    provider: string;
    model: string;
    worktreeId: string | null;
    worktreePath: string | null;
    worktreeMode: 'existing' | 'new' | 'none';
    createdBySessionId: string;
    queuedInitialPrompt: boolean;
    parentSessionId: string | null;
    /** Effort actually applied, after clamping; null when left on the app default. */
    effortLevel: string | null;
    /**
     * Team mode only: whether the member's provider differs from the team
     * root's (`diverse`), is the same (`same`) or could not be compared (null).
     * Absent outside a team.
     */
    providerDiversity?: TeamProviderDiversity | null;
  }> {
    if (!this.aiService) {
      throw new Error('AI service not initialized');
    }
    if (args.useWorktree && args.worktreeId) {
      throw new Error('useWorktree and worktreeId cannot be combined');
    }

    // Validate before any side effect, so a bad effortLevel can't leave a
    // half-created worktree or session row behind.
    const requestedEffortLevel = validateRequestedEffortLevel(args.effortLevel);

    // Defense-in-depth: a child-completion notification (built in
    // buildNotificationMessage) starts literally with '[Child Session Update]'.
    // If such text is ever re-ingested as a spawn prompt/title, the derived
    // title recurses into '[Child Session Update] Session: "[Child Session
    // Update]..."'. Refuse outright so an update notification can never become
    // a new child session.
    const CHILD_UPDATE_PREFIX = '[Child Session Update]';
    const promptHead = args.prompt?.trim() ?? '';
    const titleHead = args.title?.trim() ?? '';
    if (promptHead.startsWith(CHILD_UPDATE_PREFIX) || titleHead.startsWith(CHILD_UPDATE_PREFIX)) {
      throw new Error(
        'Refusing to spawn a child session from a child-completion notification ' +
        '(prompt/title begins with "[Child Session Update]").'
      );
    }

    // Inherit the calling session's provider+model as the primary fallback so a
    // non-Claude parent (Gemini, OpenAI-Codex, LM Studio, etc.) spawning a child
    // via the meta-agent tools without an explicit model does NOT silently land
    // on the hardcoded Opus default and bill the user's Anthropic pool. Only fall
    // through to getDefaultAIModel() / the last-resort default when the parent
    // session cannot be loaded (orphan call) or carries no usable provider+model.
    // An explicit args.provider/args.model still wins; that is what they are for.
    let parentProvider: string | null = null;
    let parentModel: string | null = null;
    let callerWorkspacePath: string | null = null;
    // A failed read is NOT treated like an orphan: the caller may be
    // extension-owned, and a child created without its owner would escape the
    // owner's roster and settle routing. Only a missing row falls through.
    const parentSession = await AISessionsRepository.get(metaSessionId);
    const callerMetadata: unknown = parentSession?.metadata ?? null;
    try {
      if (parentSession) {
        parentProvider = parentSession.provider ?? null;
        callerWorkspacePath = parentSession.workspacePath ?? null;
        parentModel = normalizeStoredChildModelIdentifier(parentProvider, parentSession.model ?? null);
      }
    } catch {
      // Best-effort lookup; fall through to the hardcoded default below.
    }

    // Team mode: validate the role and pick its default model and effort before
    // any side effect. Outside a team (team === null) none of this applies, and
    // an explicit model / effortLevel always wins over the role default.
    const teamRole = team ? resolveRequestedTeamRole(args.role) : null;
    // The mission is context for the member (its system prompt) and nothing
    // else: validated here so an over-long one fails before any side effect,
    // and read by no rule below (model, effort, scope and role ignore it).
    const teamMission = team ? resolveRequestedTeamMission(args.mission) : undefined;
    const applyRoleModelDefaults = teamRole !== null && !args.skipTeamRoleModelDefaults;
    // The role's model default applies when no model is named and the member
    // stays on the role's provider (naming that same provider changes nothing);
    // a member named onto another provider without a model gets that
    // provider's own default below.
    // A provider named without a model gets the role's model FOR THAT
    // PROVIDER (teamRoleModelForProvider in teamPolicy.ts decides it per
    // role), never the caller's model (NIB.46 item 7.6).
    const requestedModel = args.model
      ?? (applyRoleModelDefaults ? teamRoleModelForProvider(teamRole!, args.provider || null) ?? undefined : undefined);
    const effortLevelForChild = requestedEffortLevel
      ?? (applyRoleModelDefaults ? teamRoleDefaultEffort(teamRole!) : undefined);

    // Keyed by the workspace the CALLER is registered under, not the spelling
    // the dispatcher canonicalized to: a child filed under a spelling no window
    // is open on is created and then never started (#1551). An orphaned caller
    // falls back to the caller's own key, as before.
    const workspaceKey = resolveStoredWorkspaceId(callerWorkspacePath, workspaceId);

    const defaultModel =
      parentModel
      || normalizeStoredChildModelIdentifier(null, getDefaultAIModel())
      || 'claude-code:opus';
    // For an explicit model, the model's own "provider:" prefix is
    // authoritative (e.g. a claude-code parent launching an
    // "openai-codex:gpt-5.5" action). Only fall back to the parent's provider
    // for a bare, prefix-less variant; passing the parent provider for a
    // self-describing identifier wrongly trips the claude-code mismatch guard.
    const explicitModelProvider =
      args.provider
      ?? (requestedModel?.includes(':') ? ModelIdentifier.tryParse(requestedModel)?.provider ?? null : null)
      ?? parentProvider;
    const explicitModel = normalizeStoredChildModelIdentifier(explicitModelProvider, requestedModel ?? null);
    const model = explicitModel || defaultModel;
    const parsed = ModelIdentifier.tryParse(model);
    // Team mode: the member's provider is its role default (teamPolicy.ts,
    // TEAM_ROLE_DEFAULTS) unless the caller named one; either way it must be
    // one whose turn the host knows enforces the member's scope and role
    // policy (teamProviders.ts), and one that is available here. Refused
    // before any side effect, with an explicit reason and never a fallback to
    // another provider: a same-provider member is the caller's choice to make
    // by calling again, not the host's to make silently. spawn_session runs
    // the same check before its own side effects (the workstream).
    const teamMemberProvider = team
      ? resolveTeamMemberProvider({
        role: teamRole!,
        provider: args.provider,
        model: args.model,
        modelInherited: args.skipTeamRoleModelDefaults === true && !!args.model,
        callerProvider: parentProvider,
      })
      : null;
    if (team) {
      await this.assertTeamMemberProvider(
        teamRole!,
        teamMemberProvider!,
        parentProvider,
        workspaceKey,
        // The scope the member will be stored with (pure; computed again below for the row).
        resolveChildToolScope(resolveChildToolScopeRequest(args.toolScope, teamRole ?? undefined)),
        args.model,
      );
    }
    const provider = (teamMemberProvider?.provider ||
      args.provider ||
      parsed?.provider ||
      parentProvider ||
      'claude-code') as AIProviderType;
    // Provider of the team root, for the diversity of this member's provider
    // reported to its creator: known here only when the caller is the root
    // (creation never reads the root row; a deeper creator learns it from the
    // member's [Child Session Update], which compares against the root).
    const teamRootProvider = team && team.depth === 0 ? parentProvider : null;
    // Provider and model MUST agree. Otherwise a child is persisted with, e.g.,
    // provider=claude-code + an antigravity-gemini model, gets routed to the
    // Claude Code provider, is rejected ("requires a claude-code:* identifier"),
    // and dies with no output. Only reuse the parent model when it actually
    // belongs to the resolved provider; otherwise use that provider default.
    const parentModelProvider = parentModel
      ? (ModelIdentifier.tryParse(parentModel)?.provider ?? parentProvider)
      : null;
    const normalizedModel =
      explicitModel
      || (parentModel && parentModelProvider === provider ? parentModel : null)
      || ModelIdentifier.getDefaultModelId(provider);

    const callerProvidedTitle = !!args.title?.trim();
    const title = (args.title || this.deriveTitleFromPrompt(args.prompt) || 'Meta Task').trim();

    let worktreeId: string | null = null;
    let worktreePath: string | null = null;

    const db = getDatabase();
    if ((args.useWorktree || args.worktreeId) && !db) {
      throw new Error('Database not initialized');
    }
    const worktreeStore = db ? createWorktreeStore(db) : null;

    if (args.worktreeId) {
      if (!worktreeStore) {
        throw new Error('Worktree store not initialized');
      }

      const existingWorktree = await worktreeStore.get(args.worktreeId);
      if (!existingWorktree) {
        throw new Error(`Worktree ${args.worktreeId} not found`);
      }
      if (!sameWorkspaceIdentity(existingWorktree.projectPath, workspaceKey)) {
        throw new Error(`Worktree ${args.worktreeId} does not belong to this workspace`);
      }
      if (existingWorktree.isArchived) {
        throw new Error(`Worktree ${args.worktreeId} is archived`);
      }
      // NIB.49: a team's worktree that is gone from disk refuses the member
      // instead of letting it run somewhere else; never a silent fallback to
      // the main checkout.
      if (team && !isExistingDirectory(existingWorktree.path)) {
        throw new Error(`The team's worktree ${existingWorktree.path} no longer exists on disk, so the member was not created; it is never moved to the main checkout instead.`);
      }

      worktreeId = existingWorktree.id;
      worktreePath = existingWorktree.path;
    } else if (args.useWorktree) {
      if (!worktreeStore) {
        throw new Error('Worktree store not initialized');
      }

      const gitWorktreeService = new GitWorktreeService();
      const [dbNames, filesystemNames, branchNames] = await Promise.all([
        worktreeStore.getAllNames(),
        Promise.resolve(gitWorktreeService.getExistingWorktreeDirectories(workspaceKey)),
        gitWorktreeService.getAllBranchNames(workspaceKey),
      ]);
      const existingNames = new Set<string>();
      for (const name of dbNames) existingNames.add(name);
      for (const name of filesystemNames) existingNames.add(name);
      for (const name of branchNames) existingNames.add(name);
      const finalName = gitWorktreeService.generateUniqueWorktreeName(existingNames);
      // As-opened spelling, so the new worktree's projectPath matches the key
      // the window and its sessions use.
      const worktree = await gitWorktreeService.createWorktree(workspaceKey, { name: finalName });
      await worktreeStore.create(worktree);
      gitRefWatcher.start(worktree.path, undefined, workspaceId).catch((error: Error) => {
        console.error('[MetaAgentService] Failed to start GitRefWatcher for meta-agent worktree:', error);
      });
      worktreeId = worktree.id;
      worktreePath = worktree.path;
    }

    await assertChildSpawnCapacity(workspaceKey, metaSessionId);

    // NIM-858: do NOT auto-promote the spawning parent to agent_role='meta-agent'.
    // The renderer META AGENT group is reserved for genuine meta-agents (created
    // via the Meta Agent button, which sets agentRole='meta-agent' at create
    // time) and their children. A standard session that spawns a sibling — via
    // the Actions-dropdown launch (launchActionSession) or the spawn_session MCP
    // tool used by /launch-new-session — must stay agentRole='standard' so it and
    // its sibling render flat (as workstream siblings), not under Meta Agent.
    //
    // A prior promotion block here claimed to be "inert" because spawn tools were
    // gated on agentRole==='meta-agent'. That gating only covers the extension-
    // agent (Gemini) branch in MessageStreamingHandler; the nimbalyst-meta-agent
    // MCP server is attached to every built-in session unconditionally
    // (McpConfigService), and launchActionSession passes a standard parent — so
    // the block actually fired and wrongly relabeled standard parents.

    // Read-only tool segregation: persist a restricted capability scope so the
    // child is granted only the matching dev tools at turn time (an analyze
    // child physically cannot run_command, so it cannot build or claim to).
    // An explicit toolScope wins over the team role's default, except that a
    // reviewer is held to `review`; an unrecognized value fails closed to `read`.
    const childToolScope = resolveChildToolScopeRequest(args.toolScope, teamRole ?? undefined);

    // Reasoning effort: every turn reads it back out of session metadata
    // (MessageStreamingHandler for codex/others, buildClaudeCodeRuntimeConfig
    // for claude-code). Clamp to the resolved model's ceiling so the child's
    // effort selector displays the same level the provider will actually run
    // at, rather than a level the transport would silently lower. Writing
    // nothing leaves the child on the app-wide default.
    const childEffortLevel = effortLevelForChild
      ? clampEffortLevel(effortLevelForChild, normalizedModel)
      : undefined;

    // Everything a reader must never see missing goes in the insert itself:
    // notifyParent written after the prompt was queued let a fast child settle
    // notify a parent that asked not to be told. A child of an extension-owned
    // session inherits the owner (never the directive).
    const childMetadata: Record<string, unknown> = {
      ...inheritedOwnership(callerMetadata),
      ...(childToolScope ? { toolScope: childToolScope } : {}),
      ...(childEffortLevel ? { effortLevel: childEffortLevel } : {}),
      ...(args.notifyParent === false ? { notifyParent: false } : {}),
      // Written with the row (creation-only); the store refuses to change it later.
      ...(team && teamRole ? { [TEAM_CHILD_METADATA_KEY]: buildTeamChild(team, teamRole, teamMission) } : {}),
    };

    const sessionId = randomUUID();
    await AISessionsRepository.create({
      id: sessionId,
      provider,
      model: normalizedModel,
      title,
      workspaceId: workspaceKey,
      worktreeId: worktreeId ?? undefined,
      agentRole: 'standard',
      createdBySessionId: metaSessionId,
      parentSessionId: args.parentSessionIdOverride ?? null,
      // When the meta-agent (or any caller of spawn_session) supplies an
      // explicit title, treat the session as already named. claude-code reads
      // this flag (via documentContext.hasBeenNamed) to set hasOutOfBandNaming
      // and suppress in-band self-naming, so the child keeps the parent's title.
      hasBeenNamed: callerProvidedTitle,
      metadata: childMetadata,
    });

    const initialPrompt = args.prompt?.trim();
    const shouldBypassExecution = this.shouldBypassChildAgentExecutionForTests();

    if (initialPrompt) {
      const promptProvenance: PromptProvenance = {
        actor: 'agent',
        origin: 'session-orchestration',
        originSessionId: metaSessionId,
      };
      if (shouldBypassExecution) {
        await this.persistSyntheticInputMessage(sessionId, initialPrompt, promptProvenance);
      } else {
        await this.aiService.queuePromptForSession(sessionId, initialPrompt, undefined, { promptProvenance });
      }
    }

    broadcastSessionCreated({
      workspacePath: workspaceKey,
      sessionId,
      parentSessionId: args.parentSessionIdOverride ?? null,
      worktreeId,
    });

    if (initialPrompt && !shouldBypassExecution) {
      await this.aiService.triggerQueuedPromptProcessingForSession(sessionId, worktreePath || workspaceKey, 'meta-agent');
    }

    return {
      sessionId,
      title,
      provider,
      model: normalizedModel,
      worktreeId,
      worktreePath,
      worktreeMode: args.worktreeId ? 'existing' : args.useWorktree ? 'new' : 'none',
      createdBySessionId: metaSessionId,
      queuedInitialPrompt: !!initialPrompt,
      parentSessionId: args.parentSessionIdOverride ?? null,
      effortLevel: childEffortLevel ?? null,
      ...(team ? { providerDiversity: teamProviderDiversity(provider, teamRootProvider) } : {}),
    };
  }

  /**
   * Refuse a team member whose provider the host cannot run it on at its
   * scope (not ready: teamProviders.ts), cannot reach (not enabled, not
   * signed in, or not verifiable) or whose named model this build does not
   * know. Pure rule in teamPolicy.ts; this only gathers the facts. Called by
   * every creation path before any side effect.
   */
  private async assertTeamMemberProvider(
    role: TeamRole,
    request: TeamMemberProviderRequest,
    callerProvider: string | null,
    workspacePath: string,
    scope: ChildToolScope,
    requestedModel: unknown,
  ): Promise<void> {
    const foreign = request.provider !== callerProvider;
    const refusal = teamMemberProviderRefusal({
      role,
      ...request,
      callerProvider,
      readiness: teamMemberProviderReadiness(request.provider, scope),
      enabled: foreign ? this.resolveProviderEnabled(request.provider, workspacePath) : null,
      authenticated: foreign ? await this.resolveProviderAuthenticated(request.provider) : undefined,
      model: describeRequestedMemberModel(request.provider, requestedModel),
      cliVersion: await this.resolveProviderCliVersion(request.provider),
    });
    if (refusal) throw new Error(refusal);
  }

  /**
   * Whether a provider is enabled for a workspace, from the AI service's
   * settings; null when that cannot be determined (no AI service, or a read
   * that fails), which the provider refusal treats as unavailable.
   */
  private resolveProviderEnabled(provider: string, workspacePath: string): boolean | null {
    if (!this.aiService) return null;
    try {
      return this.aiService.isProviderEnabledForTeamMember(provider, workspacePath) === true;
    } catch {
      return null;
    }
  }

  /**
   * Whether the user is signed in to a provider, through the check the host
   * wired for it (index.ts: the Codex auth service for openai-codex; claude-code
   * signs in through its own CLI and needs none). Null when no check is wired
   * for the provider or the check fails: unverified, which refuses the member.
   */
  private providerAuthenticationCheck: ((provider: string) => Promise<boolean | null>) | null = null;

  /** Host wiring: how to tell whether the user is signed in to a provider. */
  public setProviderAuthenticationCheck(check: ((provider: string) => Promise<boolean | null>) | null): void {
    this.providerAuthenticationCheck = check;
  }

  private async resolveProviderAuthenticated(provider: string): Promise<boolean | null> {
    if (!this.providerAuthenticationCheck) return null;
    try {
      const result = await this.providerAuthenticationCheck(provider);
      return result === true ? true : result === false ? false : null;
    } catch {
      return null;
    }
  }

  /**
   * Host wiring: the CLI version of a provider, when the integration needs a
   * minimum (NIB.46 item 7.8). `undefined` means no check applies to the
   * provider; null means the host could not learn it (refused as unverified).
   */
  private providerVersionCheck: ((provider: string) => Promise<string | null | undefined>) | null = null;

  public setProviderVersionCheck(check: ((provider: string) => Promise<string | null | undefined>) | null): void {
    this.providerVersionCheck = check;
  }

  private async resolveProviderCliVersion(provider: string): Promise<TeamMemberProviderCheck['cliVersion']> {
    if (provider !== 'openai-codex') return undefined;
    if (!this.providerVersionCheck) return undefined;
    let version: string | null | undefined;
    try {
      version = await this.providerVersionCheck(provider);
    } catch {
      version = null;
    }
    if (version === undefined) return undefined;
    return { version, minimum: CODEX_MIN_CLI_VERSION, supported: version ? isCodexCliVersionSupported(version) : null };
  }

  /**
   * The folder a session is authorized to run the project's tests in: its own
   * worktree, else its workspace, from the session row; never a path the
   * agent or the transport supplies (NIB.31). Null when the session is
   * unknown, has no workspace on record, or that folder is not on disk.
   */
  public async resolveSessionWorkspaceRoot(sessionId: string): Promise<string | null> {
    let session: { workspacePath?: string | null; worktreePath?: string | null } | null = null;
    try {
      session = await AISessionsRepository.get(sessionId);
    } catch {
      return null;
    }
    const root = sessionAuthorizedRoot(session);
    if (!root || !path.isAbsolute(root)) return null;
    return isExistingDirectory(root) ? root : null;
  }

  private async spawnSession(
    parentSessionId: string,
    workspaceId: string,
    args: SpawnSessionArgs
  ): Promise<string> {
    if (!args?.prompt?.trim()) {
      throw new Error('prompt is required');
    }

    const parent = await AISessionsRepository.get(parentSessionId);
    if (!parent || !sameWorkspaceIdentity(parent.workspacePath, workspaceId)) {
      throw new Error(`Parent session ${parentSessionId} not found in this workspace`);
    }

    // The parent's stored spelling is the one the window and every sibling are
    // registered under; keep writing that (#1551).
    const workspaceKey = resolveStoredWorkspaceId(parent.workspacePath, workspaceId);

    const isolated = args.isolated === true;
    // Inside a team the coordinator needs every member's result, so report back
    // by default there; elsewhere spawn_session stays fire-and-forget.
    const parentTeam = resolveTeamCaller(parentSessionId, parent.metadata, parent.agentRole);
    const notifyOnComplete = args.notifyOnComplete === true || (parentTeam !== null && args.notifyOnComplete !== false);
    // Refuse an over-limit team spawn before the workstream promotion below; the
    // authoritative check runs again under the team lock in createChildSessionInternal.
    if (parentTeam) {
      await this.assertTeamSpawnCapacityOrShowCheckpoint(parentTeam);
    }

    // Resolve effective model: explicit `model` wins; otherwise `inheritModel`
    // copies the caller's model so the new session keeps the same provider/model
    // (e.g. opus stays on opus). Falling through to undefined lets
    // createChildSessionInternal use the global default.
    const effectiveModel =
      args.model ?? (args.inheritModel ? parent.model ?? undefined : undefined);

    // A team member's provider is refused here, before the workstream below is
    // created or the caller is promoted into one: a refusal must leave nothing
    // behind. The authoritative check runs again in createChildSessionInternal.
    if (parentTeam) {
      const role = resolveRequestedTeamRole(args.role);
      const callerProvider = parent.provider ?? null;
      await this.assertTeamMemberProvider(
        role,
        resolveTeamMemberProvider({ role, model: effectiveModel, modelInherited: !args.model && args.inheritModel === true, callerProvider }),
        callerProvider,
        workspaceKey,
        // spawn_session passes no scope: the member gets its role default.
        resolveChildToolScope(resolveChildToolScopeRequest(undefined, role)),
        effectiveModel,
      );
    }

    // Sibling mode: resolve (or create) a workstream container so the new
    // session shares files-edited, tabs, and workstream overview with the
    // caller. Isolated mode skips this entirely — the new session is a
    // top-level row with no parent, intended for fix-and-commit work that
    // should not pollute the caller's workstream.
    let workstreamId: string | null = null;
    let promotedParent = false;
    if (!isolated) {
      const resolved = await this.resolveOrCreateWorkstream(parent, workspaceKey);
      workstreamId = resolved.workstreamId;
      promotedParent = resolved.promotedParent;
    }

    // Inherit the caller's worktree by default. spawn_session means "continue
    // work in the same checkout I'm in"; without this, a child created from a
    // worktree-resident parent silently lands in the project root and any edits
    // it makes go to the wrong tree. Skip inheritance only when the caller
    // explicitly asked for a brand-new worktree (useWorktree=true). Same rule
    // as create_session of a Team mode member (callerWorktreeRequest).
    const worktreeRequest = callerWorktreeRequest(parent.worktreeId, !!args.useWorktree);

    const childResult = await this.createChildSessionInternal(parentSessionId, workspaceKey, {
      title: args.title,
      prompt: args.prompt,
      useWorktree: worktreeRequest.useWorktree,
      worktreeId: worktreeRequest.worktreeId,
      model: effectiveModel,
      effortLevel: args.effortLevel,
      role: args.role,
      mission: args.mission,
      // inheritModel is an explicit choice: keep the caller's model, no role defaults.
      skipTeamRoleModelDefaults: !args.model && args.inheritModel === true,
      parentSessionIdOverride: workstreamId,
      // Default is fire-and-forget: kicking off work in a fresh session is the
      // common /launch-new-session use case (escape a long parent context).
      notifyParent: notifyOnComplete ? undefined : false,
    });

    return JSON.stringify({
      ...childResult,
      isolated,
      workstreamId,
      promotedParent,
      notifyOnComplete,
    }, null, 2);
  }

  private async resolveOrCreateWorkstream(
    parent: { id: string; title?: string; provider: string; model?: string | null; sessionType?: string; parentSessionId?: string | null; worktreeId?: string | null },
    workspaceId: string
  ): Promise<{ workstreamId: string | null; promotedParent: boolean }> {
    // A worktree IS the workstream — the worktree row in the `worktrees` table is the
    // container, and every session inside it is a flat sibling keyed by `worktree_id`.
    // Never wrap a worktree-resident session in a `session_type='workstream'` row;
    // that produces a forbidden third layer (worktree → workstream → session) and
    // confuses every grouping derivation (worktreeGroupsData, FilesEditedSidebar,
    // the workstream tab strip). Hard rule: two layers max.
    if (parent.worktreeId) {
      return { workstreamId: null, promotedParent: false };
    }

    if (parent.parentSessionId) {
      return { workstreamId: parent.parentSessionId, promotedParent: false };
    }

    if (parent.sessionType === 'workstream') {
      return { workstreamId: parent.id, promotedParent: false };
    }

    const workstreamId = randomUUID();
    const workstreamTitle = (parent.title && parent.title.trim()) ? parent.title : 'Workstream';

    await AISessionsRepository.create({
      id: workstreamId,
      provider: parent.provider,
      model: parent.model ?? undefined,
      title: workstreamTitle,
      workspaceId,
      sessionType: 'workstream',
    });

    // Tag the workstream container in metadata so existing renderer code that
    // relies on metadata.isWorkstreamRoot continues to work.
    await AISessionsRepository.updateMetadata(workstreamId, {
      metadata: { isWorkstreamRoot: true },
    });

    // Reparent the original session under the new workstream container.
    await AISessionsRepository.updateMetadata(parent.id, {
      parentSessionId: workstreamId,
    });

    // Tell the renderer the original session is now a child of the workstream
    // so per-parent atoms (sessionChildrenAtom, workstreamStateAtom) get
    // patched alongside the registry refresh that fires below.
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('sessions:child-added', {
          workspacePath: workspaceId,
          parentSessionId: workstreamId,
          childSessionId: parent.id,
        });
      }
    }

    // SyncedSessionStore is now the single push path: the create() above pushes
    // title/provider/model/sessionType for the new workstream, and the
    // updateMetadata() above pushes the reparented child's parentSessionId.
    // Both reach iOS via the index channel without needing an explicit
    // pushChange here.

    return { workstreamId, promotedParent: true };
  }

  private async listWorktreesJson(metaSessionId: string, workspaceId: string): Promise<string> {
    const db = getDatabase();
    if (!db) {
      throw new Error('Database not initialized');
    }

    // Worktree rows are keyed by the project as opened, which a canonicalized
    // or case-variant caller path cannot be turned back into on its own (#1551);
    // the caller's own session row is what still knows that spelling.
    const workspaceKey = (await this.resolveSessionWorkspaceKey(metaSessionId, workspaceId)) ?? workspaceId;
    const worktreeStore = createWorktreeStore(db);
    const worktrees = await worktreeStore.list(workspaceKey);
    const summaries = await Promise.all(
      worktrees.map(async (worktree) => {
        const sessionIds = await worktreeStore.getWorktreeSessions(worktree.id);
        return {
          id: worktree.id,
          name: worktree.name,
          displayName: worktree.displayName || null,
          path: worktree.path,
          branch: worktree.branch,
          baseBranch: worktree.baseBranch,
          sessionCount: sessionIds.length,
          createdAt: worktree.createdAt,
          updatedAt: worktree.updatedAt ?? null,
        };
      })
    );

    return JSON.stringify(summaries, null, 2);
  }

  private async getSessionStatusJson(sessionId: string, workspaceId: string): Promise<string> {
    const workspaceKey = await this.resolveSessionWorkspaceKey(sessionId, workspaceId);
    const row = workspaceKey ? await this.getSessionStatusRow(sessionId, workspaceKey) : null;
    if (!row) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const status = row.status || 'idle';
    const result: Record<string, unknown> = {
      sessionId: row.id,
      title: row.title || 'Untitled Session',
      status,
      lastActivity: toMillis(row.last_activity),
      updatedAt: toMillis(row.updated_at),
      provider: row.provider,
      model: row.model || null,
      createdBySessionId: row.created_by_session_id || null,
      agentRole: row.agent_role || 'standard',
      waitingForInput: status === 'waiting_for_input',
    };

    return JSON.stringify(result, null, 2);
  }

  private async getSessionResultJson(
    sessionId: string,
    workspaceId: string,
    options: { includeFullResponse?: boolean } = {}
  ): Promise<string> {
    const data = await this.buildSessionResultData(
      sessionId,
      workspaceId,
      undefined,
      options.includeFullResponse ?? true
    );
    return JSON.stringify(data, null, 2);
  }

  private async listQueuedPromptsJson(
    sessionId: string,
    workspaceId: string,
    options: { includeCompleted?: boolean; includePromptText?: boolean } = {}
  ): Promise<string> {
    if (!sessionId) {
      throw new Error('sessionId is required');
    }

    const session = await AISessionsRepository.get(sessionId);
    if (!session || !sameWorkspaceIdentity(session.workspacePath, workspaceId)) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const { getQueuedPromptsStore } = await import('./RepositoryManager');
    const queueStore = getQueuedPromptsStore();
    const prompts = await queueStore.listForSession(sessionId, {
      includeCompleted: options.includeCompleted === true,
    });

    return JSON.stringify({
      sessionId,
      count: prompts.length,
      includeCompleted: options.includeCompleted === true,
      prompts: prompts.map((prompt) => ({
        id: prompt.id,
        status: prompt.status,
        createdAt: prompt.createdAt,
        claimedAt: prompt.claimedAt ?? null,
        completedAt: prompt.completedAt ?? null,
        errorMessage: prompt.errorMessage ?? null,
        promptPreview: prompt.prompt.length > 300
          ? `${prompt.prompt.slice(0, 300)}...`
          : prompt.prompt,
        ...(options.includePromptText === true ? { prompt: prompt.prompt } : {}),
      })),
    }, null, 2);
  }

  /**
   * Queue a prompt for another session, optionally stopping whatever that
   * session is doing first.
   *
   * `interrupt` is the tool-side twin of the transcript's send-now lightning
   * bolt (SessionTranscript.handleSendNowQueuedPrompt): stop the turn, then
   * drive the queue. Like the button, it drains FIFO -- if the target already
   * has pending rows, the interrupt delivers the oldest one, not necessarily
   * this prompt.
   */
  private async sendPromptToSession(
    originSessionId: string,
    sessionId: string,
    workspaceId: string,
    prompt: string,
    interrupt = false,
    messageKind: OrchestrationMessageKind = 'instruction',
    options?: { title?: unknown },
  ): Promise<string> {
    if (!this.aiService) {
      throw new Error('AI service not initialized');
    }
    if (!prompt?.trim()) {
      throw new Error('prompt is required');
    }

    const session = await AISessionsRepository.get(sessionId);
    if (!session || !sameWorkspaceIdentity(session.workspacePath, workspaceId)) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // The title is validated and its authority checked here, before anything is
    // queued or persisted (bypass branch included): a refusal leaves the queue
    // and the title exactly as they were.
    const requestedTitle = options?.title !== undefined
      ? await this.authorizeMemberRetitle(originSessionId, session, options.title)
      : null;

    // Validated by the guard above; this hands the same stored key back verbatim.
    const sessionWorkspaceKey = resolveStoredWorkspaceId(session.workspacePath, workspaceId);
    const normalizedPrompt = prompt.trim();
    const shouldBypassExecution = this.shouldBypassChildAgentExecutionForTests();
    const statusRow = await this.getSessionStatusRow(sessionId, sessionWorkspaceKey);
    const statusBeforeQueue = (statusRow?.status || 'idle') as SessionStatusValue;
    const promptProvenance: PromptProvenance = {
      actor: 'agent',
      origin: 'session-orchestration',
      messageKind,
      originSessionId,
    };

    if (requestedTitle) {
      await applySessionTitleThroughNaming(sessionId, requestedTitle);
    }

    if (shouldBypassExecution) {
      await this.persistSyntheticInputMessage(sessionId, normalizedPrompt, promptProvenance);
      return JSON.stringify({
        sessionId,
        queuedPromptId: null,
        prompt: normalizedPrompt,
        statusBeforeQueue,
        processingTriggered: false,
        interrupted: false,
        bypassedExecutionForTest: true,
      }, null, 2);
    }

    // Queue before interrupting: the drive that follows the interrupt has to
    // find this row, and an interrupt that lands first would just idle the
    // session with nothing waiting for it.
    const queued = await this.aiService.queuePromptForSession(
      sessionId,
      normalizedPrompt,
      undefined,
      { promptProvenance },
    );
    const status = (statusRow?.status || 'idle') as SessionStatusValue;
    const workspaceForDrive = session.worktreePath || session.workspacePath || workspaceId;
    const idleEnoughToDrive = status === 'idle' || status === 'interrupted' || status === 'error';
    const interruptSkippedReason = interrupt
      ? this.reasonToSkipInterrupt(status, session.provider)
      : null;
    const shouldInterrupt = interrupt && !interruptSkippedReason;

    let processingTriggered = idleEnoughToDrive;
    let interrupted = false;
    let interruptMethod: string | null = null;
    let driveOutcome: string | null = null;

    if (shouldInterrupt) {
      const result = await this.aiService.interruptCurrentTurn(sessionId);
      interrupted = result.success;
      interruptMethod = result.method ?? null;
      // The drive runs even when the interrupt found no live provider: a session
      // that only nominally reports running has nothing else coming to trigger it.
      //
      // 'send-now' rather than 'meta-agent' so a closed project window can be
      // opened to receive the prompt, matching the lightning bolt.
      const outcome = await this.aiService.driveQueuedPrompts(sessionId, workspaceForDrive, 'send-now');
      driveOutcome = outcome.kind;
      // A deferred drive is not a failure: the interrupt may not have settled
      // yet, and the driver arms a session-idle wake to dispatch when it does.
      processingTriggered = outcome.kind === 'dispatched';
    } else if (idleEnoughToDrive) {
      await this.aiService.triggerQueuedPromptProcessingForSession(
        sessionId,
        workspaceForDrive,
        'meta-agent'
      );
    }

    return JSON.stringify({
      sessionId,
      queuedPromptId: queued.id,
      prompt: queued.prompt,
      statusBeforeQueue: status,
      processingTriggered,
      interrupted,
      ...(interruptMethod ? { interruptMethod } : {}),
      ...(interruptSkippedReason ? { interruptSkippedReason } : {}),
      ...(driveOutcome ? { driveOutcome } : {}),
    }, null, 2);
  }

  /**
   * Authority of `send_prompt({ title })`: only the team root retitles, only a
   * member whose `teamChild.rootSessionId` is that root, never the root itself.
   * Returns the normalized title; throws before any side effect otherwise. The
   * title is a label: the member's mission, role and scope are never touched.
   */
  private async authorizeMemberRetitle(
    callerSessionId: string,
    target: { id: string; metadata?: unknown; agentRole?: string | null },
    rawTitle: unknown,
  ): Promise<string> {
    const refusal = 'Only the team root may retitle its own members through send_prompt title.';
    const caller = await AISessionsRepository.get(callerSessionId);
    const callerContext = resolveTeamContext(caller?.metadata as Record<string, unknown> | undefined, caller?.agentRole);
    if (!callerContext.teamMode) {
      throw new Error(refusal);
    }
    const targetContext = resolveTeamContext(target.metadata as Record<string, unknown> | undefined, target.agentRole);
    if (target.id === callerSessionId || targetContext.teamChild?.rootSessionId !== callerSessionId) {
      throw new Error(`${refusal} The target is not one of your own members.`);
    }
    return resolveRequestedMemberTitle(rawTitle);
  }

  /**
   * Why an `interrupt: true` request must not actually interrupt.
   *
   * - `waiting_for_input`: the session is parked on an interactive prompt.
   *   Interrupting aborts the question instead of answering it; the caller
   *   wants respond_to_prompt.
   * - `claude-code-cli`: a terminal-backed session drains its queue through the
   *   CLI flush path, not the provider queue driver. The transcript hides the
   *   lightning bolt for these for the same reason.
   * - Already idle: there is no turn in the way, so the ordinary drive applies.
   */
  private reasonToSkipInterrupt(
    status: SessionStatusValue,
    provider: string | undefined,
  ): string | null {
    if (provider === 'claude-code-cli') return 'terminal-session';
    if (status === 'waiting_for_input') return 'waiting-for-input';
    if (status === 'idle' || status === 'interrupted' || status === 'error') return 'session-not-running';
    return null;
  }

  private async notifyUserJson(
    callerSessionId: string,
    workspaceId: string,
    args: NotifyUserArgs
  ): Promise<string> {
    const title = args.title?.trim();
    const body = args.body?.trim();
    if (!title) {
      throw new Error('title is required');
    }
    if (!body) {
      throw new Error('body is required');
    }

    const targetSessionId = args.sessionId?.trim() || callerSessionId;
    const session = await AISessionsRepository.get(targetSessionId);
    if (!session || !sameWorkspaceIdentity(session.workspacePath, workspaceId)) {
      throw new Error(`Session ${targetSessionId} not found`);
    }

    if (!this.showNotificationWithResult) {
      throw new Error('Notification delivery is not initialized');
    }

    const boundedBody = body.length > 1000 ? `${body.slice(0, 997)}...` : body;
    const rawSourceLabel = session.title || session.provider || `Session ${targetSessionId.slice(0, 8)}`;
    const sourceLabel = rawSourceLabel.trim().slice(0, 60) || `Session ${targetSessionId.slice(0, 8)}`;
    const result = await this.showNotificationWithResult({
      title: composeNotificationTitle(sourceLabel, title),
      body: boundedBody,
      kind: 'agent-complete',
      sessionId: targetSessionId,
      workspacePath: resolveStoredWorkspaceId(session.workspacePath, workspaceId),
      sourceLabel,
      provider: 'agent',
      bypassFocusCheck: args.bypassFocusCheck === true,
      silent: args.silent === true,
      urgency: args.urgency || 'normal',
    });

    // Forced (#1268): `urgency: 'critical'` is the agent saying the human is
    // needed now, which is exactly the case the server's presence suppression
    // must not swallow. Anything below critical stays desktop-only.
    const isUrgent = args.urgency === 'critical';
    let mobilePush: MobilePushResult | null = null;
    if (isUrgent && this.requestMobilePush) {
      try {
        mobilePush = await this.requestMobilePush(targetSessionId, sourceLabel, boundedBody, {
          force: true,
          reason: 'notify_urgent',
        });
      } catch (err) {
        console.warn('[MetaAgentService] notify_user mobile push failed:', err);
      }
    }

    return JSON.stringify({
      tool: 'notify_user',
      deliveryChannel: mobilePush ? 'os_notification+mobile_push' : 'os_notification',
      mobilePushAttempted: mobilePush !== null,
      mobilePush: mobilePush ?? undefined,
      sessionId: targetSessionId,
      bypassFocusCheck: args.bypassFocusCheck === true,
      result,
    }, null, 2);
  }

  private async respondToPrompt(workspaceId: string, args: {
    sessionId: string;
    promptId: string;
    promptType: PromptType;
    response: Record<string, unknown>;
  }): Promise<string> {
    if (!this.aiService) {
      throw new Error('AI service not initialized');
    }

    const session = await AISessionsRepository.get(args.sessionId);
    if (!session || !sameWorkspaceIdentity(session.workspacePath, workspaceId)) {
      throw new Error(`Session ${args.sessionId} not found`);
    }

    const result = await this.aiService.respondToInteractivePrompt({
      sessionId: args.sessionId,
      promptId: args.promptId,
      promptType: args.promptType,
      response: args.response,
      respondedBy: 'desktop',
    });

    if (!result.success) {
      throw new Error(result.error || 'Failed to respond to prompt');
    }

    return JSON.stringify({
      sessionId: args.sessionId,
      promptId: args.promptId,
      promptType: args.promptType,
      success: true,
    }, null, 2);
  }

  private async listSpawnedSessionsJson(metaSessionId: string, workspaceId: string): Promise<string> {
    const sessions = await this.getSpawnedSessions(metaSessionId, workspaceId);
    return JSON.stringify(sessions, null, 2);
  }

  private async getSpawnedSessions(metaSessionId: string, workspaceId: string): Promise<Array<Record<string, unknown>>> {
    // Children are filed under the caller's own workspace key -- the spelling
    // the project was opened by, not the one a worktree caller resolves to
    // (#1551) -- so the caller's spelling finds no rows.
    const workspaceKey = (await this.resolveSessionWorkspaceKey(metaSessionId, workspaceId)) ?? workspaceId;
    const rows = await getSpawnedSessionRows(metaSessionId, workspaceKey);

    const sessions: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const data = await this.buildSessionResultData(row.id, workspaceKey, {
        title: row.title || 'Untitled Session',
        provider: row.provider,
        model: row.model || null,
        status: row.status || 'idle',
        lastActivity: toMillis(row.last_activity),
        createdAt: toMillis(row.created_at)!,
        updatedAt: toMillis(row.updated_at)!,
        worktreeId: row.worktree_id || null,
      }, false);
      sessions.push({
        sessionId: data.sessionId,
        title: data.title,
        provider: data.provider,
        model: data.model,
        status: data.status,
        lastActivity: data.lastActivity,
        originalPrompt: data.originalPrompt,
        lastResponse: data.lastResponse,
        editedFiles: data.editedFiles,
        pendingPrompt: data.pendingPrompt,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        worktreeId: data.worktreeId || null,
      });
    }

    return sessions;
  }

  private async handleChildSessionEvent(sessionId: string, eventType: 'session:completed' | 'session:error' | 'session:waiting' | 'session:interrupted'): Promise<void> {
    try {
      if (!this.aiService) {
        return;
      }

      const session = await AISessionsRepository.get(sessionId);
      if (!session || session.agentRole === 'meta-agent' || !session.createdBySessionId || !session.workspacePath) {
        return;
      }

      // Honor fire-and-forget (spawn_session writes notifyParent=false on the
      // child for /launch-new-session-style hand-offs), and owners that route
      // child settles to themselves (extensionSessionsService delivers those).
      if (isParentNotificationSuppressed(session.metadata)) {
        return;
      }

      const metaSession = await AISessionsRepository.get(session.createdBySessionId);
      if (!metaSession?.workspacePath) {
        return;
      }

      // NIM-6: session:completed fires on every turn idle, not only on terminal
      // completion. If the child still has more prompts queued AFTER the one
      // that just finished, this idle is a between-turn pause -- another
      // session:completed will follow once the queue drains. Suppress it; the
      // parent will be notified on the genuinely terminal idle (queue empty).
      //
      // The just-finished prompt is still in `executing` status at the moment
      // session:completed fires (MessageStreamingHandler marks it `completed`
      // only after endSession returns). So we count only `pending` rows --
      // counting `executing` would include the current turn itself and
      // suppress every notification, including the final terminal one.
      //
      // The other event types (error/waiting/interrupted) are always
      // meaningful and pass through.
      if (eventType === 'session:completed') {
        const { rows: pendingRows } = await databaseWorker.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM queued_prompts
           WHERE session_id = $1 AND status = 'pending'`,
          [sessionId]
        );
        const pendingCount = Number(pendingRows[0]?.count ?? '0');
        if (pendingCount > 0) {
          return;
        }
      }

      const metaStatusRow = await this.getSessionStatusRow(metaSession.id, metaSession.workspacePath);
      const metaStatus = (metaStatusRow?.status || 'idle') as SessionStatusValue;

      // The parent wrote the child's task (and any follow-ups); echoing them back
      // in the recap only spends the parent's context. get_session_result still
      // returns them.
      // Phase 1A.1: an architect's settle carries its Tool Manifest; that one
      // final message is kept whole here and judged against the manifest
      // contract when rendered (renderArchitectFinalReport), never cut blindly.
      const architectReport = eventType === 'session:completed'
        && resolveTeamContext(session.metadata as Record<string, unknown> | undefined, session.agentRole).teamChild?.role === 'architect';
      const result = await this.buildSessionResultData(sessionId, session.workspacePath, undefined, false, {
        excludeInputFromSessionId: session.createdBySessionId,
        wholeFinalOutput: architectReport,
      });

      // Phase 1A.1: a tool-permission prompt is the user's decision. Waking the
      // coordinator for it bought nothing in the pilot (six turns spent checking
      // a prompt the user was answering) and the child's settle still arrives
      // below. Questions and plan approvals keep waking it: those it can answer,
      // even when an older, unanswered permission prompt sits in front of them.
      if (eventType === 'session:waiting') {
        const pending = await this.listPendingInteractivePrompts(sessionId);
        const answerable = pending.find((prompt) => prompt.promptType !== 'permission_request') ?? null;
        if (pending.length > 0 && !answerable) {
          return;
        }
        if (answerable) {
          result.pendingPrompt = answerable;
        }
      }

      // NIM-6: real dedup gate. Drop notifications whose semantic content is
      // identical to the last one delivered for this child. The previous code
      // mixed in an always-incrementing counter, which made every signature
      // unique and the dedup useless. The signature is reset on
      // session:started/session:streaming (see start()), so it only collapses
      // duplicates within a single child turn -- not across turns.
      const signature = computeNotificationSignature(eventType, result);
      if (this.notificationSignatures.get(sessionId) === signature) {
        return;
      }
      this.notificationSignatures.set(sessionId, signature);

      // Phase 1B: a valid manifest is also stored as a `tool-manifest` tracker
      // item (content from the report, provenance from the sessions) and the
      // coordinator gets a short notice naming the item. TOO LONG and INVALID
      // reports are never stored, and persistence never blocks the update.
      const manifestStored = architectReport
        ? await this.persistArchitectManifestNotice({
          id: session.id,
          model: (session as { model?: string | null }).model ?? null,
          metadata: session.metadata,
          agentRole: session.agentRole,
        }, result, metaSession.workspacePath,
        // The coordinator's tracker tools are scoped to the workspace its
        // turns run in (its worktree when it has one, MessageStreamingHandler),
        // so the item is stored there or tracker_get/update cannot find it
        // (pilot G, 2026-10-14: stored under the project, looked up under the worktree).
        (await this.resolveSessionWorkspaceRoot(metaSession.id)) ?? metaSession.workspacePath)
        : null;
      const manifestNotice = manifestStored?.notice ?? null;

      if (result.pendingPrompt?.promptType === 'exit_plan_mode_request') {
        await this.ensurePlanTrackerItem(session.workspacePath, sessionId, result);
      }

      // NIB.25: the update itself names the stored item, so the coordinator
      // has the reference in the same turn as the manifest; the notice row
      // below still renders the Tool Manifest card.
      const notification = this.buildNotificationMessage(eventType, result, architectReport, manifestStored?.reference ?? null);

      // Supersede rather than append. The signature dedup above only collapses
      // duplicates within a single child turn (it resets on
      // session:started/session:streaming), so a child that cycles
      // idle -> running -> idle emits a fresh session:completed every cycle and
      // the parent accumulates one row per cycle per child. Those rows are not
      // independent facts: each is a snapshot of the same child, and the newest
      // is the only one still true by the time the parent reads it. Dropping the
      // stale pending row keeps the parent's queue proportional to the number of
      // children rather than to the number of turns they take.
      //
      await deletePendingChildUpdates(session.createdBySessionId, session.id);

      await this.aiService.queuePromptForSession(
        session.createdBySessionId,
        notification,
        undefined,
        {
          promptProvenance: {
            actor: 'agent',
            origin: 'child-session-update',
            messageKind: eventType === 'session:completed' ? 'report' : eventType === 'session:waiting' ? 'question' : 'error',
            originSessionId: session.id,
          },
        },
      );

      // Phase 1B: the notice follows the update it refers to, as a system status
      // line (TOOL_MANIFEST_NOTICE_CONTEXT) that renders the Tool Manifest card.
      // Both ride the single queue drive below: one wake, the update's turn
      // first. A system row never coalesces with agent rows nor enters the
      // inbox (coalesceQueuedPrompts.ts, sessionInbox.ts), so the notice is
      // its own short turn after the update; the coordinator already has the
      // item reference from the update itself (NIB.25), so nothing waits on it.
      if (manifestNotice) {
        // A notice the coordinator has not read yet is stale once a newer
        // manifest of the same architect is stored: the new notice says what
        // superseded what (the supersede-not-append rule of the update).
        await deletePendingToolManifestNotices(session.createdBySessionId, session.id);
        await this.aiService.queuePromptForSession(
          session.createdBySessionId,
          manifestNotice,
          undefined,
          TOOL_MANIFEST_NOTICE_CONTEXT,
        );
      }

      // Do not auto-re-drive the parent when THIS child settle was an error.
      // The [Child Session Update] notification above is still queued for
      // visibility, but re-triggering the parent's queue on every error settle
      // spins the meta-agent wakeup loop with no backoff (an antigravity 429
      // child settles instantly into 'error' every cycle). Native children
      // settle 'session:completed', so this gate is a no-op for them.
      // Team mode is the exception: a failed member must not leave its
      // coordinator asleep waiting for an update that never comes, so its
      // error settle wakes the coordinator, once per failure (the signature
      // gate above drops a repeated event of the same failure) and at most
      // TEAM_ERROR_WAKE_LIMIT times in a row before the member settles
      // successfully again (a backstop against a coordinator that keeps
      // re-prompting a member that keeps failing). The host only delivers the
      // failure: it retries nothing and decides nothing.
      let wakeParent = eventType !== 'session:error';
      const teamMember = resolveTeamContext(session.metadata as Record<string, unknown> | undefined, session.agentRole).teamChild != null;
      if (eventType === 'session:completed') {
        this.teamErrorWakes.delete(sessionId);
      } else if (eventType === 'session:error' && teamMember) {
        const errorWakes = this.teamErrorWakes.get(sessionId) ?? 0;
        if (errorWakes < TEAM_ERROR_WAKE_LIMIT) {
          this.teamErrorWakes.set(sessionId, errorWakes + 1);
          wakeParent = true;
        } else {
          console.warn(`[MetaAgentService] Team member ${sessionId} failed ${errorWakes + 1} times in a row; its update is queued but the coordinator is not woken again until the member settles successfully`);
        }
      }
      if (wakeParent && (metaStatus === 'idle' || metaStatus === 'interrupted' || metaStatus === 'error')) {
        await this.aiService.triggerQueuedPromptProcessingForSession(metaSession.id, metaSession.workspacePath, 'meta-agent');
      }
    } catch (error) {
      console.error(`[MetaAgentService] handleChildSessionEvent failed for session ${sessionId} (${eventType}):`, error);
    }
  }

  /**
   * Phase 1B: store a completed architect's valid manifest as a tracker item
   * of the coordinator's workspace and return the notice for the coordinator,
   * or null when nothing was stored (not a valid manifest, a replay, trackers
   * disabled, a failure or a timeout; failures are logged and never reach the
   * update). Persistence is serialized per team root and bounded in time.
   */
  private async persistArchitectManifestNotice(
    session: { id: string; model?: string | null; metadata?: unknown; agentRole?: string | null },
    result: SessionResultData,
    workspacePath: string,
    /** Where the item is stored: the workspace the coordinator's tracker tools resolve references in. */
    trackerWorkspacePath: string = workspacePath,
  ): Promise<{ notice: string; reference: string } | null> {
    try {
      if (!isTrackersAgentToolsEnabled(workspacePath)) return null;
      const rootSessionId = resolveTeamContext(session.metadata as Record<string, unknown> | undefined, session.agentRole).teamChild?.rootSessionId ?? null;
      if (!rootSessionId) return null;
      let finalOutput: string | null = null;
      for (let index = result.recentMessages.length - 1; index >= 0; index -= 1) {
        if (result.recentMessages[index].direction === 'output') { finalOutput = result.recentMessages[index].text; break; }
      }
      const settle = {
        sessionId: session.id,
        rootSessionId,
        workspacePath: trackerWorkspacePath,
        model: session.model ?? null,
        finalOutput: finalOutput ?? result.fullResponse ?? null,
      };
      // One persistence at a time per team: the plan reads the team's items and
      // numbers the new one, so two architects settling together must queue.
      const previous = this.manifestPersistenceChains.get(rootSessionId) ?? Promise.resolve();
      const chained = previous.catch(() => undefined).then(() =>
        withToolManifestTrackerPort(trackerWorkspacePath, (port) => persistArchitectManifest(settle, port)));
      this.manifestPersistenceChains.set(rootSessionId, chained);
      const release = () => {
        if (this.manifestPersistenceChains.get(rootSessionId) === chained) this.manifestPersistenceChains.delete(rootSessionId);
      };
      chained.then(release, release);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), this.manifestPersistenceTimeoutMs);
      });
      let outcome: Awaited<typeof chained> | 'timeout';
      try {
        outcome = await Promise.race([chained, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (outcome === 'timeout') {
        // Abandon the hung chain so the next settle of this team starts afresh.
        release();
        console.warn(`[MetaAgentService] Tool Manifest of session ${session.id} not stored within ${this.manifestPersistenceTimeoutMs} ms; the update goes out without a notice`);
        return null;
      }
      if (!outcome.persisted) {
        if (outcome.reason === 'failed') {
          console.error(`[MetaAgentService] Tool Manifest of session ${session.id} not stored: ${outcome.detail}`);
        }
        return null;
      }
      return { notice: buildToolManifestNotice(outcome), reference: buildToolManifestReference(outcome) };
    } catch (error) {
      console.error(`[MetaAgentService] Tool Manifest persistence failed for session ${session.id}:`, error);
      return null;
    }
  }

  private buildNotificationMessage(
    eventType: 'session:completed' | 'session:error' | 'session:waiting' | 'session:interrupted',
    result: SessionResultData,
    // Phase 1A.1: render the final output as an architect's manifest (see renderArchitectFinalReport).
    architectReport: boolean = false,
    // NIB.25: the stored manifest's reference line, when one was stored for this update.
    manifestReference: string | null = null,
  ): string {
    const lines = [
      '[Child Session Update]',
      `Session: "${result.title}" (${result.sessionId})`,
      `Status: ${result.status}`,
      `Event: ${eventType}`,
    ];
    if (manifestReference) lines.push(manifestReference);

    // The original task is deliberately not repeated here. This notification is
    // only ever queued to the child's `createdBySessionId`, which is the session
    // that wrote that prompt in the first place -- it is already in the parent's
    // own transcript. Re-embedding up to 2,000 characters of it in every update
    // was the largest part of each row, repeated once per child turn. The title
    // and session id above are enough to identify the child; `get_session_result`
    // returns the full prompt when a parent genuinely needs it.
    if (result.recentMessages.length > 0) {
      lines.push('Recent messages:');
      let finalOutputIndex = -1;
      if (architectReport) {
        for (let index = result.recentMessages.length - 1; index >= 0; index -= 1) {
          if (result.recentMessages[index].direction === 'output') { finalOutputIndex = index; break; }
        }
      }
      result.recentMessages.forEach((message, index) => {
        const label = message.direction === 'input' ? 'User' : 'Assistant';
        lines.push(`- ${label}: ${index === finalOutputIndex ? renderArchitectFinalReport(message.text) : message.text}`);
      });
    } else if (result.lastResponse) {
      lines.push(`Last response: ${result.lastResponse}`);
    }
    if (result.editedFiles.length > 0) {
      lines.push('Files modified:');
      for (const filePath of result.editedFiles) {
        lines.push(`- ${filePath}`);
      }
    }
    const toolScopeLine = describeChildToolScope(result.toolScope, result.toolScopeEnforced === true, result.provider);
    if (toolScopeLine) {
      lines.push(toolScopeLine);
    }
    // A team member's provider and whether it differs from the coordinator's,
    // so a same-provider second opinion is never reported as independent by provider.
    const providerLine = describeTeamMemberProvider(result.teamRole, result.provider, result.model, result.providerDiversity);
    if (providerLine) {
      lines.push(providerLine);
    }
    if (result.errorMessage) {
      lines.push(`Error: ${result.errorMessage}`);
    }
    // Keep the actionable prompt last so the parent session cannot miss the
    // question beneath ordinary recap or error text.
    if (result.pendingPrompt && result.pendingPrompt.promptType === 'permission_request') {
      // Phase 1A.1: a tool permission is the user's decision, never the coordinator's.
      const toolName = result.pendingPrompt.content?.toolName || result.pendingPrompt.content?.request?.tool || 'unknown';
      lines.push('');
      lines.push(`WAITING ON THE USER. Tool requesting permission: ${toolName}. That permission is the user's decision; do not answer it. The member reports when it settles.`);
    } else if (result.pendingPrompt) {
      lines.push('');
      lines.push(`ACTION REQUIRED: This session is blocked on an interactive prompt.`);
      lines.push(`Use respond_to_prompt with these arguments:`);
      lines.push(`  sessionId: "${result.sessionId}"`);
      lines.push(`  promptId: "${result.pendingPrompt.promptId}"`);
      lines.push(`  promptType: "${result.pendingPrompt.promptType}"`);

      if (result.pendingPrompt.promptType === 'ask_user_question_request') {
        const questions = result.pendingPrompt.content?.questions;
        if (Array.isArray(questions)) {
          lines.push('  Questions:');
          for (const q of questions) {
            const questionText = q.question || q.text || JSON.stringify(q);
            lines.push(`    - ${questionText}`);
            if (Array.isArray(q.options)) {
              for (const opt of q.options) {
                const label = typeof opt === 'string' ? opt : opt.label || opt.value || JSON.stringify(opt);
                lines.push(`      * ${label}`);
              }
            }
          }
        }
        lines.push(`  response format: { "answers": { "<question text>": "<your answer>" } }`);
      } else if (result.pendingPrompt.promptType === 'exit_plan_mode_request') {
        if (result.pendingPrompt.content?.planFilePath) {
          lines.push(`  Plan file: ${result.pendingPrompt.content.planFilePath}`);
        }
        lines.push(`  response: { "approved": true }`);
      }
    }
    return lines.join('\n');
  }

  private async buildSessionResultData(
    sessionId: string,
    workspaceId: string,
    prefetchedSession?: { title: string; provider: string; model: string | null; status: string; lastActivity: number | null; createdAt: number; updatedAt: number; worktreeId: string | null },
    // Skip the heavier full-turn extract when the caller only needs preview
    // fields (the list and notification paths discard fullResponse).
    includeFullResponse: boolean = true,
    options: { excludeInputFromSessionId?: string; wholeFinalOutput?: boolean } = {}
  ): Promise<SessionResultData> {
    let sessionTitle: string;
    let sessionProvider: string;
    let sessionModel: string | null;
    let sessionStatus: SessionStatusValue;
    let sessionLastActivity: number | null;
    let sessionCreatedAt: number;
    let sessionUpdatedAt: number;
    let sessionWorktreeId: string | null;
    let sessionToolScope: string | null = null;
    let sessionTeamRole: TeamRole | null = null;
    let sessionProviderDiversity: TeamProviderDiversity | null = null;

    if (prefetchedSession) {
      sessionTitle = prefetchedSession.title;
      sessionProvider = prefetchedSession.provider;
      sessionModel = prefetchedSession.model;
      sessionStatus = prefetchedSession.status as SessionStatusValue;
      sessionLastActivity = prefetchedSession.lastActivity;
      sessionCreatedAt = prefetchedSession.createdAt;
      sessionUpdatedAt = prefetchedSession.updatedAt;
      sessionWorktreeId = prefetchedSession.worktreeId;
    } else {
      const session = await AISessionsRepository.get(sessionId);
      if (!session || !sameWorkspaceIdentity(session.workspacePath, workspaceId)) {
        throw new Error(`Session ${sessionId} not found`);
      }
      const statusRow = await this.getSessionStatusRow(sessionId, resolveStoredWorkspaceId(session.workspacePath, workspaceId));
      sessionTitle = session.title || 'Untitled Session';
      sessionProvider = session.provider;
      sessionModel = session.model || null;
      sessionStatus = (statusRow?.status || 'idle') as SessionStatusValue;
      sessionLastActivity = toMillis(statusRow?.last_activity);
      sessionCreatedAt = session.createdAt;
      sessionUpdatedAt = session.updatedAt;
      sessionWorktreeId = session.worktreeId || null;
      sessionToolScope =
        ((session.metadata as Record<string, unknown> | undefined)?.toolScope as string | undefined) ?? null;
      // A team member reports its provider against its root's (teamProviderDiversity).
      const teamChild = resolveTeamContext(session.metadata as Record<string, unknown> | undefined, session.agentRole).teamChild;
      if (teamChild) {
        sessionTeamRole = teamChild.role;
        const rootProvider = await AISessionsRepository.get(teamChild.rootSessionId)
          .then((root) => root?.provider ?? null)
          .catch(() => null);
        sessionProviderDiversity = teamProviderDiversity(sessionProvider, rootProvider);
      }
    }

    // Every "latest" field below (recent messages, last/full response, error,
    // newest prompts) must come from the NEWEST rows. list({ limit }) returns the
    // oldest rows (ascending id + LIMIT), which froze a reused member's report at
    // its first 500 messages; listTail returns the newest rows in ascending order.
    const messages = await AgentMessagesRepository.listTail(sessionId, SESSION_RESULT_MESSAGE_WINDOW);
    const userPrompts = await this.userPromptsWithOriginal(sessionId, messages);
    const recentMessages = this.extractRecentMessages(
      messages,
      3,
      undefined,
      options.excludeInputFromSessionId,
      // Phase 1A.1: an architect's final report is judged by renderArchitectFinalReport, not cut here.
      options.wholeFinalOutput ? Number.MAX_SAFE_INTEGER : undefined,
    );
    const pendingPrompt = await this.getPendingInteractivePrompt(sessionId);

    let editedFiles: string[] = [];
    try {
      const fileLinks = await SessionFilesRepository.getFilesBySession(sessionId, 'edited');
      // #1244: these rows are the per-edit-EVENT history (deduped upstream on
      // toolUseId, not on path), so a file edited twenty times appears twenty
      // times. Consumers here want the set of files touched -- collapse to
      // unique paths, keeping first-edit order.
      editedFiles = [
        ...new Set(fileLinks.map((file: any) => this.stripWorkspacePath(file.filePath, workspaceId))),
      ];
    } catch {
      editedFiles = [];
    }

    return {
      sessionId,
      title: sessionTitle,
      provider: sessionProvider,
      model: sessionModel,
      status: sessionStatus,
      lastActivity: sessionLastActivity,
      originalPrompt: userPrompts[0] || null,
      userPrompts,
      lastResponse: this.extractLastAgentResponse(messages),
      fullResponse: includeFullResponse ? this.extractLastAgentTurn(messages, 50000) : null,
      recentMessages,
      editedFiles,
      pendingPrompt,
      errorMessage: this.extractErrorMessage(messages),
      createdAt: sessionCreatedAt,
      updatedAt: sessionUpdatedAt,
      worktreeId: sessionWorktreeId,
      toolScope: sessionToolScope,
      // Only a restricted scope makes enforcement a meaningful question.
      toolScopeEnforced:
        sessionToolScope === 'read' || sessionToolScope === 'review' || sessionToolScope === 'write'
          ? isToolScopeEnforced(sessionProvider, sessionToolScope)
          : undefined,
      ...(sessionTeamRole ? { teamRole: sessionTeamRole, providerDiversity: sessionProviderDiversity } : {}),
    };
  }

  /**
   * The user prompts in `latest`, preceded by the session's original prompt when
   * the window no longer reaches the start of the session (originalPrompt is the
   * first entry). A window that starts at the session's first row is the whole
   * session, so no extra read is needed.
   */
  private async userPromptsWithOriginal(sessionId: string, latest: AgentMessage[]): Promise<string[]> {
    const prompts = extractUserPrompts(latest);
    if (latest.length < SESSION_RESULT_MESSAGE_WINDOW) {
      return prompts;
    }
    const head = await AgentMessagesRepository.list(sessionId, { limit: SESSION_RESULT_HEAD_WINDOW });
    const windowStart = latest[0]?.id;
    if (head.length === 0 || windowStart === undefined || head[0].id === windowStart) {
      return prompts;
    }
    // Only rows before the window: a prompt the window already holds is not repeated.
    const original = extractUserPrompts(head.filter((message) => (message.id ?? 0) < windowStart))[0];
    return original ? [original, ...prompts] : prompts;
  }

  /** Every unanswered interactive prompt of a session, oldest first (Phase 1A.1 reads the whole list). */
  private async listPendingInteractivePrompts(sessionId: string): Promise<PendingInteractivePrompt[]> {
    const pending: PendingInteractivePrompt[] = [];
    // Interactive prompts are persisted in three different formats:
    // 1. AskUserQuestion:  { type: "nimbalyst_tool_use", name: "AskUserQuestion", id: "...", input: { questions } }
    // 2. ToolPermission:   { type: "nimbalyst_tool_use", name: "ToolPermission", id: "...", input: { requestId, toolName, ... } }
    // 3. ExitPlanMode:     { type: "exit_plan_mode_request", status: "pending", requestId: "..." }
    const { rows } = await databaseWorker.query<{
      id: string;
      content: string;
      created_at: Date;
    }>(
      `SELECT id, content, created_at
       FROM ai_agent_messages
       WHERE session_id = $1
         AND (hidden = FALSE OR hidden IS NULL)
         AND (
           (content LIKE '%"type":"exit_plan_mode_request"%' AND content LIKE '%"status":"pending"%')
           OR (content LIKE '%"type":"nimbalyst_tool_use"%' AND content LIKE '%"name":"AskUserQuestion"%')
           OR (content LIKE '%"type":"nimbalyst_tool_use"%' AND content LIKE '%"name":"ToolPermission"%')
         )
       ORDER BY created_at ASC`,
      [sessionId]
    );

    for (const row of rows) {
      try {
        const content = JSON.parse(row.content);

        // Handle nimbalyst_tool_use format (AskUserQuestion and ToolPermission)
        if (content.type === 'nimbalyst_tool_use') {
          const promptId = content.id || content.input?.requestId;
          if (!promptId) {
            continue;
          }

          // Check if there's already a response for this prompt
          const escapedPromptId = this.escapeLikePattern(promptId);
          const { rows: resultRows } = await databaseWorker.query<{ id: string }>(
            `SELECT id
             FROM ai_agent_messages
             WHERE session_id = $1
               AND (
                 (content LIKE '%"type":"nimbalyst_tool_result"%' AND content LIKE $2)
                 OR (content LIKE '%"type":"ask_user_question_response"%' AND content LIKE $2)
                 OR (content LIKE '%"type":"permission_response"%' AND content LIKE $2)
               )
             LIMIT 1`,
            [sessionId, `%"${escapedPromptId}"%`]
          );

          if (resultRows.length > 0) {
            continue;
          }

          if (content.name === 'AskUserQuestion') {
            pending.push({
              id: row.id,
              promptId,
              promptType: 'ask_user_question_request',
              createdAt: toMillis(row.created_at)!,
              content: {
                ...content,
                questions: content.input?.questions || [],
                questionId: promptId,
              },
            });
            continue;
          }

          if (content.name === 'ToolPermission') {
            pending.push({
              id: row.id,
              promptId: content.input?.requestId || promptId,
              promptType: 'permission_request',
              createdAt: toMillis(row.created_at)!,
              content: {
                type: 'permission_request',
                requestId: content.input?.requestId || promptId,
                toolName: content.input?.toolName || 'unknown',
                rawCommand: content.input?.rawCommand || '',
                pattern: content.input?.pattern || '',
                patternDisplayName: content.input?.patternDisplayName || '',
                isDestructive: content.input?.isDestructive || false,
                warnings: content.input?.warnings || [],
                status: 'pending',
              },
            });
            continue;
          }

          continue;
        }

        // Handle exit_plan_mode_request format
        if (content.type === 'exit_plan_mode_request' && content.status === 'pending') {
          const promptId = content.requestId;
          if (!promptId) {
            continue;
          }

          const escapedPromptId = this.escapeLikePattern(promptId);
          const { rows: responseRows } = await databaseWorker.query<{ id: string }>(
            `SELECT id
             FROM ai_agent_messages
             WHERE session_id = $1
               AND content LIKE '%"type":"exit_plan_mode_response"%'
               AND content LIKE $2
             LIMIT 1`,
            [sessionId, `%"requestId":"${escapedPromptId}"%`]
          );

          if (responseRows.length > 0) {
            continue;
          }

          pending.push({
            id: row.id,
            promptId,
            promptType: 'exit_plan_mode_request',
            createdAt: toMillis(row.created_at)!,
            content,
          });
          continue;
        }
      } catch {
        continue;
      }
    }

    return pending;
  }

  /** The oldest unanswered interactive prompt of a session, or null. */
  private async getPendingInteractivePrompt(sessionId: string): Promise<PendingInteractivePrompt | null> {
    return (await this.listPendingInteractivePrompts(sessionId))[0] ?? null;
  }

  /** Status read, scoped to the key the session is stored under. */
  private getSessionStatusRow(sessionId: string, workspaceId: string): Promise<any | null> {
    return querySessionStatusRow(sessionId, workspaceId);
  }

  /**
   * The spelling a session row is stored under, for a tool called with
   * `workspaceId` — or null when that session belongs to another project.
   * `ai_sessions.workspace_id` holds the path the project was opened by, which
   * is not always the path the caller arrives with (#1551), so workspace-scoped
   * queries run under the session's key rather than the caller's.
   */
  private async resolveSessionWorkspaceKey(sessionId: string, workspaceId: string): Promise<string | null> {
    if (!sessionId) {
      return null;
    }
    const session = await AISessionsRepository.get(sessionId);
    if (!session || !sameWorkspaceIdentity(session.workspacePath, workspaceId)) {
      return null;
    }
    return resolveStoredWorkspaceId(session.workspacePath, workspaceId);
  }

  private async ensurePlanTrackerItem(workspaceId: string, sessionId: string, result: SessionResultData): Promise<void> {
    const pendingPrompt = result.pendingPrompt;
    if (!pendingPrompt || pendingPrompt.promptType !== 'exit_plan_mode_request') {
      return;
    }

    const sourceRef = `meta-agent-plan:${sessionId}:${pendingPrompt.promptId}`;
    const { rows: existing } = await databaseWorker.query<{ id: string }>(
      `SELECT id FROM tracker_items WHERE workspace = $1 AND source_ref = $2 LIMIT 1`,
      [workspaceId, sourceRef]
    );
    if (existing.length > 0) {
      return;
    }

    const trackerId = randomUUID();
    const title = `Plan review: ${result.title}`;
    const description = typeof pendingPrompt.content.planFilePath === 'string'
      ? `Plan generated by child session ${sessionId}.\nPlan file: ${pendingPrompt.content.planFilePath}`
      : `Plan generated by child session ${sessionId}.`;

    const data = {
      title,
      status: 'in-review',
      priority: 'medium',
      created: new Date().toISOString().split('T')[0],
      description,
      tags: ['meta-agent', 'plan-review'],
      childSessionId: sessionId,
    };

    await databaseWorker.query(
      `INSERT INTO tracker_items (
        id, type, data, workspace, document_path, line_number,
        created, updated, last_indexed, sync_status,
        content, archived, source, source_ref
      ) VALUES ($1, $2, $3, $4, '', NULL, NOW(), NOW(), NOW(), 'pending', $5, FALSE, $6, $7)`,
      [
        trackerId,
        'plan',
        JSON.stringify(data),
        workspaceId,
        JSON.stringify({
          planFilePath: pendingPrompt.content.planFilePath || null,
          allowedPrompts: pendingPrompt.content.allowedPrompts || [],
        }),
        'meta-agent',
        sourceRef,
      ]
    );

    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('document-service:tracker-items-changed', {
          added: [],
          updated: [],
          removed: [],
          timestamp: new Date(),
        });
      }
    }
  }

  private extractLastAgentResponse(messages: Array<{ direction: string; content: string; metadata?: Record<string, unknown> | null }>, maxLength: number = 500): string | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.direction !== 'output') continue;
      const extracted = extractMessageText(message.content, message.metadata);
      if (extracted) {
        return extracted.length > maxLength ? `${extracted.slice(0, maxLength)}...` : extracted;
      }
    }
    return null;
  }

  /**
   * The child's full final turn: every output message since the last input
   * (user) message, joined. extractLastAgentResponse returns only the single
   * last output message, which decapitates a child whose substance spans
   * several output messages (tool narration then a final answer). Capped, with
   * an explicit marker when truncated so the reader knows content was dropped.
   */
  private extractLastAgentTurn(
    messages: Array<{ direction: string; content: string; metadata?: Record<string, unknown> | null }>,
    maxLength: number = 50000
  ): string | null {
    let lastInputIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].direction === 'input') {
        lastInputIndex = index;
        break;
      }
    }
    const parts: string[] = [];
    for (let index = lastInputIndex + 1; index < messages.length; index += 1) {
      const message = messages[index];
      if (message.direction !== 'output') continue;
      const text = extractMessageText(message.content, message.metadata);
      if (text) parts.push(text);
    }
    if (lastInputIndex === -1 || parts.length === 0) {
      // No input row to anchor the turn (or no output after it): use the single
      // last output message rather than concatenating output across turns.
      return this.extractLastAgentResponse(messages, maxLength);
    }
    const sep = String.fromCharCode(10) + String.fromCharCode(10);
    const joined = parts.join(sep);
    return joined.length > maxLength
      ? joined.slice(0, maxLength) + sep + '[truncated: turn exceeded ' + maxLength + ' characters]'
      : joined;
  }

  private extractRecentMessages(
    messages: Array<{ direction: string; content: string; metadata?: Record<string, unknown> | null }>,
    limit: number,
    // Cap each message so a verbose child cannot inline an unbounded block
    // into the auto-injected [Child Session Update] notification.
    maxPerMessage: number = 2000,
    // Skip input rows this session sent (its own task and follow-ups), keeping
    // the recap to what the child said and what anyone else asked it.
    excludeInputFromSessionId?: string,
    // The newest output message is the child's report. Cut at maxPerMessage it
    // almost always arrived incomplete, and the parent then fetched the whole
    // result (several times larger) just to read its ending.
    maxFinalOutput: number = CHILD_UPDATE_FINAL_REPORT_MAX_CHARS
  ): Array<{ direction: 'input' | 'output'; text: string }> {
    const collected: Array<{ direction: 'input' | 'output'; text: string }> = [];
    let finalOutputSeen = false;
    for (let index = messages.length - 1; index >= 0 && collected.length < limit; index -= 1) {
      const message = messages[index];
      if (
        excludeInputFromSessionId &&
        message.direction === 'input' &&
        promptOriginSessionId(message.metadata) === excludeInputFromSessionId
      ) {
        continue;
      }
      const text = extractMessageText(message.content, message.metadata);
      if (!text) {
        continue;
      }
      const isOutput = message.direction !== 'input';
      const cap = isOutput && !finalOutputSeen ? Math.max(maxPerMessage, maxFinalOutput) : maxPerMessage;
      if (isOutput) finalOutputSeen = true;
      collected.push({
        direction: isOutput ? 'output' : 'input',
        text: text.length > cap
          ? `${text.slice(0, cap)}... [truncated: ${text.length - cap} more characters; get_session_result has the full text]`
          : text,
      });
    }
    return collected.reverse();
  }

  private extractErrorMessage(messages: Array<{ direction: string; content: string }>): string | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      try {
        const parsed = JSON.parse(message.content);
        if (typeof parsed.error === 'string' && parsed.error.trim()) {
          return parsed.error.trim();
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  private deriveTitleFromPrompt(prompt?: string): string | null {
    if (!prompt?.trim()) {
      return null;
    }
    const firstLine = prompt.trim().split('\n')[0].trim();
    if (!firstLine) {
      return null;
    }
    return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
  }

  private escapeLikePattern(value: string): string {
    return value.replace(/[%_\\]/g, '\\$&');
  }

  // Workspace-relative paths use forward slashes on every platform, like the
  // rest of the app, so the same file reads the same on Windows.
  private stripWorkspacePath(filePath: string, workspacePath: string): string {
    if (!workspacePath) return filePath;
    return path.relative(workspacePath, filePath).split(path.sep).join('/');
  }
}
