// @vitest-environment node
/**
 * Phase 1A.1: inside a team, the coordinator's own policy tools and the team's
 * reads are pre-authorized under conditions checked on the call itself;
 * everything sensitive, everything outside a team, every target outside the
 * team and everything a scope withholds keeps the normal permission prompt.
 */
import { describe, expect, it } from 'vitest';

import {
  TEAM_PREAUTHORIZED_READ_TOOLS,
  TEAM_PREAUTHORIZED_TEST_TOOLS,
  TEAM_ROLE_DEFAULT_SCOPES,
  TEAM_ROOT_PREAUTHORIZED_TOOLS,
  TEAM_TARGETED_TOOLS,
  createSessionWithinDefaults,
  teamPreauthorizationReason,
  type TeamPermissionContext,
} from '../teamPermissionPolicy';
import { TOOL_MANIFEST_ROLE_SCOPES } from '../../toolManifest';

const ROOT: TeamPermissionContext = { teamMode: true, role: null, scope: 'full', sessionId: 'root', rootSessionId: 'root' };
const member = (role: TeamPermissionContext['role'], scope: TeamPermissionContext['scope']): TeamPermissionContext =>
  ({ teamMode: false, role, scope, sessionId: `m-${role}`, rootSessionId: 'root' });
const IMPLEMENTER = member('implementer', 'full');
const WRITER = member('implementer', 'write');
const REVIEWER = member('reviewer', 'review');
const ARCHITECT = member('architect', 'read');
const EXPLORER = member('explorer', 'read');
const NOBODY: TeamPermissionContext = { teamMode: false, role: null, scope: 'full', sessionId: 'plain', rootSessionId: null };

const CREATE = 'mcp__nimbalyst-host__create_session';
const SPAWN = 'mcp__nimbalyst-host__spawn_session';
const SEND = 'mcp__nimbalyst-host__send_prompt';
const RESULT = 'mcp__nimbalyst-host__get_session_result';
const STATUS = 'mcp__nimbalyst-host__get_session_status';
const SPAWNED = 'mcp__nimbalyst-host__list_spawned_sessions';
const QUEUED = 'mcp__nimbalyst-host__list_queued_prompts';
const TESTS = 'mcp__nimbalyst-host__run_project_tests';
const IN_TEAM = { targetInTeam: true };
const DEFAULT_CREATE = { input: { role: 'architect', title: 'x', prompt: 'y' } };

const SENSITIVE = [
  'Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit', 'WebFetch', 'WebSearch', 'Skill', 'Agent',
  SPAWN,
  'mcp__nimbalyst__developer_git_commit_proposal',
  'mcp__nimbalyst-host__respond_to_prompt',
  'mcp__nimbalyst-host__features_toggle',
  'mcp__nimbalyst-host__workspace_set_trust',
  'mcp__nimbalyst-host__ai_set_default_model',
  'mcp__nimbalyst-host__update_session_board',
  'mcp__nimbalyst-trackers__tracker_create',
  'mcp__github__create_issue',
  'mcp__context7__query',
];

