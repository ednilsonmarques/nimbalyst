// @vitest-environment node
/**
 * Tool Manifest v1 and the advisor: `independentReview` is an optional
 * recommendation (a manifest without it stays valid, an unknown level is an
 * error, a missing reason is a warning), an advisor planned above read is an
 * error, and nothing in the validator or the host creates a session from it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INDEPENDENT_REVIEW_LEVELS,
  TOOL_MANIFEST_ROLE_SCOPES,
  parseToolManifest,
  readIndependentReview,
} from '../toolManifest';

const BASE_YAML = `toolManifest: 1
id: M-1
task: Make the metadata key workflowPreset creation-only
objective: update_session_meta no longer accepts workflowPreset after the session is created
oracle:
  sourceOfTruth: teamSessionMetadata.ts and sessionNamingServer.test.ts
  evidenceRequired: [a new test failing before and passing after]
teamPlan:
  recommended: TEAM
  members:
    - { role: implementer, scope: full, why: makes the change }
    - { role: reviewer, scope: review, why: touches persisted metadata }
toolsAllowed: { reviewer: [Read, Grep, run_project_tests], advisor: [Read, Grep, tracker_get, ecc_catalog_lookup] }
testsRequired:
  - { name: metadata creation-only, how: npx vitest run packages/electron/src/main/services/team, gate: blocking }
risks:
  - { id: R1, severity: medium, text: the meta-agent writes workflowPreset legitimately, mitigation: keep the meta-agent exception }
doneCriteria: [tests green]
confidence: high
generatedBy: { role: architect, model: claude-code:opus, ecc: 2.2.3 }`;

const message = (yaml: string) => `Here is the manifest.\n\n\`\`\`yaml\n${yaml}\n\`\`\`\n\nPreparation: complete\n`;
const withReview = (block: string) => `${BASE_YAML}\n${block}`;

describe('independentReview is optional and a recommendation', () => {
  it('a manifest without the field (every manifest written before the advisor existed) is valid', () => {
    const result = parseToolManifest(message(BASE_YAML));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(readIndependentReview(result.manifest)).toBeNull();
  });

  it.each(INDEPENDENT_REVIEW_LEVELS)('level %s with a reason is valid and readable', (level) => {
    const result = parseToolManifest(message(withReview(`independentReview:\n  level: ${level}\n  reason: the persistence contract rests on an undocumented premise`)));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((warning) => warning.includes('independentReview'))).toBe(false);
    expect(readIndependentReview(result.manifest)).toEqual({ level, reason: 'the persistence contract rests on an undocumented premise' });
  });

  it('a recommended or required level without a reason is a warning, never an error; none needs no reason', () => {
    const recommended = parseToolManifest(message(withReview('independentReview:\n  level: recommended')));
    expect(recommended.ok).toBe(true);
    expect(recommended.warnings).toContain('independentReview.reason is empty: say what a second opinion should question');
    expect(readIndependentReview(recommended.manifest)).toEqual({ level: 'recommended', reason: null });
    const none = parseToolManifest(message(withReview('independentReview: { level: none }')));
    expect(none.ok).toBe(true);
    expect(none.warnings.some((warning) => warning.includes('independentReview'))).toBe(false);
  });

  it('an unknown level or a non-mapping value is an error (the coordinator must read a known level)', () => {
    expect(parseToolManifest(message(withReview('independentReview: { level: mandatory, reason: x }'))).errors)
      .toContain('independentReview.level must be one of none, optional, recommended, required');
    expect(parseToolManifest(message(withReview('independentReview: recommended'))).errors)
      .toContain('independentReview must be a mapping with level (none, optional, recommended, required) and reason');
    expect(parseToolManifest(message(withReview('independentReview: [recommended]'))).ok).toBe(false);
    expect(readIndependentReview({ independentReview: 'recommended' })).toBeNull();
    expect(readIndependentReview({ independentReview: { level: 'mandatory' } })).toBeNull();
    expect(readIndependentReview(null)).toBeNull();
  });

  it('required is not a block: the manifest is as valid and as complete as any other', () => {
    const result = parseToolManifest(message(withReview('independentReview:\n  level: required\n  reason: irreversible change')));
    expect(result.ok).toBe(true);
    expect(result.preparation).toBe('complete');
  });

  it('nothing in the manifest module creates a session or names a provider for the advisor', () => {
    const source = readFileSync(path.join(__dirname, '..', 'toolManifest.ts'), 'utf8');
    expect(source).not.toMatch(/create_session|spawn_session|createChildSession/);
    expect(source).not.toMatch(/codex/i);
    expect(source).not.toMatch(/role === 'advisor'[^\n]*provider/);
  });
});

describe('advisor in a team plan', () => {
  it('the advisor is judged by the read scope, like the explorer and the architect', () => {
    expect(TOOL_MANIFEST_ROLE_SCOPES.advisor).toBe('read');
  });

  it('a planned advisor at read, with or without a mission, is fine; above read is an error', () => {
    const ok = parseToolManifest(message(BASE_YAML.replace('    - { role: reviewer, scope: review, why: touches persisted metadata }',
      '    - { role: reviewer, scope: review, why: touches persisted metadata }\n    - { role: advisor, scope: read, mission: Question the persistence strategy., why: irreversible contract }')));
    expect(ok.ok).toBe(true);
    for (const scope of ['review', 'write', 'full']) {
      const result = parseToolManifest(message(BASE_YAML.replace('    - { role: reviewer, scope: review, why: touches persisted metadata }',
        `    - { role: reviewer, scope: review, why: touches persisted metadata }\n    - { role: advisor, scope: ${scope}, why: x }`)));
      expect(result.errors, scope).toContain('teamPlan.members: an advisor never runs above the read scope');
    }
  });

  it('toolsAllowed.advisor may list reads, the manifest, the notes and the catalog, never an edit, a shell, a test run or a session', () => {
    expect(parseToolManifest(message(BASE_YAML)).exceedsScope).toEqual([]);
    for (const tool of ['Edit', 'Bash', 'run_project_tests', 'create_session', 'send_prompt', 'tracker_update', 'AskUserQuestion', 'Agent']) {
      const result = parseToolManifest(message(BASE_YAML.replace('advisor: [Read, Grep, tracker_get, ecc_catalog_lookup]', `advisor: [Read, ${tool}]`)));
      expect(result.ok, tool).toBe(false);
      expect(result.exceedsScope.map((excess) => excess.tool), tool).toContain(tool);
    }
  });
});
