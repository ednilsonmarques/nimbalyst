// @vitest-environment node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TOOL_MANIFEST_MAX_CHARS,
  TOOL_MANIFEST_ROLE_SCOPES,
  extractToolManifestYaml,
  looksLikeToolManifest,
  normalizeManifestToolName,
  parseToolManifest,
  resolveManifestToolNames,
  assessArchitectReport,
  describeInvalidManifest,
  describeTooLongManifest,
  neutralizePreparationLine,
  renderArchitectReportForUpdate,
} from '../toolManifest';
import { ECC_CATALOG_INDEX_CLASSES } from '../../../ecc/eccCatalogIndex.generated';

const SAMPLE_YAML = `toolManifest: 1
id: M-1
task: Make the metadata key workflowPreset creation-only
objective: update_session_meta no longer accepts workflowPreset after the session is created
oracle:
  sourceOfTruth: teamSessionMetadata.ts (CREATION_ONLY_KEYS) and sessionNamingServer.test.ts
  evidenceRequired: [a new test failing before and passing after, vitest of the two files]
teamPlan:
  recommended: SOLO
  members:
    - { role: reviewer, scope: review, why: touches persisted metadata }
eccCapabilities:
  - { id: ecc:skill:tdd-workflow, for: implementer, class: A, purpose: test before the change }
toolsAllowed: { reviewer: [Read, Grep, run_project_tests] }
toolsForbidden: [developer_git_commit_proposal]
mcpRecommended: []
mcpForbidden: [claude.ai Supabase]
testsRequired:
  - { name: metadata creation-only, how: npx vitest run packages/electron/src/main/services/team, gate: blocking }
validationStrategy: unit tests on the store and on the MCP server; no e2e
risks:
  - { id: R1, severity: medium, text: the meta-agent writes workflowPreset legitimately, mitigation: keep the meta-agent exception }
openQuestions:
  - { q: will the future UI change the preset?, assumption: not in this phase }
doneCriteria: [tests green, no regression in sessionNamingServer.test.ts]
limitations: [does not cover remote metadata sync]
evidence: [teamSessionMetadata.ts, sessionNamingServer.ts, PGLiteSessionStore.ts]
confidence: high
generatedBy: { role: architect, model: claude-code:opus, ecc: 2.2.3 }`;

const message = (yaml: string, tail = '\n\n## Analysis\n\nShort.\n\nPreparation: complete\n') => `Here is the manifest.\n\n\`\`\`yaml\n${yaml}\n\`\`\`${tail}`;

const withField = (field: string, value: string) => SAMPLE_YAML.replace(new RegExp(`^${field}:.*$`, 'm'), `${field}: ${value}`);
const withoutLine = (prefix: string) => SAMPLE_YAML.split('\n').filter((line) => !line.startsWith(prefix)).join('\n');

describe('Tool Manifest v1: extraction', () => {
  it('finds the yaml block that carries toolManifest: 1 and ignores other blocks', () => {
    const text = `\`\`\`yaml\nfoo: 1\n\`\`\`\n\n${message(SAMPLE_YAML)}`;
    expect(extractToolManifestYaml(text)).toBe(SAMPLE_YAML);
    expect(looksLikeToolManifest(text)).toBe(true);
    expect(looksLikeToolManifest('a report with toolManifest: 1 in prose but no fence')).toBe(false);
    expect(extractToolManifestYaml('nothing')).toBeNull();
  });

  it('accepts yml fences and CRLF line endings', () => {
    const crlf = `\`\`\`yml\r\n${SAMPLE_YAML.replace(/\n/g, '\r\n')}\r\n\`\`\`\r\nPreparation: complete\r\n`;
    expect(parseToolManifest(crlf).ok).toBe(true);
  });
});

