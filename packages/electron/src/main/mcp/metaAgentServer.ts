import type { OrchestrationMessageKind } from '@nimbalyst/runtime/ai/server/types';
/**
 * Meta-agent (child-session orchestration) tool surface — `create_session`,
 * `spawn_session`, `send_prompt`, `list_queued_prompts`, `respond_to_prompt`,
 * `get_session_status`, `get_session_result`, `list_spawned_sessions`,
 * `list_worktrees`.
 *
 * MCP consolidation: these tools are served by the unified internal MCP HTTP
 * server's `/mcp/host` endpoint (`nimbalyst-host`). This module exports the tool
 * defs + an endpoint-agnostic dispatch fn (shared with the extension-agent
 * `toolExecutor` broker); the standalone HTTP server it used to run was retired
 * in Phase 7. `MetaAgentService` still injects the tool fns via
 * `setMetaAgentToolFns`.
 */

import { resolveCallerWorkspaceId } from "../utils/workspaceIdentity";
import { runProjectTests } from "../services/team/projectTestRunner";
import { getEnhancedPath } from "../services/shellEnvironment";
import { eccCatalogLookupTool } from "../services/ecc/eccCatalogService";

type CreateSessionArgs = {
  title?: string;
  provider?: string;
  model?: string;
  prompt?: string;
  useWorktree?: boolean;
  worktreeId?: string;
  toolScope?: string;
  effortLevel?: string;
  role?: string;
};

type SpawnSessionArgs = {
  title?: string;
  prompt: string;
  useWorktree?: boolean;
  model?: string;
  notifyOnComplete?: boolean;
  /**
   * When true, the new session is created at the top level — no parent,
   * no workstream container, no shared files-edited or tabs with the
   * caller. Use for fix-and-commit-separately work that should not pollute
   * the caller's workstream. When false (the default), the new session is
   * spawned as a sibling under the caller's workstream.
   */
  isolated?: boolean;
  effortLevel?: string;
  role?: string;
};

type RespondToPromptArgs = {
  sessionId: string;
  promptId: string;
  promptType:
    | "permission_request"
    | "ask_user_question_request"
    | "exit_plan_mode_request";
  response: Record<string, unknown>;
};

type GetSessionResultArgs = {
  sessionId: string;
  /**
   * Include the full last-agent-turn text (capped at 50,000 chars). Defaults
   * to true for backward compatibility. Pass false for a compact response
   * (status/prompts/recentMessages/editedFiles only) when the caller doesn't
   * need the full turn text -- e.g. a supervising session polling many
   * children, where the full text would otherwise be reinjected into its
   * context on every poll.
   */
  includeFullResponse?: boolean;
};

type ListQueuedPromptsArgs = {
  sessionId: string;
  /**
   * Include completed and failed queue rows in addition to pending/executing
   * rows. Defaults to false so the default view answers "what is still stuck?"
   */
  includeCompleted?: boolean;
  /**
   * Include full prompt text. Defaults to false; the response always includes a
   * bounded preview so callers can identify rows without dumping huge prompts.
   */
  includePromptText?: boolean;
};

type NotifyUserArgs = {
  title: string;
  body: string;
  sessionId?: string;
  bypassFocusCheck?: boolean;
  silent?: boolean;
  urgency?: "normal" | "critical" | "low";
};

interface MetaAgentToolFns {
  listWorktrees: (
    metaSessionId: string,
    workspaceId: string
  ) => Promise<string>;
  createSession: (
    metaSessionId: string,
    workspaceId: string,
    args: CreateSessionArgs
  ) => Promise<string>;
  spawnSession: (
    callerSessionId: string,
    workspaceId: string,
    args: SpawnSessionArgs
  ) => Promise<string>;
  getSessionStatus: (
    metaSessionId: string,
    workspaceId: string,
    targetSessionId: string
  ) => Promise<string>;
  getSessionResult: (
    metaSessionId: string,
    workspaceId: string,
    targetSessionId: string,
    options?: Pick<GetSessionResultArgs, "includeFullResponse">
  ) => Promise<string>;
  listQueuedPrompts: (
    metaSessionId: string,
    workspaceId: string,
    targetSessionId: string,
    options?: Pick<ListQueuedPromptsArgs, "includeCompleted" | "includePromptText">
  ) => Promise<string>;
  sendPrompt: (
    metaSessionId: string,
    workspaceId: string,
    targetSessionId: string,
    prompt: string,
    interrupt?: boolean,
    messageKind?: OrchestrationMessageKind
  ) => Promise<string>;
  notifyUser: (
    metaSessionId: string,
    workspaceId: string,
    args: NotifyUserArgs
  ) => Promise<string>;
  respondToPrompt: (
    metaSessionId: string,
    workspaceId: string,
    args: RespondToPromptArgs
  ) => Promise<string>;
  listSpawnedSessions: (
    metaSessionId: string,
    workspaceId: string
  ) => Promise<string>;
}

