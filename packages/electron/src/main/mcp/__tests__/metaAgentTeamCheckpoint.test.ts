// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { META_AGENT_TOOL_DEFS, dispatchMetaAgentTool, setMetaAgentToolFns } from '../metaAgentServer';

/**
 * Continuing a team past its checkpoint is the user's decision. It is reached
 * only from the renderer (`team:continue`); these pin that the session-facing
 * tool surface offers no way to do it.
 */
describe('Team checkpoint is not reachable from the session tools', () => {
  it('no host tool continues a team, extends a budget or answers the checkpoint', () => {
    expect(META_AGENT_TOOL_DEFS.map((tool) => tool.name)).toEqual([
      'list_worktrees',
      'create_session',
      'spawn_session',
      'get_session_status',
      'get_session_result',
      'consume_session_inbox',
      'list_queued_prompts',
      'send_prompt',
      'notify_user',
      'respond_to_prompt',
      'list_spawned_sessions',
      'run_project_tests',
    ]);
    for (const tool of META_AGENT_TOOL_DEFS) {
      expect(tool.name, tool.name).not.toMatch(/continue|budget|checkpoint|authoriz/i);
      // No argument sets a budget either. (Descriptions may mention the budget;
      // consume_session_inbox has an unrelated `checkpointId`, a read cursor.)
      for (const argument of Object.keys(tool.inputSchema.properties)) {
        expect(argument, `${tool.name}.${argument}`).not.toMatch(/budget|authoriz|metadata/i);
      }
    }
  });

  it('respond_to_prompt answers interactive prompts only; the checkpoint is not one of them', () => {
    const respond = META_AGENT_TOOL_DEFS.find((tool) => tool.name === 'respond_to_prompt')!;
    const promptTypes = (respond.inputSchema.properties.promptType as { enum: string[] }).enum;
    expect(promptTypes).toEqual(['permission_request', 'ask_user_question_request', 'exit_plan_mode_request']);
  });

  it('the dispatcher refuses any attempt to call a continuation tool', async () => {
    setMetaAgentToolFns({} as never);
    for (const name of ['team_continue', 'continue_team', 'mcp__nimbalyst-host__team_continue', 'team:continue']) {
      await expect(dispatchMetaAgentTool(name, 'root', process.cwd(), { sessionId: 'root' })).rejects.toThrow(/Unknown tool/);
    }
  });
});
