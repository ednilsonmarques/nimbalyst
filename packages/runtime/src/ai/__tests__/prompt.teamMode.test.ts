import { describe, expect, it } from 'vitest';
import { buildClaudeCodeSystemPrompt, buildTeamChildAddendum, buildTeamModeAddendum } from '../prompt';

const base = { hasSessionNaming: true, worktreePath: '/repo/worktrees/x', sessionDirective: 'Stay focused.' };

describe('Team mode system prompt', () => {
  it('is byte-identical to the normal prompt when Team mode is off', () => {
    const normal = buildClaudeCodeSystemPrompt(base);
    expect(buildClaudeCodeSystemPrompt({ ...base, teamMode: false, teamChildRole: undefined })).toBe(normal);
    expect(normal).not.toContain('## Team Mode');
    expect(normal).not.toContain('## Team Member');
  });

  it('adds the coordinator policy for a team root, before the session directive', () => {
    const prompt = buildClaudeCodeSystemPrompt({ ...base, teamMode: true });
    expect(prompt).toContain('## Team Mode');
    expect(prompt).not.toContain('## Team Member');
    expect(prompt.indexOf('## Team Mode')).toBeLessThan(prompt.indexOf('Stay focused.'));
    expect(prompt.trimEnd().endsWith('</addendum>')).toBe(true);
  });

  it('adds the member contract for a team child', () => {
    const prompt = buildClaudeCodeSystemPrompt({ ...base, teamChildRole: 'reviewer' });
    expect(prompt).toContain('## Team Member');
    expect(prompt).toContain('You are the reviewer of a coordinated team');
    expect(prompt).not.toContain('## Team Mode');
  });

  it('a root wins over a stray child role', () => {
    const prompt = buildClaudeCodeSystemPrompt({ ...base, teamMode: true, teamChildRole: 'explorer' });
    expect(prompt).toContain('## Team Mode');
    expect(prompt).not.toContain('## Team Member');
  });

  it('coordinator policy states the two delegation levels, roles, limits and ownership', () => {
    const text = buildTeamModeAddendum('claude');
    expect(text).toContain('mcp__nimbalyst-host__create_session');
    expect(text).toContain('mcp__nimbalyst-host__spawn_session');
    expect(text).toContain('SDK sub-agent');
    for (const role of ['explorer', 'implementer', 'reviewer', 'other']) expect(text).toContain(`\`${role}\``);
    expect(text).toContain('at most 3 real sessions active at once, 8 real sessions in total');
    expect(text).toContain('2 levels deep');
    expect(text).toContain('do not read or redo it yourself');
  });

  it('teaches the coordinator Team Notes when trackers are enabled', () => {
    const prompt = buildClaudeCodeSystemPrompt({ ...base, teamMode: true });
    expect(prompt).toContain('### Team Notes');
    expect(prompt).toContain('mcp__nimbalyst-trackers__tracker_list');
    expect(prompt).toContain('look for a similar note');
    expect(prompt).toContain('cite only the keys of the relevant notes');
    expect(prompt).toContain('Never paste a report');
  });

  it('has no Team Notes at all when trackers are disabled in the workspace', () => {
    const root = buildClaudeCodeSystemPrompt({ ...base, teamMode: true, trackersEnabled: false });
    expect(root).toContain('## Team Mode');
    expect(root).not.toContain('Team Notes');
    const child = buildClaudeCodeSystemPrompt({ ...base, teamChildRole: 'explorer', trackersEnabled: false });
    expect(child).not.toContain('Suggested notes');
  });

  it('members only suggest notes', () => {
    const child = buildTeamChildAddendum('reviewer');
    expect(child).toContain('Suggested notes:');
    expect(child).toContain('you never write notes yourself');
    expect(child).toContain('read only those with tracker_get');
  });

  it('states the member defaults and explicit, sparing promotion', () => {
    const text = buildTeamModeAddendum('claude');
    expect(text).toContain('Every member runs on Sonnet by default');
    expect(text).toContain('`reviewer`: independent review of someone else\'s work (Sonnet, effort high');
    expect(text).toContain('`implementer`: makes the changes (Sonnet, effort medium');
    expect(text).toContain('pass `model` and `effortLevel` explicitly');
    expect(text).toContain('Promote only when the task clearly needs it');
    expect(text).not.toContain('defaults to your model');
  });

  it('is static: the same text every call (prompt-cache stable)', () => {
    expect(buildTeamModeAddendum('claude')).toBe(buildTeamModeAddendum('claude'));
    expect(buildTeamChildAddendum('implementer')).toBe(buildTeamChildAddendum('implementer'));
  });

  it('member contract asks for a short report without repeating the task', () => {
    const text = buildTeamChildAddendum('explorer');
    expect(text).toContain('about 15 lines');
    expect(text).toContain('Do not repeat the task');
    expect(text).toContain('Do not create other sessions');
  });
});