let toolFns: MetaAgentToolFns | null = null;

export function setMetaAgentToolFns(fns: MetaAgentToolFns): void {
  toolFns = fns;
}

/**
 * OpenAI-shaped tool definition. Mirrors the chat-completions function-calling
 * format that host-supplied tool loops (e.g. the Gemini provider's
 * ToolLoopProtocol) consume. Built-in providers ignore this — they discover the
 * same tools over the SSE MCP server instead.
 */
export interface MetaAgentOpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/**
 * The single source-of-truth list of meta-agent tools, in MCP
 * `{ name, description, inputSchema }` shape. Both the SSE MCP server's
 * ListTools handler (built-in providers) and `getMetaAgentOpenAITools`
 * (extension-agent providers) read from this so the two presentation paths
 * never drift.
 */
export const META_AGENT_TOOL_DEFS: Array<{
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}> = [
  {
    name: "list_worktrees",
    description:
      "List the available git worktrees for this workspace so you can attach a child session to an existing branch or decide whether to create a fresh worktree.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "create_session",
    description:
      "Spawn a new child session for a focused task. Can optionally create a dedicated worktree or attach the session to an existing worktree, then seed it with an initial prompt. Pass toolScope to control the child's capabilities: use \"read\" or \"write\" for analyze/research tasks so the child cannot run builds or claim to have run them; \"full\" (default) grants run_command.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Optional title for the child session.",
        },
        provider: {
          type: "string",
          description:
            "Optional. OMIT to inherit the calling session provider and model (recommended: a Gemini meta-agent then spawns Gemini children). Set this only to deliberately run the child on a different provider, and if you set it, also pass a matching model (e.g. provider claude-code with model claude-code:opus). Do NOT set claude-code with a non-claude-code model. In Team mode a member's provider is its role default unless you name one, and a named provider is accepted only when the host enforces the member's tool scope and role policy on it and it is enabled here; otherwise the call fails with an explicit \"provider unavailable\" error, creates nothing and never falls back to another provider. The result's providerDiversity says whether the member runs on a provider other than the team root's.",
        },
        model: {
          type: "string",
          description: "Optional explicit model identifier.",
        },
        prompt: {
          type: "string",
          description: "Optional initial prompt to queue for the child session immediately after creation.",
        },
        useWorktree: {
          type: "boolean",
          description:
            "Ignored. Child sessions always run in the SHARED workspace so you (the parent) can read the files they write and synthesize them. A fresh worktree would isolate the child's deliverable where you cannot reach it. Tell the child to save deliverables to the workspace root.",
        },
        worktreeId: {
          type: "string",
          description: "Ignored. Children run in the shared workspace (see useWorktree).",
        },
        toolScope: {
          type: "string",
          enum: ["read", "review", "write", "full"],
          description:
            "Capability scope for the child. \"read\" = read_file/list_files/search_files only (pure investigation). \"review\" = read plus run_project_tests (the workspace's own test command), no edits and no shell. \"write\" = those plus write_file but NO run_command, so the child can save a file deliverable (e.g. a report) yet cannot build/test/run anything. \"full\" (default) = all tools including run_command. read and review also have no web access (WebFetch/WebSearch), no Skill tool (skill files can declare hooks that run shell commands), and see no MCP servers beyond Nimbalyst's own first-party ones (no user servers, plugin servers or claude.ai connectors); their settings and plugin hooks do not run, and a prompt that starts with a slash reaches them as plain text, never as a command. Use read or write for analyze/research tasks so the child physically cannot run a build, and reserve full for tasks that must build/test.",
        },
        role: {
          type: "string",
          enum: ["explorer", "implementer", "reviewer", "architect", "advisor", "other"],
          description:
            "Team mode only (ignored outside a Team mode team). Every role defaults to Sonnet except architect and advisor (Opus). explorer: research/reading, effort medium, read-only tools. implementer: makes changes, effort medium, full tools. reviewer: independent review, effort high, review scope (reads, and runs the project's tests only through run_project_tests; never edits, never runs a shell). architect: prepares a complex or critical task before anyone executes it, effort high, read scope always (any other toolScope is lowered to read); it cannot ask the user (AskUserQuestion, plan mode), delegate or create tasks, and its final report is a Tool Manifest (M-<n>: oracle, acceptance criteria, team plan, ECC capabilities, tools and MCP per role, required tests, risks, open questions) that recommends and never grants anything. advisor (Independent Advisor): a second, independent opinion on the team's direction (the plan, the strategy, the implementation and the reviewer's verdict as a whole: wrong premises, missed alternatives, over- or under-engineering, risks nobody saw), effort high, read scope always; like the architect it cannot ask the user, delegate or create tasks; it is not a second reviewer and never implements or corrects anything; create it only when you explicitly decide a second opinion is worth it (critical, architectural, security, persistence, migration, public-contract or irreversible work, a conflict between members, or the user asked), never by default. other: effort medium. The role is the member's main responsibility, not a limit on what it may notice: pass `mission` for the specific focus of this session. An explicit model, effortLevel or toolScope wins, except that a reviewer always gets the review scope (full or write is lowered to review) and an architect or advisor always gets read; promote (e.g. claude-code:opus + high) only when the task needs it. Omitted means other. A team may have at most 3 sessions active at once, nested at most 2 levels below the team root, and starts with a budget of 8 sessions in total; the call is refused beyond that. Only the user can extend the budget (an action shown to them in the coordinator transcript); no tool does.",
        },
        mission: {
          type: "string",
          description:
            "Team mode only (ignored outside a Team mode team). The mission of this member: what this particular session must do, in one or two plain sentences (at most 400 characters; a longer one is refused), e.g. \"Review specifically the security of the supersedes flow.\" or \"Investigate only the persistence and replay paths and report any adjacent risk.\". Role = who the member is (its main responsibility); mission = the focus of this session; toolScope = what it may operationally do. The mission is stored with the member at creation, cannot be changed afterwards, and reaches the member through its system prompt next to its role. It grants nothing: it never changes the role, the scope, the model, the effort, the denied tools or any permission, and the member may still report relevant findings outside it. The prompt remains the full brief.",
        },
        effortLevel: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh", "max", "ultra"],
          description:
            "Optional reasoning effort for the child. Omit to leave it on the app-wide default — an omitted value is NOT inherited from the caller. Levels above the model's ceiling are clamped down (Claude models stop at max; only some Codex models reach ultra). Use a lower level for mechanical work and a higher one for hard reasoning.",
        },
      },
    },
  },
  {
    name: "spawn_session",
    description:
      "Spawn a new session from the calling session. By default the new session runs as a sibling under the same workstream as the caller (sharing files-edited, tabs, and get_workstream_overview); if the caller is not yet part of a workstream, a workstream container is created and the caller is reparented under it. The new session also inherits the caller's working directory: if the caller is running in a worktree, the spawned session runs in that same worktree (so its edits land where the user is looking). Pass isolated=true to instead create a top-level session with no parent and no workstream — use this when the new session should fix-and-commit work independently without polluting the caller's workstream. Pass useWorktree=true to give the spawned session its OWN new worktree instead of inheriting the caller's. Fire-and-forget by default — the calling session is not notified when the spawned session completes; pass notifyOnComplete=true to opt in. Use this for the /launch-new-session flow.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "REQUIRED. Self-contained handoff brief for the new session. Should describe the task, relevant file paths, decisions already made, and a pointer back to the current session id (the new session can call get_session_summary to read more).",
        },
        title: {
          type: "string",
          description: "Optional short title for the new session.",
        },
        isolated: {
          type: "boolean",
          description:
            "Default false. When true, the new session is created at the top level — no parent, no workstream container, no shared files-edited or tabs with the caller. Use for fix-and-commit-separately work that should not pollute the caller's workstream.",
        },
        useWorktree: {
          type: "boolean",
          description:
            "Default false. By default the spawned session inherits the caller's working directory: if the caller is in a worktree, the new session runs in that same worktree; if the caller is in the main checkout, the new session runs there too. Set true only when the user explicitly asks for the new session to get its OWN new worktree (separate branch and working directory) — this creates a fresh worktree rather than inheriting the caller's.",
        },
        model: {
          type: "string",
          description:
            "Optional explicit model identifier (e.g. 'claude-code:opus'). When omitted, the new session uses the global default model unless inheritModel=true. Wins over inheritModel when both are set.",
        },
        inheritModel: {
          type: "boolean",
          description:
            "Default false. When true and `model` is not set, the spawned session uses the caller's model so it stays on the same provider/model (e.g. opus stays on opus). Ignored when `model` is provided explicitly.",
        },
        notifyOnComplete: {
          type: "boolean",
          description:
            "Default false. When false (the default), the calling session receives no follow-up prompt when the spawned session completes/errors/waits — fire and forget. Set true only when the caller specifically wants to be told the result and continue working with it.",
        },
        role: {
          type: "string",
          enum: ["explorer", "implementer", "reviewer", "architect", "advisor", "other"],
          description:
            "Team mode only (ignored outside a Team mode team). Every role defaults to Sonnet except architect and advisor (Opus). explorer: research/reading, effort medium, read-only tools. implementer: makes changes, effort medium, full tools. reviewer: independent review, effort high, review scope (reads, and runs the project's tests only through run_project_tests; never edits, never runs a shell). architect: prepares a complex or critical task before anyone executes it, effort high, read scope always; it cannot ask the user, delegate or create tasks, and its final report is a Tool Manifest (M-<n>) that recommends and never grants anything. advisor: a second, independent opinion on the team's plan, implementation and conclusion as a whole, effort high, read scope always, cannot ask the user, delegate or create tasks; not a second reviewer; create it only when you explicitly decide a second opinion is worth it, never by default. other: effort medium. The role is the member's main responsibility; pass `mission` for the specific focus of this session. An explicit model, effortLevel or toolScope wins, except that a reviewer always gets the review scope (full or write is lowered to review) and an architect or advisor always gets read; promote (e.g. claude-code:opus + high) only when the task needs it. Omitted means other. A team may have at most 3 sessions active at once, nested at most 2 levels below the team root, and starts with a budget of 8 sessions in total; the call is refused beyond that. Only the user can extend the budget (an action shown to them in the coordinator transcript); no tool does.",
        },
        mission: {
          type: "string",
          description:
            "Team mode only (ignored outside a Team mode team). The mission of this member: what this particular session must do, in one or two plain sentences (at most 400 characters; a longer one is refused). Stored with the member at creation, immutable afterwards, read by the member in its system prompt next to its role. It grants nothing: it never changes the role, the scope, the model, the effort, the denied tools or any permission. See create_session.mission.",
        },
        effortLevel: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh", "max", "ultra"],
          description:
            "Optional reasoning effort for the new session (e.g. model 'openai-codex:gpt-6-astra' with effortLevel 'medium'). Omit to leave it on the app-wide default — unlike `model` there is no inherit-from-caller mode. Levels above the model's ceiling are clamped down (Claude models stop at max; only some Codex models reach ultra). Use a lower level for mechanical work and a higher one for hard reasoning.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "get_session_status",
    description:
      "Get the current status of a child session including last activity time and whether it is waiting for input.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "The session ID to inspect.",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "get_session_result",
    description:
      "Get the current or final result of a session including prompts, recent responses, edited files, and pending interactive prompts.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "The session ID to inspect.",
        },
        includeFullResponse: {
          type: "boolean",
          description:
            "Optional. Include the full last-agent-turn text (capped at 50,000 chars). Defaults to true. Set to false for a compact response when polling many sessions or when only status/prompts/editedFiles are needed.",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "consume_session_inbox",
    description: "Receive a bounded batch of reports for your CURRENT active turn and record receipt so they do not replay as another turn. Takes no session ID. When coordinating children, call before delegation/integration decisions, after long validation, and before final synthesis. Read the whole batch before acting. A boundary means yield at a safe point for normal queue delivery. Do not poll an empty inbox; end the turn when no independent work remains. Supports Claude Code and Codex MCP turns with verifiable tool-call identity.",
    inputSchema: { type: "object", properties: { checkpointId: { type: "string", description: "Unique name for this checkpoint (letters, digits, underscores or hyphens; max 100). Reuse only when retrying this same read; use a new name for a later checkpoint." } }, required: ["checkpointId"] },
  },
  {
    name: "list_queued_prompts",
    description:
      "Inspect queued prompts for a session. By default returns only pending/executing rows with bounded prompt previews; set includeCompleted to audit recently consumed rows.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "The target session ID.",
        },
        includeCompleted: {
          type: "boolean",
          description:
            "Optional. If true, include completed and failed queue rows. Defaults to false.",
        },
        includePromptText: {
          type: "boolean",
          description:
            "Optional. If true, include full prompt text. Defaults to false; promptPreview is always included.",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "send_prompt",
    description:
      "Queue a follow-up prompt for a session. If idle, processing starts immediately. Use messageKind=report for informational handoffs that may be consumed mid-turn; instructions/questions/errors retain normal turn delivery. Send material changes once; avoid acknowledgements and routine progress. Use the final response for automatic completion notifications instead of a duplicate send.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "The target child session ID.",
        },
        prompt: {
          type: "string",
          description: "The follow-up prompt to send.",
        },
        messageKind: {
          type: "string",
          enum: ["instruction", "report", "status", "question", "error"],
          description: "Defaults to instruction. report/status are informational context that the recipient can consume mid-turn; never label a request to change work as a report.",
        },
        interrupt: {
          type: "boolean",
          description:
            "Optional. If true, stop the session's current turn and start processing the queue immediately instead of waiting for the turn to finish. The interrupted turn's work is lost, so use this only when the new prompt makes the current one obsolete. Ignored for a session waiting on an interactive prompt (use respond_to_prompt) or a terminal-backed CLI session; the result reports interrupted/interruptSkippedReason. The queue drains oldest-first, so if the session already has queued prompts this delivers the oldest one, not necessarily yours.",
        },
      },
      required: ["sessionId", "prompt"],
    },
  },
  {
    name: "notify_user",
    description:
      "Show a local OS/system notification to get the human's attention. Use this for explicitly authorized asynchronous attention signals when chat may be missed. This is separate from voice mode; it respects the user's OS notification setting and returns JSON explaining whether the notification was shown or skipped.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Required short notification title.",
        },
        body: {
          type: "string",
          description: "Required notification body. Keep it concise and action-oriented.",
        },
        sessionId: {
          type: "string",
          description:
            "Optional session to open when the user clicks the notification. Defaults to the calling session.",
        },
        bypassFocusCheck: {
          type: "boolean",
          description:
            "Optional. If true, bypass in-app focus/session-visible suppression while still respecting the OS notification setting. Use only when the user asked agents to get their attention.",
        },
        silent: {
          type: "boolean",
          description: "Optional. If true, request a silent OS notification.",
        },
        urgency: {
          type: "string",
          enum: ["normal", "critical", "low"],
          description:
            "Optional urgency hint. Defaults to normal. 'critical' also sends a push notification to the user's phone, delivered even if they appear to be at their desk -- use it only when the human is genuinely blocking progress.",
        },
      },
      required: ["title", "body"],
    },
  },
  {
    name: "respond_to_prompt",
    description:
      "Answer a child session's interactive prompt such as AskUserQuestion, ExitPlanMode, or ToolPermission.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "The child session waiting for input.",
        },
        promptId: {
          type: "string",
          description: "The interactive prompt ID.",
        },
        promptType: {
          type: "string",
          enum: [
            "permission_request",
            "ask_user_question_request",
            "exit_plan_mode_request",
          ],
          description: "The kind of prompt being answered.",
        },
        response: {
          type: "object",
          description: "Prompt-specific response payload.",
        },
      },
      required: ["sessionId", "promptId", "promptType", "response"],
    },
  },
  {
    name: "list_spawned_sessions",
    description:
      "List all child sessions created by this meta-agent session, including current status and a short summary.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "run_project_tests",
    description:
      "Run the workspace's own test command (`npm test`, as the \"test\" script of a package.json of the workspace defines it) and return the exit code, duration and output. It runs at the workspace root, or in one existing project folder inside the workspace when the package.json is not at the root (projectPath). You cannot choose the command or its arguments. Returns status \"unavailable\" when that folder has no test script. Optionally narrow the run to one existing test file.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: {
          type: "string",
          description:
            "Optional. Folder of the project inside the workspace whose package.json holds the test script, e.g. \"web\". Omit it when the package.json is at the workspace root. Relative only: letters, digits, \".\", \"_\", \"-\" and \"/\"; no \"..\", no absolute path; must be an existing folder inside the workspace.",
        },
        testPath: {
          type: "string",
          description:
            "Optional. A test file (or folder) relative to the project folder (projectPath, or the workspace root when omitted), e.g. \"test/cart.test.js\". Letters, digits, \".\", \"_\", \"-\" and \"/\" only; no \"..\", no absolute path, must exist. Passed to the test script as `npm test -- <testPath>`.",
        },
        timeoutSeconds: {
          type: "number",
          description: "Optional. Default 120, maximum 300. The run and every process it started are stopped at the limit.",
        },
      },
    },
  },
  {
    name: "ecc_catalog_lookup",
    description:
      "Look up entries of the packaged ECC capability catalog (the version your index was built from) by id or by free-text query: kind, name, a short description, class (A, B, C citable; D, E not), requirements (shell, writes, network, MCP servers, sub-agents), the scopes the entry's content is executable in, and the classification confidence. Read-only passive data: it never runs, installs or authorizes anything, and a requirement it lists is not a permission. At most 8 results.",
    inputSchema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Catalog ids, with or without the ecc: prefix (e.g. \"skill:tdd-workflow\"). At most 8.",
        },
        query: {
          type: "string",
          description: "Free text matched against names, ids, descriptions and categories; best matches first.",
        },
        limit: {
          type: "number",
          description: "Optional. Default 5, maximum 8.",
        },
      },
    },
  },
];

