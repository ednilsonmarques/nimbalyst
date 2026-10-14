// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { TEAM_MISSION_MAX_LENGTH } from '@nimbalyst/runtime/ai/server/providers/teamContext';
import { META_AGENT_TOOL_DEFS } from '../metaAgentServer';

/** Session mission: declared on create_session and spawn_session as plain text that grants nothing. */
describe('create_session / spawn_session declare `mission`', () => {
  it.each(['create_session', 'spawn_session'])('%s: an optional string, team mode only, stated as no permission', (name) => {
    const def = META_AGENT_TOOL_DEFS.find((tool) => tool.name === name)!;
    const properties = def.inputSchema.properties as Record<string, { type: string; description: string }>;
    expect(properties.mission).toMatchObject({ type: 'string' });
    expect(def.inputSchema.required ?? []).not.toContain('mission');
    expect(properties.mission.description).toContain(`at most ${TEAM_MISSION_MAX_LENGTH} characters`);
    expect(properties.mission.description).toMatch(/Team mode only/);
    expect(properties.mission.description).toMatch(/It grants nothing: it never changes the role, the scope, the model, the effort, the denied tools or any permission/);
    expect(properties.role.description).toContain('pass `mission` for the specific focus of this session');
  });
});
