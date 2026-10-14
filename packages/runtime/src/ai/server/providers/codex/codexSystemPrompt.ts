import { buildClaudeCodeSystemPrompt, buildMetaAgentSystemPrompt, type MetaAgentWorkflowPreset } from '../../../prompt';
import type { DocumentContext } from '../../types';
import type { TeamRole } from '../teamContext';
import type { CodexRestrictedToolScope } from '../../protocols/codexPermissionProfile';
import { buildCodexReadAccessNote } from './codexTeamPolicy';
import {
  areTrackerToolsEnabled,
  isInternalMcpServerEnabled,
  resolveTrackersWorkspacePath,
} from '../../services/mcpServerConfig';

export interface CodexSystemPromptOptions {
  documentContext?: DocumentContext;
  isMetaAgent: boolean;
  workflowPreset: MetaAgentWorkflowPreset;
  model?: string;
  /** `metadata.sessionDirective`, frozen per session by `BaseAgentProvider.getSessionDirective`. */
  sessionDirective?: string;
  /** The session was titled by its caller, so the agent must not name it (frozen at the first turn). */
  hasOutOfBandNaming: boolean;
  /**
   * Team mode member (`metadata.teamChild.role`): the member contract of the
   * role (buildTeamChildAddendum: the architect's and the advisor's own
   * texts, every other role's responsibility) and its mission, the same
   * provider-neutral text a Claude Code member gets. Frozen per session.
   */
  teamChildRole?: TeamRole;
  teamChildMission?: string;
  /**
   * The session's restricted scope (read/review): appends the provider
   * adapter's note on how reading works on Codex (codexTeamPolicy.ts), since
   * the provider-neutral contract says "no shell" and here reading is the
   * shell's known-safe commands. Frozen per session like the scope itself.
   */
  restrictedToolScope?: CodexRestrictedToolScope | null;
}

/**
 * System prompt for an OpenAI Codex turn, using the same addendum as Claude
 * Code (visual tools, worktrees, session naming, etc.). Re-sent at the head of
 * every turn as developer instructions, so every input must be stable for the
 * session.
 *
 * A team member's contract reaches Codex through the same builder and the
 * same text as Claude Code (no Codex-specific advisor prompt exists). It is
 * behaviour, not security: what the member may do is enforced by the host
 * (the session-scoped MCP server) and by the thread's sandbox and approval
 * policy (codexTeamPolicy.ts), whatever the prompt says.
 */
export function buildCodexSystemPrompt(options: CodexSystemPromptOptions): string {
  const { documentContext, sessionDirective } = options;
  if (options.isMetaAgent) {
    return buildMetaAgentSystemPrompt('codex', options.workflowPreset, {
      provider: 'openai-codex',
      model: options.model,
      sessionDirective,
    });
  }

  const prompt = buildClaudeCodeSystemPrompt({
    hasSessionNaming: isInternalMcpServerEnabled(),
    hasOutOfBandNaming: options.hasOutOfBandNaming,
    toolReferenceStyle: 'codex',
    worktreePath: documentContext?.worktreePath,
    sessionDirective,
    isVoiceMode: (documentContext as any)?.isVoiceMode,
    voiceModeCodingAgentPrompt: (documentContext as any)?.voiceModeCodingAgentPrompt,
    // Agent teams are not currently supported for Codex.
    enableAgentTeams: false,
    trackersEnabled: areTrackerToolsEnabled(resolveTrackersWorkspacePath(documentContext)),
    // A Codex session is never a Team mode root (the coordinator presets are
    // Claude Code); as a member it gets its role's contract and mission.
    teamMode: false,
    teamChildRole: options.teamChildRole,
    teamChildMission: options.teamChildMission,
  });
  return options.restrictedToolScope ? `${prompt}\n${buildCodexReadAccessNote(options.restrictedToolScope)}\n` : prompt;
}