/**
 * Return the meta-agent tools in OpenAI function-calling shape so an
 * extension-agent backend (which renders tools as JSON in its system prompt)
 * can present them. Built-in providers do NOT use this — they connect to the
 * SSE MCP server and discover the tools via ListTools. The two paths share
 * `META_AGENT_TOOL_DEFS` so descriptions stay in sync.
 */
// Tool-loop meta-agents (e.g. Gemini) receive their meta-agent
// tools through this OpenAI-shaped list. Built-in providers (claude-code,
// openai-codex) instead discover tools over the SSE MCP server and are gated by
// BaseAgentProvider.META_AGENT_ALLOWED_TOOLS, which deliberately OMITS
// spawn_session. spawn_session creates a workstream container (the
// launch-new-session flow) and reparents the child under it, which pulls the
// child out of the META AGENT group and breaks clean meta-agent nesting. To make
// extension-agent meta-agents behave identically to the built-ins, mirror that
// allowlist here so spawn_session is never offered (the meta-agent system prompt
// only references create_session). Keep in sync with the meta-agent subset of
// BaseAgentProvider.META_AGENT_ALLOWED_TOOLS.
const EXTENSION_META_AGENT_ALLOWED_TOOLS = new Set<string>([
  "list_worktrees",
  "create_session",
  "get_session_status",
  "get_session_result",
  "list_queued_prompts",
  "send_prompt",
  "notify_user",
  "respond_to_prompt",
  "list_spawned_sessions",
]);

