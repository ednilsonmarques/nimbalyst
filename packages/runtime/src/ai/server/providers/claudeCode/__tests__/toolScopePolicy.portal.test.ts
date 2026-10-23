/**
 * Portal F1.2 -- which scope and which team role may use the `portal_*` tools
 * (served by the core endpoint) and the extension `browser.*` tools.
 *
 *   read / architect / explorer / advisor : no portal tool
 *   review (reviewer)                     : observe + exercise, never evaluate
 *   write (implementer)                   : the same set, never evaluate
 *   full                                  : everything, evaluate included
 *   any team member                       : no browser.* (the whole `nimbalyst-browser` server)
 *   solo session (no scope, no role)      : keeps browser.* and portal_*
 *
 * Both halves of the policy are checked: the SDK `disallowedTools` list and the
 * call-time guard `isToolDeniedForScope` (which the MCP server also applies at
 * ListTools and CallTool).
 */
import { describe, expect, it } from 'vitest';
import {
  isToolDeniedForScope,
  mergeToolScopeDisallowedTools,
  type ChildToolScope,
} from '../toolPolicy';
import { CORE_TOOLS } from '../../../services/mcpTopology';
import type { TeamRole } from '../../teamContext';

const OBSERVE = ['portal_open', 'portal_navigate', 'portal_list', 'portal_screenshot', 'portal_page_info', 'portal_close'];
const EXERCISE = ['portal_click', 'portal_type', 'portal_scroll'];
const EVALUATE = 'portal_evaluate';
const ALL = [...OBSERVE, ...EXERCISE, EVALUATE];
const core = (tool: string) => `mcp__nimbalyst__${tool}`;
const BROWSER_TOOL = 'mcp__nimbalyst-browser__browser_click';

const denied = (scope: ChildToolScope, tool: string, role: TeamRole | null = null) =>
  isToolDeniedForScope(scope, tool, ['nimbalyst', 'nimbalyst-browser'], role);

describe('the portal tools exist on the core endpoint', () => {
  it('lists every portal tool in the core topology', () => {
    for (const tool of ALL) expect(CORE_TOOLS).toContain(tool);
  });
});

describe('scope matrix (call-time guard)', () => {
  it.each(ALL)('read scope denies %s', (tool) => {
    expect(denied('read', core(tool))).toBe(true);
  });

  it.each([...OBSERVE, ...EXERCISE])('review scope allows %s', (tool) => {
    expect(denied('review', core(tool))).toBe(false);
  });
  it('review scope never allows portal_evaluate', () => {
    expect(denied('review', core(EVALUATE))).toBe(true);
  });

  it.each([...OBSERVE, ...EXERCISE])('write scope allows %s', (tool) => {
    expect(denied('write', core(tool))).toBe(false);
  });
  it('write scope never allows portal_evaluate', () => {
    expect(denied('write', core(EVALUATE))).toBe(true);
  });

  it.each(ALL)('full scope allows %s', (tool) => {
    expect(denied('full', core(tool))).toBe(false);
  });
});

describe('scope matrix (SDK disallowedTools half)', () => {
  const list = (scope: ChildToolScope, role: TeamRole | null = null) =>
    mergeToolScopeDisallowedTools(undefined, scope, ['nimbalyst', 'nimbalyst-browser'], role) ?? [];

  it('read withholds all portal tools', () => {
    for (const tool of ALL) expect(list('read')).toContain(core(tool));
  });
  it('review withholds only portal_evaluate', () => {
    const l = list('review');
    expect(l).toContain(core(EVALUATE));
    for (const tool of [...OBSERVE, ...EXERCISE]) expect(l).not.toContain(core(tool));
  });
  it('write withholds only portal_evaluate', () => {
    const l = list('write');
    expect(l).toContain(core(EVALUATE));
    for (const tool of [...OBSERVE, ...EXERCISE]) expect(l).not.toContain(core(tool));
  });
  it('full withholds none', () => {
    const l = list('full');
    for (const tool of ALL) expect(l).not.toContain(core(tool));
  });
});

describe('team roles', () => {
  it.each(['explorer', 'architect', 'advisor'] as const)('%s gets no portal tool, whatever its scope says', (role) => {
    for (const scope of ['read', 'review', 'write', 'full'] as const) {
      for (const tool of ALL) expect(denied(scope, core(tool), role)).toBe(true);
    }
  });

  it('a reviewer never evaluates, even with a wider scope than it should have', () => {
    expect(denied('full', core(EVALUATE), 'reviewer')).toBe(true);
    expect(denied('review', core(EVALUATE), 'reviewer')).toBe(true);
    for (const tool of [...OBSERVE, ...EXERCISE]) expect(denied('review', core(tool), 'reviewer')).toBe(false);
  });

  it('an implementer (write) gets observe + exercise only', () => {
    for (const tool of [...OBSERVE, ...EXERCISE]) expect(denied('write', core(tool), 'implementer')).toBe(false);
    expect(denied('write', core(EVALUATE), 'implementer')).toBe(true);
  });

  it.each(['explorer', 'implementer', 'reviewer', 'architect', 'advisor', 'other'] as const)(
    '%s loses browser.* (the whole browser server), at any scope',
    (role) => {
      for (const scope of ['read', 'review', 'write', 'full'] as const) {
        expect(denied(scope, BROWSER_TOOL, role)).toBe(true);
      }
      expect(mergeToolScopeDisallowedTools(undefined, 'full', ['nimbalyst-browser'], role)).toContain('mcp__nimbalyst-browser');
    },
  );

  it('a solo session (no scope, no role) keeps browser.* and every portal tool', () => {
    expect(denied('full', BROWSER_TOOL)).toBe(false);
    for (const tool of ALL) expect(denied('full', core(tool))).toBe(false);
    expect(mergeToolScopeDisallowedTools(undefined, 'full', ['nimbalyst-browser'], null)).toBeUndefined();
  });
});
