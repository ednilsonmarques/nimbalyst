import { usesHostSuppliedToolLoop } from './providerResolution';
import type { ChildToolScope } from '@nimbalyst/runtime/ai/server/providers/claudeCode/toolPolicy';
import { CODEX_ENFORCED_TOOL_SCOPES } from '@nimbalyst/runtime/ai/server/providers/codex/codexTeamPolicy';

/**
 * Whether the child's provider actually withholds the tools its `toolScope`
 * denies, for every scope or for one in particular:
 *
 * - claude-code applies every scope through SDK `disallowedTools` and a
 *   PreToolUse guard (turnPrologue);
 * - tool-loop providers through the dev toolset they are handed
 *   (MessageStreamingHandler);
 * - openai-codex (app-server) applies `read` and `review`: the session-scoped
 *   MCP server withholds the denied Nimbalyst tools and the thread runs in a
 *   read-only sandbox with every approval refused (codexTeamPolicy.ts); it
 *   cannot apply `write` (its edits go through the same shell and patch tools
 *   a read-only thread withholds).
 *
 * Any other provider ignores the scope, so the parent must not be told the
 * child "could not" run something. Without a scope the question is whether
 * the provider enforces every scope.
 */
export function isToolScopeEnforced(provider: string | null | undefined, scope?: ChildToolScope): boolean {
  if (!provider) return false;
  if (provider === 'claude-code' || usesHostSuppliedToolLoop(provider)) return true;
  if (provider === 'openai-codex') {
    return scope !== undefined && scope !== 'full' && CODEX_ENFORCED_TOOL_SCOPES.includes(scope);
  }
  return false;
}

/**
 * The tool-scope line of a [Child Session Update]. Null for full/absent scopes.
 * On openai-codex a read/review child has its shell switched off and reads
 * through the host's read tools; the line says so: the coordinator is
 * never told something false about what the member could do.
 */
export function describeChildToolScope(
  toolScope: string | null | undefined,
  enforced: boolean,
  provider?: string | null,
): string | null {
  if (toolScope !== 'read' && toolScope !== 'review' && toolScope !== 'write') return null;
  if (!enforced) {
    return `Tool scope: ${toolScope} was requested, but this child's provider does not enforce it. Verify any claim that it ran, built, tested, or edited something against "Files modified" and its result.`;
  }
  const shell = provider === 'openai-codex'
    ? 'shell (its Codex shell tool was switched off and verified off by the host; every patch and approval was refused; it read files only through the host\'s workspace-confined read_file, list_files and search_files tools)'
    : 'shell (run_command/Bash)';
  if (toolScope === 'review') {
    return `Tool scope: review (this child had NO file-writing, ${shell}, delegation, skill, hook, web (WebFetch/WebSearch), external MCP (user servers, plugins, claude.ai connectors) or app-changing tools; its only execution was the workspace's own tests through run_project_tests). Any other claim it ran, built or fetched something is false; "Files modified" above is the complete list of files it changed.`;
  }
  if (toolScope === 'read') {
    const claim = provider === 'openai-codex' ? 'Any claim it edited, built, tested or fetched anything is false' : 'Any claim it ran, built, tested or fetched anything is false';
    return `Tool scope: read (this child had NO file-writing, ${shell}, delegation, skill, hook, web (WebFetch/WebSearch), external MCP (user servers, plugins, claude.ai connectors) or app-changing tools). ${claim}; "Files modified" above is the complete list of files it changed.`;
  }
  return `Tool scope: write (this child had NO shell (run_command/Bash), test-runner (run_project_tests) or delegation tools). Any claim it ran, built, or tested anything is false unless it went through a user-configured MCP server, which this scope does not cover; "Files modified" above is the complete list of files it changed.`;
}
