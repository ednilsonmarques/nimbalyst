// @vitest-environment node
/**
 * `independentReview` in a stored manifest is a recommendation the host never
 * acts on: a manifest that requires a second opinion is persisted like any
 * other, nothing about it reaches the item's host fields, and no host module
 * on the persistence or creation path reads the field at all.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../database/PGLiteDatabaseWorker', () => ({ database: { query: vi.fn().mockResolvedValue({ rows: [] }) } }));

import { persistArchitectManifest, type ToolManifestTrackerPort } from '../toolManifests';

function manifestText(independentReview: string): string {
  return [
    '```yaml',
    'toolManifest: 1',
    'id: M-1',
    'task: "Make formatGreeting reject blank names"',
    'objective: "npm test green with the new tests"',
    'oracle:',
    '  sourceOfTruth: "test/greeting.test.js"',
    '  evidenceRequired: ["npm test output"]',
    'teamPlan:',
    '  recommended: TEAM',
    '  members:',
    '    - { role: implementer, scope: full, why: owns the files }',
    '    - { role: reviewer, scope: review, why: independent check }',
    '    - { role: advisor, scope: read, mission: "Question the persistence strategy.", why: irreversible contract }',
    'testsRequired:',
    '  - { name: T1, how: "npm test", gate: blocking }',
    'risks:',
    '  - { id: R1, severity: low, text: "trim on output", mitigation: "guard only" }',
    'doneCriteria: ["npm test green"]',
    'confidence: high',
    ...independentReview.split('\n'),
    'generatedBy: { role: architect, model: claude-code:opus, ecc: 2.2.3 }',
    '```',
    '',
    'Preparation: complete',
  ].join('\n');
}

function fakePort() {
  const created: Array<Parameters<ToolManifestTrackerPort['create']>[0]> = [];
  const port: ToolManifestTrackerPort = {
    listTeamManifests: vi.fn(async () => []),
    create: vi.fn(async (payload) => { created.push(payload); return { itemId: 'item-1', ref: 'NIB.31' }; }),
    setStatus: vi.fn(async () => {}),
  };
  return { port, created };
}

const settle = (finalOutput: string) => ({ sessionId: 'arch-1', rootSessionId: 'root-1', workspacePath: '/ws', model: 'claude-code:opus', finalOutput });

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : walk(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

describe('independentReview is persisted as text and acted on by nobody', () => {
  it.each(['required', 'recommended', 'optional', 'none'])('level %s: the manifest is stored like any other, with no host field for it and no session created', async (level) => {
    const { port, created } = fakePort();
    const recordRootRef = vi.fn(async () => {});
    const text = manifestText(`independentReview:\n  level: ${level}\n  reason: the persistence contract rests on an undocumented premise`);
    const result = await persistArchitectManifest(settle(text), port, { recordRootRef });
    expect(result).toMatchObject({ persisted: true, manifestId: 'M-1' });
    expect(created).toHaveLength(1);
    expect(created[0].description).toBe(text);
    expect(Object.keys(created[0].customFields ?? {})).not.toContain('independentReview');
    expect(JSON.stringify(created[0].customFields)).not.toContain('advisor');
    // The port is the only side effect the persistence has: one item, no status change, no ref beyond the root pointer.
    expect(port.create).toHaveBeenCalledTimes(1);
    expect(port.setStatus).not.toHaveBeenCalled();
    expect(recordRootRef).toHaveBeenCalledTimes(1);
  });

  it('a manifest without the field persists identically (every manifest written before the advisor existed)', async () => {
    const { port, created } = fakePort();
    const result = await persistArchitectManifest(settle(manifestText('')), port, { recordRootRef: async () => {} });
    expect(result).toMatchObject({ persisted: true, manifestId: 'M-1' });
    expect(created).toHaveLength(1);
    expect(port.create).toHaveBeenCalledTimes(1);
  });

  it('no host module on the creation or persistence path reads independentReview: only the validator and the prompt know the field', () => {
    const root = path.join(__dirname, '..', '..');
    const sources = [
      ...walk(path.join(root, 'team')),
      path.join(root, 'MetaAgentService.ts'),
      path.join(root, '..', 'mcp', 'metaAgentServer.ts'),
    ];
    for (const file of sources) {
      expect(readFileSync(file, 'utf8'), file).not.toContain('independentReview');
    }
    // And the team policy names no provider for the advisor outside its one extension point.
    const policy = readFileSync(path.join(root, 'team', 'teamPolicy.ts'), 'utf8');
    expect(policy).toContain('export function teamRoleProvider');
    const service = readFileSync(path.join(root, 'MetaAgentService.ts'), 'utf8');
    expect(service).not.toMatch(/advisor/);
  });
});