export function getMetaAgentOpenAITools(): MetaAgentOpenAITool[] {
  return META_AGENT_TOOL_DEFS
    .filter((t) => EXTENSION_META_AGENT_ALLOWED_TOOLS.has(t.name))
    .map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as Record<string, unknown>,
      },
    }));
}

/**
 * Dispatch a parsed meta-agent tool call to the registered tool fns and return
 * its text result. Shared by the SSE MCP server's CallTool handler (built-in
 * providers) and the PrivilegedExtensionHost `toolExecutor` broker
 * (extension-agent providers) so the dispatch logic lives in exactly one place.
 *
 * `name` may carry the `mcp__nimbalyst-host__` prefix; it is stripped.
 * `workspaceId` is resolved to the caller's project via
 * resolveCallerWorkspaceId, so a worktree-rooted caller still lands on the
 * parent repo while keeping the spelling that repo was opened by (#1551).
 *
 * Throws if the tool fns are not yet registered or the tool name is unknown.
 */
export async function dispatchMetaAgentTool(
  name: string,
  aiSessionId: string,
  workspaceId: string,
  args: Record<string, unknown> | undefined
): Promise<string> {
  if (!toolFns) {
    throw new Error("Meta-agent service not initialized");
  }
  const toolName = name.replace(/^mcp__nimbalyst-[a-z-]+__/, "");
  // Resolve the caller to its project (worktree callers pass the worktree dir),
  // preserving the as-opened spelling where the filesystem can confirm it.
  // Sessions and windows are keyed by that spelling; the service still compares
  // identities rather than strings, so a caller whose alias cannot be
  // reconstructed here is matched against the stored path's identity instead.
  const effectiveWorkspaceId = resolveCallerWorkspaceId(workspaceId);

  switch (toolName) {
    case "list_worktrees":
      return toolFns.listWorktrees(aiSessionId, effectiveWorkspaceId);
    case "create_session":
      return toolFns.createSession(aiSessionId, effectiveWorkspaceId, (args ?? {}) as CreateSessionArgs);
    case "spawn_session":
      return toolFns.spawnSession(aiSessionId, effectiveWorkspaceId, (args ?? {}) as SpawnSessionArgs);
    case "get_session_status":
      return toolFns.getSessionStatus(
        aiSessionId,
        effectiveWorkspaceId,
        (args?.sessionId as string) ?? ""
      );
    case "get_session_result":
      return toolFns.getSessionResult(
        aiSessionId,
        effectiveWorkspaceId,
        (args?.sessionId as string) ?? "",
        { includeFullResponse: args?.includeFullResponse !== false }
      );
    case "list_queued_prompts":
      return toolFns.listQueuedPrompts(
        aiSessionId,
        effectiveWorkspaceId,
        (args?.sessionId as string) ?? "",
        {
          includeCompleted: args?.includeCompleted === true,
          includePromptText: args?.includePromptText === true,
        }
      );
    case "send_prompt":
      if (args?.messageKind !== undefined && !['instruction', 'report', 'status', 'question', 'error'].includes(String(args.messageKind))) throw new Error('Invalid orchestration messageKind');
      return toolFns.sendPrompt(
        aiSessionId,
        effectiveWorkspaceId,
        (args?.sessionId as string) ?? "",
        (args?.prompt as string) ?? "",
        args?.interrupt === true,
        (args?.messageKind as OrchestrationMessageKind | undefined) ?? 'instruction'
      );
    case "notify_user":
      return toolFns.notifyUser(aiSessionId, effectiveWorkspaceId, (args ?? {}) as NotifyUserArgs);
    case "respond_to_prompt":
      return toolFns.respondToPrompt(aiSessionId, effectiveWorkspaceId, (args ?? {}) as RespondToPromptArgs);
    case "list_spawned_sessions":
      return toolFns.listSpawnedSessions(aiSessionId, effectiveWorkspaceId);
    case "run_project_tests":
      // Runs in the caller's own directory (a worktree caller passes its
      // worktree), never a path the agent supplies.
      return JSON.stringify(
        await runProjectTests(aiSessionId, workspaceId, {
          projectPath: args?.projectPath,
          testPath: args?.testPath,
          timeoutSeconds: args?.timeoutSeconds,
        }, { pathEnv: getEnhancedPath }),
        null,
        2,
      );
    case "ecc_catalog_lookup": {
      // Passive catalog data, no session or workspace involved: the caller's
      // scope policy (toolPolicy.ts) decides who may call it. A missing or
      // corrupted catalog, or a call with nothing to look up, is a tool error.
      const lookup = await eccCatalogLookupTool({ ids: args?.ids, query: args?.query, limit: args?.limit });
      if ('error' in lookup) throw new Error(lookup.error);
      return JSON.stringify(lookup, null, 2);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
