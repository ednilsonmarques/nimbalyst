import { usesHostSuppliedToolLoop } from './providerResolution';

/**
 * Whether the child's provider actually withholds the tools its `toolScope`
 * denies. claude-code applies it through SDK `disallowedTools` (turnPrologue);
 * tool-loop providers through the dev toolset they are handed
 * (MessageStreamingHandler). Any other provider ignores the scope, so the parent
 * must not be told the child "could not" run something.
 */
export function isToolScopeEnforced(provider: string | null | undefined): boolean {
  if (!provider) return false;
  return provider === 'claude-code' || usesHostSuppliedToolLoop(provider);
}

/**
 * The tool-scope line of a [Child Session Update]. Null for full/absent scopes.
 */
export function describeChildToolScope(
  toolScope: string | null | undefined,
  enforced: boolean,
): string | null {
  if (toolScope !== 'read' && toolScope !== 'review' && toolScope !== 'write') return null;
  if (!enforced) {
    return `Tool scope: ${toolScope} was requested, but this child's provider does not enforce it. Verify any claim that it ran, built, tested, or edited something against "Files modified" and its result.`;
  }
  if (toolScope === 'review') {
    return `Tool scope: review (this child had NO file-writing, shell (run_command/Bash), delegation, skill, hook, web (WebFetch/WebSearch), external MCP (user servers, plugins, claude.ai connectors) or app-changing tools; its only execution was the workspace's own tests through run_project_tests). Any other claim it ran, built or fetched something is false; "Files modified" above is the complete list of files it changed.`;
  }
  if (toolScope === 'read') {
    return `Tool scope: read (this child had NO file-writing, shell (run_command/Bash), delegation, skill, hook, web (WebFetch/WebSearch), external MCP (user servers, plugins, claude.ai connectors) or app-changing tools). Any claim it ran, built, tested or fetched anything is false; "Files modified" above is the complete list of files it changed.`;
  }
  return `Tool scope: write (this child had NO shell (run_command/Bash) or delegation tools). Any claim it ran, built, or tested anything is false unless it went through a user-configured MCP server, which this scope does not cover; "Files modified" above is the complete list of files it changed.`;
}