describe('Tool Manifest v1: validation', () => {
  it('accepts the sample and reads the preparation line', () => {
    const result = parseToolManifest(message(SAMPLE_YAML));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.preparation).toBe('complete');
    expect(result.exceedsScope).toEqual([]);
    expect(result.manifest?.id).toBe('M-1');
    expect(result.warnings).toEqual([]);
  });

  it('refuses a final message above 7,500 characters: the coordinator would get it truncated', () => {
    const padding = '\n\n## Analysis\n\n' + 'x'.repeat(TOOL_MANIFEST_MAX_CHARS) + '\n\nPreparation: complete\n';
    const result = parseToolManifest(message(SAMPLE_YAML, padding));
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/at most 7500/);
    expect(result.chars).toBeGreaterThan(TOOL_MANIFEST_MAX_CHARS);
    // Just under the ceiling is fine.
    const underPadding = '\n\n## Analysis\n\n' + 'x'.repeat(TOOL_MANIFEST_MAX_CHARS - message(SAMPLE_YAML).length - 60) + '\n\nPreparation: complete\n';
    expect(parseToolManifest(message(SAMPLE_YAML, underPadding)).ok).toBe(true);
  });

  it('requires the version, an M-<n> id, task, objective, an oracle and a team plan', () => {
    expect(parseToolManifest(message(SAMPLE_YAML.replace('toolManifest: 1', 'toolManifest: 2'))).ok).toBe(false);
    expect(parseToolManifest(message(withField('id', 'manifest-1'))).errors.join(' ')).toMatch(/M-<n>/);
    expect(parseToolManifest(message(withoutLine('task:'))).errors.join(' ')).toMatch(/task is required/);
    expect(parseToolManifest(message(withoutLine('objective:'))).errors.join(' ')).toMatch(/objective is required/);
    expect(parseToolManifest(message(SAMPLE_YAML.replace(/^  sourceOfTruth:.*$/m, '  sourceOfTruth: ""'))).errors.join(' ')).toMatch(/oracle\.sourceOfTruth is required/);
    expect(parseToolManifest(message(SAMPLE_YAML.replace('recommended: SOLO', 'recommended: MAYBE'))).errors.join(' ')).toMatch(/TEAM or SOLO/);
    expect(parseToolManifest('no manifest here').errors.join(' ')).toMatch(/no ```yaml block/);
    expect(parseToolManifest(message('toolManifest: 1\nid: [unclosed')).errors.join(' ')).toMatch(/not valid YAML/);
  });

  it('keeps every list short: at most 8 items, 6 open questions', () => {
    const nineRisks = 'risks:\n' + Array.from({ length: 9 }, (_, i) => `  - { id: R${i + 1}, severity: low, text: t, mitigation: accept }`).join('\n');
    const result = parseToolManifest(message(SAMPLE_YAML.replace(/^risks:\n  - \{.*\}$/m, nineRisks)));
    expect(result.errors.join(' ')).toMatch(/risks has 9 items; at most 8/);
    const sevenQuestions = 'openQuestions:\n' + Array.from({ length: 7 }, (_, i) => `  - { q: q${i}?, assumption: a }`).join('\n');
    expect(parseToolManifest(message(SAMPLE_YAML.replace(/^openQuestions:\n  - \{.*\}$/m, sevenQuestions))).errors.join(' ')).toMatch(/openQuestions has 7 items; at most 6/);
  });

  it('cites only catalog entries the architect index lists: a hook, an orchestration engine or an unknown id is refused', () => {
    expect(ECC_CATALOG_INDEX_CLASSES['ecc:skill:tdd-workflow']).toBe('A');
    for (const id of ['ecc:skill:plan-canvas', 'ecc:command:feature-dev', 'ecc:hook:pre:bash:dispatcher', 'ecc:skill:does-not-exist']) {
      const result = parseToolManifest(message(SAMPLE_YAML.replace('id: ecc:skill:tdd-workflow', `id: ${id}`)));
      expect(result.ok, id).toBe(false);
      expect(result.errors.join(' '), id).toContain(`${id} is not a citable catalog entry`);
    }
    // A wrong class is advice, not an error.
    const result = parseToolManifest(message(SAMPLE_YAML.replace('class: A', 'class: C')));
    expect(result.ok).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/is class A in the index, not C/);
  });

  it('never grants: a tool recommended outside the role scope is an error and is listed in exceedsScope', () => {
    const reviewerBash = parseToolManifest(message(SAMPLE_YAML.replace('toolsAllowed: { reviewer: [Read, Grep, run_project_tests] }', 'toolsAllowed: { reviewer: [Read, Bash, run_project_tests] }')));
    expect(reviewerBash.ok).toBe(false);
    expect(reviewerBash.exceedsScope).toEqual([{ role: 'reviewer', tool: 'Bash', scope: 'review' }]);
    expect(reviewerBash.errors.join(' ')).toMatch(/toolsAllowed\.reviewer lists Bash, outside the review scope/);

    const explorerTests = parseToolManifest(message(SAMPLE_YAML.replace('toolsAllowed: { reviewer: [Read, Grep, run_project_tests] }', 'toolsAllowed: { explorer: [run_project_tests], architect: [AskUserQuestion] }')));
    expect(explorerTests.exceedsScope).toEqual([
      { role: 'explorer', tool: 'run_project_tests', scope: 'read' },
      { role: 'architect', tool: 'AskUserQuestion', scope: 'read' },
    ]);

    const implementerBash = parseToolManifest(message(SAMPLE_YAML.replace('toolsAllowed: { reviewer: [Read, Grep, run_project_tests] }', 'toolsAllowed: { implementer: [Read, Edit, Bash, run_project_tests, developer_git_commit_proposal] }')));
    expect(implementerBash.exceedsScope).toEqual([]);
    expect(implementerBash.ok).toBe(true);

    expect(parseToolManifest(message(SAMPLE_YAML.replace('toolsAllowed: { reviewer: [Read, Grep, run_project_tests] }', 'toolsAllowed: { boss: [Read] }'))).errors.join(' ')).toMatch(/boss is not a team role/);
  });

  it('resolves bare first-party tool names to their mcp__ names, natives to themselves, and a name that is both to both', () => {
    expect(normalizeManifestToolName('run_project_tests')).toBe('mcp__nimbalyst-host__run_project_tests');
    expect(resolveManifestToolNames('run_project_tests')).toEqual(['mcp__nimbalyst-host__run_project_tests']);
    expect(normalizeManifestToolName('tracker_get')).toBe('mcp__nimbalyst-trackers__tracker_get');
    expect(resolveManifestToolNames('Read')).toEqual(['Read']);
    expect(resolveManifestToolNames('mcp__github__create_issue')).toEqual(['mcp__github__create_issue']);
    expect(resolveManifestToolNames('AskUserQuestion')).toEqual(['mcp__nimbalyst__AskUserQuestion', 'AskUserQuestion']);
    expect(resolveManifestToolNames('nobody_knows_this')).toEqual(['nobody_knows_this']);
  });

  it('judges a bare name under every policy name it resolves to', () => {
    // The architect loses both the native and the first-party AskUserQuestion.
    const asks = parseToolManifest(message(SAMPLE_YAML.replace('toolsAllowed: { reviewer: [Read, Grep, run_project_tests] }', 'toolsAllowed: { architect: [AskUserQuestion] }')));
    expect(asks.exceedsScope).toEqual([{ role: 'architect', tool: 'AskUserQuestion', scope: 'read' }]);
    // The explorer keeps AskUserQuestion under both names.
    const explorerAsks = parseToolManifest(message(SAMPLE_YAML.replace('toolsAllowed: { reviewer: [Read, Grep, run_project_tests] }', 'toolsAllowed: { explorer: [AskUserQuestion, tracker_get] }')));
    expect(explorerAsks.exceedsScope).toEqual([]);
  });

  it('judges a permission rule by its tool and a server wildcard by every tool behind it', () => {
    expect(resolveManifestToolNames('Bash(npm test:*)')).toEqual(['Bash']);
    expect(resolveManifestToolNames('Read(src/**)')).toEqual(['Read']);
    expect(resolveManifestToolNames('mcp__nimbalyst-host__*')).toEqual(expect.arrayContaining(['mcp__nimbalyst-host__create_session', 'mcp__nimbalyst-host__run_project_tests']));
    expect(resolveManifestToolNames('mcp__github__*')).toEqual(['mcp__github__*']);
    // write denies shell and delegation: the rule and the wildcard both exceed it.
    const shell = parseToolManifest(message(SAMPLE_YAML
      .replace('{ role: reviewer, scope: review, why: touches persisted metadata }', '{ role: implementer, scope: write, why: saves a report only }')
      .replace('toolsAllowed: { reviewer: [Read, Grep, run_project_tests] }', 'toolsAllowed: { implementer: ["Bash(npm test:*)", "mcp__nimbalyst-host__*"] }')));
    expect(shell.exceedsScope).toEqual([
      { role: 'implementer', tool: 'Bash(npm test:*)', scope: 'write' },
      { role: 'implementer', tool: 'mcp__nimbalyst-host__*', scope: 'write' },
    ]);
    expect(shell.ok).toBe(false);
    // A narrowed read rule is not a violation for the reviewer.
    const narrowedRead = parseToolManifest(message(SAMPLE_YAML.replace('toolsAllowed: { reviewer: [Read, Grep, run_project_tests] }', 'toolsAllowed: { reviewer: ["Read(src/**)", "Grep(src)"] }')));
    expect(narrowedRead.exceedsScope).toEqual([]);
    expect(narrowedRead.ok).toBe(true);
  });

  it('a member planned as write cannot be allowed the test runner: write edits, it never executes (NIB.23)', () => {
    const planned = parseToolManifest(message(SAMPLE_YAML
      .replace('{ role: reviewer, scope: review, why: touches persisted metadata }', '{ role: implementer, scope: write, why: saves files only }')
      .replace('toolsAllowed: { reviewer: [Read, Grep, run_project_tests] }', 'toolsAllowed: { implementer: [Read, Edit, run_project_tests] }')));
    expect(planned.exceedsScope).toEqual([{ role: 'implementer', tool: 'run_project_tests', scope: 'write' }]);
    expect(planned.ok).toBe(false);
  });

  it('never lets a planned scope widen a role: a reviewer planned as full is still judged as review', () => {
    const widened = parseToolManifest(message(SAMPLE_YAML
      .replace('{ role: reviewer, scope: review, why: touches persisted metadata }', '{ role: reviewer, scope: full, why: wants everything }')
      .replace('toolsAllowed: { reviewer: [Read, Grep, run_project_tests] }', 'toolsAllowed: { reviewer: [Bash] }')));
    expect(widened.exceedsScope).toEqual([{ role: 'reviewer', tool: 'Bash', scope: 'review' }]);
    expect(widened.ok).toBe(false);
  });

  it('refuses a non-string tool item and judges a member by the narrower scope the plan gives it', () => {
    const nested = parseToolManifest(message(SAMPLE_YAML.replace('toolsAllowed: { reviewer: [Read, Grep, run_project_tests] }', 'toolsAllowed: { reviewer: [[Bash]] }')));
    expect(nested.ok).toBe(false);
    expect(nested.errors.join(' ')).toMatch(/toolsAllowed\.reviewer holds an item that is not a tool name/);
    const narrowed = parseToolManifest(message(SAMPLE_YAML
      .replace('{ role: reviewer, scope: review, why: touches persisted metadata }', '{ role: implementer, scope: write, why: saves a report only }')
      .replace('toolsAllowed: { reviewer: [Read, Grep, run_project_tests] }', 'toolsAllowed: { implementer: [Read, Write, Bash] }')));
    expect(narrowed.exceedsScope).toEqual([{ role: 'implementer', tool: 'Bash', scope: 'write' }]);
    expect(narrowed.ok).toBe(false);
  });

  it('refuses an ECC id that is only a prototype property of the index', () => {
    for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const result = parseToolManifest(message(SAMPLE_YAML.replace('id: ecc:skill:tdd-workflow', `id: ${id}`)));
      expect(result.ok, id).toBe(false);
      expect(result.errors.join(' '), id).toContain(`${id} is not a citable catalog entry`);
    }
  });

  it('validates mcpRecommended: a server name, never a read or review member', () => {
    const bad = parseToolManifest(message(SAMPLE_YAML.replace('mcpRecommended: []', 'mcpRecommended:\n  - { server: context7, purpose: docs, scope: read, authorizationRequired: true }\n  - { purpose: no server }')));
    expect(bad.ok).toBe(false);
    expect(bad.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/context7 cannot serve a read member/),
      'mcpRecommended: each item needs a server name',
    ]));
    const good = parseToolManifest(message(SAMPLE_YAML.replace('mcpRecommended: []', 'mcpRecommended:\n  - { server: context7, purpose: docs, scope: full, authorizationRequired: true }')));
    expect(good.ok).toBe(true);
    // Nimbalyst's own server (what the live architect wrote for run_project_tests) is infrastructure, never a recommendation to authorize.
    const firstParty = parseToolManifest(message(SAMPLE_YAML.replace('mcpRecommended: []', 'mcpRecommended:\n  - { server: nimbalyst-host, purpose: run_project_tests for the reviewer, scope: review, authorizationRequired: false }')));
    expect(firstParty.ok).toBe(false);
    expect(firstParty.errors).toEqual([expect.stringMatching(/nimbalyst-host is Nimbalyst's own infrastructure, not an external server/)]);
    for (const server of ['nimbalyst', 'nimbalyst-trackers', 'nimbalyst-situational']) {
      const own = parseToolManifest(message(SAMPLE_YAML.replace('mcpRecommended: []', `mcpRecommended:\n  - { server: ${server}, purpose: x, scope: full, authorizationRequired: true }`)));
      expect(own.ok, server).toBe(false);
    }
    // An external server is always the user's call: authorizationRequired must be true.
    for (const flag of ['false', 'missing']) {
      const entry = flag === 'missing' ? '{ server: context7, purpose: docs, scope: full }' : '{ server: context7, purpose: docs, scope: full, authorizationRequired: false }';
      const external = parseToolManifest(message(SAMPLE_YAML.replace('mcpRecommended: []', `mcpRecommended:\n  - ${entry}`)));
      expect(external.ok, flag).toBe(false);
      expect(external.errors, flag).toEqual([expect.stringMatching(/context7 is external, so authorizationRequired must be true/)]);
    }
  });

  it('role scopes mirror the team policy: explorer, architect and advisor read, reviewer review, implementer and other unrestricted', () => {
    expect(TOOL_MANIFEST_ROLE_SCOPES).toEqual({ explorer: 'read', architect: 'read', advisor: 'read', reviewer: 'review', implementer: 'full', other: 'full' });
  });

  it('refuses a reviewer or an architect planned above their scope and warns about missing preparation and provenance', () => {
    const planned = parseToolManifest(message(SAMPLE_YAML.replace('{ role: reviewer, scope: review, why: touches persisted metadata }', '{ role: reviewer, scope: full, why: x }\n    - { role: architect, scope: write, why: y }')));
    expect(planned.errors).toEqual(expect.arrayContaining([
      'teamPlan.members: a reviewer never runs above the review scope',
      'teamPlan.members: an architect never runs above the read scope',
    ]));
    const bare = parseToolManifest(message(withoutLine('generatedBy:'), '\n'));
    expect(bare.ok).toBe(true);
    expect(bare.preparation).toBeNull();
    expect(bare.warnings).toEqual(expect.arrayContaining([
      'generatedBy.role should be architect',
      expect.stringMatching(/does not end with `Preparation: complete`/),
    ]));
  });
});

describe('Tool Manifest v1: nothing in the app consumes toolsAllowed to grant anything', () => {
  const roots = [
    path.resolve(__dirname, '../../../../..', 'src'),
    path.resolve(__dirname, '../../../../../..', 'electron', 'src'),
  ];
  const allowed = new Set([
    path.resolve(__dirname, '../toolManifest.ts'),
    path.resolve(__dirname, '../../../prompt.ts'),
  ]);

  function walk(dir: string, out: string[]): void {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '__tests__' || name === 'dist' || name === 'out') continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
    }
  }

  it('toolsAllowed appears only in the validator and in the prompt text', () => {
    const files: string[] = [];
    for (const root of roots) walk(root, files);
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.filter((file) => !allowed.has(path.resolve(file)) && readFileSync(file, 'utf8').includes('toolsAllowed'));
    expect(offenders).toEqual([]);
  });
});

describe('re-emission and host-side assessment (Phase 1A.1)', () => {
  const asManifest = (yaml: string) => `\`\`\`yaml\n${yaml}\n\`\`\`\n\nPreparation: complete`;

  it('accepts supersedes naming an earlier manifest and refuses anything else', () => {
    const ok = parseToolManifest(message(SAMPLE_YAML.replace('id: M-1', 'id: M-2\nsupersedes: M-1')));
    expect(ok.ok).toBe(true);
    expect(ok.manifest?.supersedes).toBe('M-1');
    const same = parseToolManifest(message(SAMPLE_YAML.replace('id: M-1', 'id: M-2\nsupersedes: M-2')));
    expect(same.errors).toEqual([expect.stringMatching(/supersedes must name an earlier manifest than M-2/)]);
    const later = parseToolManifest(message(SAMPLE_YAML.replace('id: M-1', 'id: M-1\nsupersedes: M-3')));
    expect(later.errors).toEqual([expect.stringMatching(/supersedes must name an earlier manifest than M-1/)]);
    const junk = parseToolManifest(message(SAMPLE_YAML.replace('id: M-1', 'id: M-2\nsupersedes: previous')));
    expect(junk.errors).toEqual([expect.stringMatching(/supersedes must be M-<n>/)]);
  });

  it('assessArchitectReport: none for prose, valid up to 7,500, too-long above it with the YAML block whole', () => {
    expect(assessArchitectReport('just a report')).toEqual({ kind: 'none' });
    expect(assessArchitectReport(null)).toEqual({ kind: 'none' });
    const small = asManifest(SAMPLE_YAML);
    expect(assessArchitectReport(small)).toEqual({ kind: 'valid', chars: small.length, id: 'M-1' });
    const big = `${asManifest(SAMPLE_YAML)}\n\n## Notes\n${'z'.repeat(TOOL_MANIFEST_MAX_CHARS)}`;
    const assessment = assessArchitectReport(big);
    expect(assessment.kind).toBe('too-long');
    if (assessment.kind !== 'too-long') throw new Error('unreachable');
    expect(assessment.chars).toBe(big.length);
    expect(assessment.limit).toBe(TOOL_MANIFEST_MAX_CHARS);
    expect(assessment.id).toBe('M-1');
    expect(assessment.yamlBlock).toBe(`\`\`\`yaml\n${SAMPLE_YAML.trim()}\n\`\`\``);
    const notice = describeTooLongManifest(assessment);
    expect(notice).toContain('MANIFEST TOO LONG');
    expect(notice).toContain(`${big.length} characters`);
    expect(notice).toContain('Preparation is NOT complete');
    expect(notice).toContain('Do not declare per manifest M-1');
    expect(notice).toContain('as M-2 with supersedes: M-1');
    // Exactly the limit is still valid: the contract is inclusive.
    const exact = `${small}${'\n'.repeat(Math.max(0, TOOL_MANIFEST_MAX_CHARS - small.length))}`;
    expect(assessArchitectReport(exact).kind).toBe('valid');
  });

  it('assessArchitectReport: a manifest within the limit that breaks the contract is invalid, with the errors, and renders with a notice and no complete Preparation line', () => {
    const text = asManifest(SAMPLE_YAML.replace('mcpRecommended: []', 'mcpRecommended:\n  - { server: nimbalyst-host, purpose: tests, scope: review, authorizationRequired: false }'));
    const assessment = assessArchitectReport(text);
    expect(assessment.kind).toBe('invalid');
    if (assessment.kind !== 'invalid') throw new Error('unreachable');
    expect(assessment.id).toBe('M-1');
    expect(assessment.errors).toEqual([expect.stringMatching(/nimbalyst-host is Nimbalyst's own infrastructure/)]);
    const notice = describeInvalidManifest(assessment);
    expect(notice).toContain('MANIFEST INVALID: 1 error(s)');
    expect(notice).toContain('Preparation is NOT complete');
    expect(notice).toContain('corrected as M-2 with supersedes: M-1');
    const rendered = renderArchitectReportForUpdate(text, 8000);
    expect(rendered).not.toMatch(/^Preparation:\s*complete/m);
    expect(rendered).toContain('Preparation: invalid (see the notice below)');
    expect(rendered).toContain(notice);
    expect(neutralizePreparationLine('x\nPreparation: complete\ny')).toBe('x\nPreparation: invalid (see the notice below)\ny');
    expect(neutralizePreparationLine('Preparation: partial (no tests)')).toBe('Preparation: partial (no tests)');
    // A valid manifest renders untouched; prose above the cap gets the ordinary marker.
    expect(renderArchitectReportForUpdate(asManifest(SAMPLE_YAML), 8000)).toBe(asManifest(SAMPLE_YAML));
    expect(renderArchitectReportForUpdate('w'.repeat(8010), 8000)).toContain('[truncated: 10 more characters');
  });
});
