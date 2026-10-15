/**
 * Per-session tool policy of the unified MCP server: the host's own half of a
 * child session's tool scope and team role, applied to every client the same
 * way, whatever provider is on the other end of the transport.
 *
 * A read/review child (a Team mode explorer, architect, advisor or reviewer,
 * or any scoped child) is created with `metadata.toolScope` and, in a team,
 * `metadata.teamChild.role`. Claude Code withholds the denied tools in its
 * own turn (SDK `disallowedTools` + PreToolUse guard, see
 * providers/claudeCode/toolPolicy.ts). Other providers (Codex app-server) do
 * not have that turn, and until this module the server listed and ran every
 * tool for them. Now the server itself reads the same policy
 * (`isToolDeniedForScope`, the single source of truth) and:
 *
 *  - ListTools omits a denied tool, so a restricted session never sees it;
 *  - CallTool refuses a denied tool, so a call that arrives anyway (a model
 *    that remembers a name, an injected request) runs nothing.
 *
 * Both together are the double barrier; for Claude Code they are the third
 * and fourth. The policy is read once per session and frozen: scope and role
 * are creation-only in the session store, and the provider cannot change once
 * a session has a message (SessionHandlers refuses the switch), which a child
 * has from its first turn. Fail-closed: when the session row
 * cannot be read, nothing is served and nothing runs; a session without an id
 * (no row to read: the host builds every transport URL with the id) and a
 * session without a scope are unrestricted, as before.
 */

import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { resolveTeamContext, type TeamRole } from '@nimbalyst/runtime/ai/server/providers/teamContext';
import {
  isToolDeniedForScope,
  resolveChildToolScope,
  teamRoleDeniedTools,
  teamRoleDenialReason,
  type ChildToolScope,
} from '@nimbalyst/runtime/ai/server/providers/claudeCode/toolPolicy';
import type { McpEndpointSelection } from './mcpEndpointRouting';

export interface SessionToolPolicy {
  scope: ChildToolScope;
  role: TeamRole | null;
  /** The session's provider (`ai_sessions.provider`); null when unknown. */
  provider: string | null;
  /**
   * The folder the session is authorized to read through the host's file
   * reads: its worktree, else its workspace, from the session row (NIB.46
   * item 7.1). Never the transport's query parameter. Null when unknown,
   * which refuses the reads.
   */
  workspaceRoot: string | null;
}

/** No scope, no team role: every tool of the endpoint, as before this module. */
export const UNRESTRICTED_TOOL_POLICY: Readonly<SessionToolPolicy> = Object.freeze({ scope: 'full', role: null, provider: null, workspaceRoot: null });

type SessionRowLike = {
  metadata?: unknown;
  agentRole?: string | null;
  provider?: string | null;
  workspacePath?: string | null;
  worktreePath?: string | null;
} | null | undefined;

/** The folder a session row authorizes: its worktree, else its workspace; null when it has neither. */
export function sessionAuthorizedRoot(row: SessionRowLike): string | null {
  const worktree = typeof row?.worktreePath === 'string' && row.worktreePath ? row.worktreePath : null;
  const workspace = typeof row?.workspacePath === 'string' && row.workspacePath ? row.workspacePath : null;
  return worktree ?? workspace;
}
type SessionRowReader = (sessionId: string) => Promise<SessionRowLike>;

const defaultReader: SessionRowReader = (sessionId) => AISessionsRepository.get(sessionId) as Promise<SessionRowLike>;
let readSessionRow: SessionRowReader = defaultReader;
const frozenPolicies = new Map<string, Promise<SessionToolPolicy>>();

/** Tests: replace the session store read. Null restores the repository. */
export function setSessionToolPolicyReader(reader: SessionRowReader | null): void {
  readSessionRow = reader ?? defaultReader;
  frozenPolicies.clear();
}

/** Tests: forget every frozen policy. */
export function resetSessionToolPolicies(): void {
  frozenPolicies.clear();
}

/** Forget one session's frozen policy (when its transports are gone). */
export function forgetSessionToolPolicy(sessionId: string): void {
  frozenPolicies.delete(sessionId);
}

export const SESSION_TOOL_POLICY_UNAVAILABLE =
  'Could not verify this session\'s tool restrictions (session metadata unavailable), so no tool was served. Try again.';

/**
 * The frozen policy of a session. A missing row is unrestricted (a child
 * that does not exist cannot be restricted; its creation writes the scope
 * with the row). A read that fails, after one retry, rejects and is not
 * frozen, so the request fails closed and the next one reads again.
 */