describe('teamPreauthorizationReason', () => {
  it('pre-authorizes the coordinator for a default create_session, a follow-up to its own member and the reads of its own team', () => {
    expect(teamPreauthorizationReason(CREATE, ROOT, DEFAULT_CREATE)).toEqual(expect.any(String));
    expect(teamPreauthorizationReason(SEND, ROOT, { input: { sessionId: 'm-1', prompt: 'go' }, targetInTeam: true })).toEqual(expect.any(String));
    for (const tool of [RESULT, STATUS, QUEUED]) expect(teamPreauthorizationReason(tool, ROOT, IN_TEAM), tool).toEqual(expect.any(String));
    expect(teamPreauthorizationReason(SPAWNED, ROOT)).toEqual(expect.any(String));
  });

  it('create_session needs the role defaults: a promotion, a wider scope, a worktree or another provider is the user\'s click', () => {
    expect(createSessionWithinDefaults({ role: 'reviewer' })).toBe(true);
    expect(createSessionWithinDefaults({ role: 'implementer', toolScope: 'write', title: 'Implementer', prompt: 'Papel: implementer' })).toBe(true);
    expect(createSessionWithinDefaults({ role: 'explorer', toolScope: 'read' })).toBe(true);
    // Only role, title, prompt and toolScope may appear: any other key, internal or not, is the user's click.
    for (const input of [
      { role: 'architect', model: 'claude-code:opus' },
      { role: 'reviewer', effortLevel: 'high' },
      { role: 'explorer', toolScope: 'full' },
      { role: 'reviewer', toolScope: 'write' },
      { role: 'implementer', useWorktree: true },
      { role: 'implementer', useWorktree: false },
      { role: 'implementer', useWorktree: 'true' },
      { role: 'implementer', worktreeId: 'wt-1' },
      { role: 'other', provider: 'openai-codex' },
      { role: 'explorer', provider: 'claude-code' },
      { role: 'implementer', skipTeamRoleModelDefaults: true },
      { role: 'other', notifyParent: false },
      { role: 'implementer', parentSessionIdOverride: 'x' },
      { role: 'reviewer', title: 42 },
      { role: 'boss' },
      {},
      null,
      'architect',
    ]) {
      expect(createSessionWithinDefaults(input), JSON.stringify(input)).toBe(false);
      expect(teamPreauthorizationReason(CREATE, ROOT, { input }), JSON.stringify(input)).toBeNull();
    }
    expect(TEAM_ROLE_DEFAULT_SCOPES).toEqual(TOOL_MANIFEST_ROLE_SCOPES);
  });

  it('a targeted tool is pre-authorized only for a confirmed target of the same team', () => {
    for (const tool of TEAM_TARGETED_TOOLS) {
      expect(teamPreauthorizationReason(tool, ROOT, { targetInTeam: false }), tool).toBeNull();
      expect(teamPreauthorizationReason(tool, ROOT, { targetInTeam: null }), tool).toBeNull();
      expect(teamPreauthorizationReason(tool, ROOT), tool).toBeNull();
    }
    expect(teamPreauthorizationReason(SEND, ROOT, { targetInTeam: true })).toEqual(expect.any(String));
  });

  it('a member gets the reads of its own team and nothing that acts on sessions; only the review scope gets run_project_tests', () => {
    for (const m of [IMPLEMENTER, WRITER, REVIEWER, ARCHITECT, EXPLORER]) {
      for (const tool of [RESULT, STATUS, QUEUED]) expect(teamPreauthorizationReason(tool, m, IN_TEAM), `${m.role} ${tool}`).toEqual(expect.any(String));
      expect(teamPreauthorizationReason(SPAWNED, m), `${m.role} ${SPAWNED}`).toEqual(expect.any(String));
      expect(teamPreauthorizationReason(CREATE, m, DEFAULT_CREATE), `${m.role} ${CREATE}`).toBeNull();
      expect(teamPreauthorizationReason(SEND, m, IN_TEAM), `${m.role} ${SEND}`).toBeNull();
    }
    expect(teamPreauthorizationReason(TESTS, REVIEWER)).toEqual(expect.any(String));
    // Anyone who can edit package.json would turn the runner into an unprompted command: full, write and the root keep the click.
    expect(teamPreauthorizationReason(TESTS, IMPLEMENTER)).toBeNull();
    expect(teamPreauthorizationReason(TESTS, WRITER)).toBeNull();
    expect(teamPreauthorizationReason(TESTS, ROOT)).toBeNull();
    // read scope withholds it anyway.
    expect(teamPreauthorizationReason(TESTS, ARCHITECT)).toBeNull();
    expect(teamPreauthorizationReason(TESTS, EXPLORER)).toBeNull();
  });

  it('never pre-authorizes anything sensitive, for anyone, whatever the request says', () => {
    for (const context of [ROOT, IMPLEMENTER, WRITER, REVIEWER, ARCHITECT, EXPLORER]) {
      for (const tool of SENSITIVE) {
        expect(teamPreauthorizationReason(tool, context, { ...IN_TEAM, ...DEFAULT_CREATE }), `${context.role ?? 'root'} ${tool}`).toBeNull();
      }
    }
  });

  it('pre-authorizes nothing outside a team, nothing for an SDK teammate, and nothing when the context is unknown (fail-closed)', () => {
    for (const tool of [CREATE, SEND, RESULT, STATUS, SPAWNED, QUEUED, TESTS, ...SENSITIVE]) {
      const request = { ...IN_TEAM, ...DEFAULT_CREATE };
      expect(teamPreauthorizationReason(tool, NOBODY, request), tool).toBeNull();
      expect(teamPreauthorizationReason(tool, null, request), tool).toBeNull();
      expect(teamPreauthorizationReason(tool, undefined, request), tool).toBeNull();
      expect(teamPreauthorizationReason(tool, ROOT, { ...request, teammateName: 'researcher' }), tool).toBeNull();
      expect(teamPreauthorizationReason(tool, REVIEWER, { ...request, teammateName: 'researcher' }), tool).toBeNull();
    }
  });

  it('only ever names first-party host tools, and never a wildcard or a server', () => {
    for (const tool of [...TEAM_ROOT_PREAUTHORIZED_TOOLS, ...TEAM_PREAUTHORIZED_READ_TOOLS, ...TEAM_PREAUTHORIZED_TEST_TOOLS, ...TEAM_TARGETED_TOOLS]) {
      expect(tool.startsWith('mcp__nimbalyst-host__'), tool).toBe(true);
    }
    expect(teamPreauthorizationReason('mcp__nimbalyst-host__*', ROOT, { ...IN_TEAM, ...DEFAULT_CREATE })).toBeNull();
    expect(teamPreauthorizationReason('mcp__nimbalyst-host', ROOT, { ...IN_TEAM, ...DEFAULT_CREATE })).toBeNull();
  });
});
