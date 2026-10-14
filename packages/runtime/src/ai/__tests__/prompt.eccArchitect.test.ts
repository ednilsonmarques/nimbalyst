/**
 * "Prepare with ECC Architect" starts a Team mode root whose creation-only
 * directive tells the coordinator to begin with the architect. The directive
 * travels like any session directive: in the system prompt, after the Team Mode
 * rules. It changes nothing for a root without it, and nothing for a normal
 * session.
 */
import { describe, expect, it } from 'vitest';
import { buildClaudeCodeSystemPrompt } from '../prompt';
import { ECC_ARCHITECT_FIRST_DIRECTIVE } from '../server/providers/teamContext';

const base = { hasSessionNaming: true, worktreePath: '/repo/worktrees/x' };

describe('the "Prepare with ECC Architect" directive', () => {
  it('reaches a Team mode coordinator through its system prompt, after the Team Mode rules', () => {
    const prompt = buildClaudeCodeSystemPrompt({ ...base, teamMode: true, sessionDirective: ECC_ARCHITECT_FIRST_DIRECTIVE });
    expect(prompt).toContain('## Team Mode');
    expect(prompt).toContain(ECC_ARCHITECT_FIRST_DIRECTIVE);
    expect(prompt.indexOf('## Team Mode')).toBeLessThan(prompt.indexOf(ECC_ARCHITECT_FIRST_DIRECTIVE));
  });

  it('asks for the architect first and leaves the coordinator the only authority', () => {
    expect(ECC_ARCHITECT_FIRST_DIRECTIVE).toMatch(/create the architect \(role `architect`/);
    expect(ECC_ARCHITECT_FIRST_DIRECTIVE).toMatch(/as the first member/);
    expect(ECC_ARCHITECT_FIRST_DIRECTIVE).toMatch(/wait for its Tool Manifest/);
    expect(ECC_ARCHITECT_FIRST_DIRECTIVE).toMatch(/before creating anyone else/);
    expect(ECC_ARCHITECT_FIRST_DIRECTIVE).toMatch(/You remain the coordinator and the only authority/);
    expect(ECC_ARCHITECT_FIRST_DIRECTIVE).toMatch(/a recommendation, never a decision or a permission/);
    // It grants nothing: no tool, server, scope, model or effort is named.
    expect(ECC_ARCHITECT_FIRST_DIRECTIVE).not.toMatch(/toolScope|mcp__|allowedTools|effortLevel|claude-code:/);
  });

  it('a Team mode root without it gets the Team mode prompt exactly as before', () => {
    const plain = buildClaudeCodeSystemPrompt({ ...base, teamMode: true });
    expect(plain).not.toContain('Prepare with ECC Architect');
    expect(buildClaudeCodeSystemPrompt({ ...base, teamMode: true, sessionDirective: undefined })).toBe(plain);
  });

  it('a normal session never sees it', () => {
    const normal = buildClaudeCodeSystemPrompt(base);
    expect(normal).not.toContain('Prepare with ECC Architect');
    expect(normal).not.toContain('## Team Mode');
  });
});