export function resolveSessionToolPolicy(sessionId: string | undefined): Promise<SessionToolPolicy> {
  if (!sessionId) return Promise.resolve(UNRESTRICTED_TOOL_POLICY);
  let policy = frozenPolicies.get(sessionId);
  if (!policy) {
    const read = () => readSessionRow(sessionId);
    policy = read()
      .catch(read)
      .then((session): SessionToolPolicy => {
        if (!session) {
          // No row yet (a connection that raced its own creation): unrestricted
          // for this request only, never frozen, so the row is read next time.
          frozenPolicies.delete(sessionId);
          return UNRESTRICTED_TOOL_POLICY;
        }
        const metadata = session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
          ? (session.metadata as Record<string, unknown>)
          : undefined;
        const team = resolveTeamContext(metadata, session.agentRole);
        return {
          scope: resolveChildToolScope(metadata?.toolScope),
          role: team.teamChild?.role ?? null,
          provider: typeof session.provider === 'string' && session.provider ? session.provider : null,
          workspaceRoot: sessionAuthorizedRoot(session),
        };
      })
      .catch((error: unknown): never => {
        frozenPolicies.delete(sessionId);
        console.error(`[MCP Server] Could not load the tool policy of session ${sessionId}; serving no tool:`, error);
        throw new Error(SESSION_TOOL_POLICY_UNAVAILABLE);
      });
    frozenPolicies.set(sessionId, policy);
  }
  return policy;
}

export function isRestrictedToolPolicy(policy: SessionToolPolicy): boolean {
  return policy.scope !== 'full' || policy.role !== null;
}

/**
 * Whether the core endpoint serves this session the host's own file reads
 * (read_file, list_files, search_files): a read/review member whose provider
 * keeps no native read tool under the scope. Claude Code keeps Read, Glob and
 * Grep, so it never needs them; an openai-codex member's shell is refused, so
 * these are its only reads. A full session never gets them (it has its
 * provider's own tools), nor does a session without a known provider.
 */
export function servesHostReadTools(policy: SessionToolPolicy): boolean {
  if (policy.scope !== 'read' && policy.scope !== 'review') return false;
  return !!policy.provider && policy.provider !== 'claude-code';
}

/**
 * The name the scope policy knows a tool by: `mcp__<configKey>__<tool>`, the
 * SDK's own namespacing, so the server applies exactly the list Claude Code's
 * turn applies. A per-extension endpoint is named after its server key, which
 * the read/review scopes deny whole; the legacy endpoint serves no tool.
 */
export function policyToolName(endpoint: McpEndpointSelection, toolName: string): string {
  return `mcp__${endpointConfigKey(endpoint)}__${toolName}`;
}

function endpointConfigKey(endpoint: McpEndpointSelection): string {
  if (endpoint.kind === 'firstParty') return endpoint.configKey;
  if (endpoint.kind === 'extension') return `nimbalyst-${endpoint.extensionShortName}`;
  return 'nimbalyst-fallback';
}

/** Whether `toolName` (bare, as the endpoint lists it) must not be served to a session under `policy`. */
export function isToolDeniedForSession(policy: SessionToolPolicy, endpoint: McpEndpointSelection, toolName: string): boolean {
  if (!isRestrictedToolPolicy(policy)) return false;
  const configKey = endpointConfigKey(endpoint);
  // The endpoint's own server key is passed so an extension server is denied
  // whole under read/review, exactly as mergeToolScopeDisallowedTools does.
  return isToolDeniedForScope(policy.scope, policyToolName(endpoint, toolName), [configKey], policy.role);
}

/** The endpoint's tool list as a session under `policy` may see it. */
export function filterToolsForSession<T extends { name: string }>(
  tools: readonly T[],
  policy: SessionToolPolicy,
  endpoint: McpEndpointSelection,
): T[] {
  if (!isRestrictedToolPolicy(policy)) return [...tools];
  return tools.filter((tool) => !isToolDeniedForSession(policy, endpoint, tool.name));
}

/** The CallTool result for a denied tool: an error the model reads, never an execution. */
export function sessionToolDenial(
  policy: SessionToolPolicy,
  endpoint: McpEndpointSelection,
  toolName: string,
): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const name = policyToolName(endpoint, toolName);
  const text = policy.role && teamRoleDeniedTools(policy.role).includes(name)
    ? teamRoleDenialReason(policy.role, toolName)
    : `Tool "${toolName}" is not available to this session: its tool scope is ${policy.scope}, which does not include it. Nothing was executed.`;
  return { content: [{ type: 'text', text: `Error: ${text}` }], isError: true };
}
