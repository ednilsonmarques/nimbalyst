// @vitest-environment node
/**
 * NIB.31: `run_project_tests` runs in the folder the SESSION ROW authorizes
 * (its worktree, else its workspace), never in the transport's workspace
 * parameter and never in a path the agent names. The dispatcher asks the
 * host for that root; the runner itself keeps validating projectPath and
 * testPath inside it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/team/projectTestRunner', () => ({
  runProjectTests: vi.fn(async (_sessionKey: string, workspaceRoot: string, args: Record<string, unknown>) => ({ status: 'passed', command: 'npm test', root: workspaceRoot, args })),
}));

import { dispatchMetaAgentTool, setMetaAgentToolFns } from '../metaAgentServer';
import { runProjectTests } from '../../services/team/projectTestRunner';

const ROOTS: Record<string, string | null> = {
  // A: the root session in the main repo, its reviewer attached to the team worktree.
  'reviewer-wt-a': 'C:\\repo\\.worktrees\\team-a',
  // B: a second worktree of the same repo, its own reviewer.
  'reviewer-wt-b': 'C:\\repo\\.worktrees\\team-b',
  // A member in the shared workspace.
  'reviewer-shared': 'C:\\repo',
  // D: a session whose worktree no longer exists on disk, or an unknown session.
  'reviewer-gone': null,
};

beforeEach(() => {
  vi.mocked(runProjectTests).mockClear();
  setMetaAgentToolFns({
    resolveSessionWorkspaceRoot: async (sessionId: string) => ROOTS[sessionId] ?? null,
  } as any);
});

afterEach(() => {
  setMetaAgentToolFns(null as any);
});

describe('run_project_tests root (NIB.31)', () => {
  it('A: a reviewer attached to the team worktree tests that worktree, whatever workspace the transport names', async () => {
    const result = JSON.parse(await dispatchMetaAgentTool('run_project_tests', 'reviewer-wt-a', 'C:\\repo', { projectPath: 'web' }));
    expect(result.status).toBe('passed');
    expect(vi.mocked(runProjectTests)).toHaveBeenCalledWith('reviewer-wt-a', 'C:\\repo\\.worktrees\\team-a', expect.objectContaining({ projectPath: 'web' }), expect.anything());
  });

  it('B: two worktrees of one repo never cross: reviewer A runs in A, reviewer B in B, even with the same transport workspace', async () => {
    await dispatchMetaAgentTool('run_project_tests', 'reviewer-wt-a', 'C:\\repo', {});
    await dispatchMetaAgentTool('run_project_tests', 'reviewer-wt-b', 'C:\\repo', {});
    const roots = vi.mocked(runProjectTests).mock.calls.map((call) => call[1]);
    expect(roots).toEqual(['C:\\repo\\.worktrees\\team-a', 'C:\\repo\\.worktrees\\team-b']);
  });

  it('C: a brief or mission naming another path changes nothing: only projectPath/testPath reach the runner, which keeps them inside the root', async () => {
    await dispatchMetaAgentTool('run_project_tests', 'reviewer-shared', 'C:\\somewhere\\else', {
      projectPath: '../other-repo',
      testPath: 'C:\\repo\\.worktrees\\team-b\\test',
      workspacePath: 'C:\\repo\\.worktrees\\team-b',
      cwd: 'C:\\repo\\.worktrees\\team-b',
      command: 'rm -rf',
    });
    const [sessionKey, root, args] = vi.mocked(runProjectTests).mock.calls[0]!;
    expect(sessionKey).toBe('reviewer-shared');
    expect(root).toBe('C:\\repo');
    expect(args).toEqual({ projectPath: '../other-repo', testPath: 'C:\\repo\\.worktrees\\team-b\\test', timeoutSeconds: undefined });
    expect(args).not.toHaveProperty('workspacePath');
    expect(args).not.toHaveProperty('cwd');
    expect(args).not.toHaveProperty('command');
  });

  it('D: a session whose authorized folder is gone, or an unknown session, gets an explicit refusal and no run', async () => {
    for (const sessionId of ['reviewer-gone', 'unknown-session']) {
      const result = JSON.parse(await dispatchMetaAgentTool('run_project_tests', sessionId, 'C:\\repo', {}));
      expect(result).toEqual({ status: 'unavailable', reason: 'The calling session has no authorized workspace on record, so no test command can run.' });
    }
    expect(runProjectTests).not.toHaveBeenCalled();
  });
});
