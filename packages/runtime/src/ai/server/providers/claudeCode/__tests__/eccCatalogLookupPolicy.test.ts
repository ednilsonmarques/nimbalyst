// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { HOST_TOOLS, MCP_HOST } from '../../../services/mcpTopology';
import {
  INTERNAL_MCP_TOOLS,
  RUN_PROJECT_TESTS_TOOL,
  isToolDeniedForScope,
  readScopeDeniedFirstPartyTools,
  toolScopeDeniedTools,
} from '../toolPolicy';

const LOOKUP = `mcp__${MCP_HOST}__ecc_catalog_lookup`;

/**
 * Phase 1B: the catalog lookup is a passive read, so every scope may call it
 * (the architect above all) and it is auto-allowed like the other internal
 * reads. It is listed explicitly: no wildcard, and nothing else in the policy
 * moves with it.
 */
describe('ecc_catalog_lookup in the tool policy', () => {
  it('is a declared host tool, allowed in every scope and for the architect, auto-allowed as an internal read', () => {
    expect(HOST_TOOLS).toContain('ecc_catalog_lookup');
    for (const scope of ['read', 'review', 'write', 'full'] as const) {
      expect(isToolDeniedForScope(scope, LOOKUP), scope).toBe(false);
      expect(toolScopeDeniedTools(scope), scope).not.toContain(LOOKUP);
    }
    expect(isToolDeniedForScope('read', LOOKUP, [], 'architect')).toBe(false);
    expect(isToolDeniedForScope('read', LOOKUP, [], 'explorer')).toBe(false);
    expect(isToolDeniedForScope('review', LOOKUP, [], 'reviewer')).toBe(false);
    expect(readScopeDeniedFirstPartyTools()).not.toContain(LOOKUP);
    expect(INTERNAL_MCP_TOOLS).toContain(LOOKUP);
  });

  it('widens nothing: shells, the web, external MCP servers and the test runner stay as they were', () => {
    expect(isToolDeniedForScope('read', 'Bash')).toBe(true);
    expect(isToolDeniedForScope('read', 'Bash', [], 'architect')).toBe(true);
    expect(isToolDeniedForScope('read', 'WebFetch')).toBe(true);
    expect(isToolDeniedForScope('read', 'Skill')).toBe(true);
    expect(isToolDeniedForScope('read', 'Agent')).toBe(true);
    expect(isToolDeniedForScope('read', 'mcp__exa__search', ['exa'])).toBe(true);
    expect(isToolDeniedForScope('review', 'mcp__exa__search', ['exa'])).toBe(true);
    expect(isToolDeniedForScope('read', RUN_PROJECT_TESTS_TOOL)).toBe(true);
    expect(isToolDeniedForScope('write', RUN_PROJECT_TESTS_TOOL)).toBe(true);
    expect(isToolDeniedForScope('review', RUN_PROJECT_TESTS_TOOL)).toBe(false);
    // Every other host tool a read child could not call before still cannot.
    for (const tool of ['create_session', 'spawn_session', 'send_prompt', 'respond_to_prompt', 'notify_user', 'workspace_set_trust', 'features_toggle']) {
      expect(isToolDeniedForScope('read', `mcp__${MCP_HOST}__${tool}`), tool).toBe(true);
    }
    // The architect's own denials are untouched.
    expect(isToolDeniedForScope('read', 'mcp__nimbalyst__AskUserQuestion', [], 'architect')).toBe(true);
    expect(isToolDeniedForScope('read', 'TaskCreate', [], 'architect')).toBe(true);
  });

  it('is named explicitly, never through a wildcard', () => {
    const wildcard = HOST_TOOLS.filter((tool) => tool.includes('*'));
    expect(wildcard).toEqual([]);
    expect(INTERNAL_MCP_TOOLS.filter((tool) => tool.includes('*'))).toEqual([]);
  });
});
