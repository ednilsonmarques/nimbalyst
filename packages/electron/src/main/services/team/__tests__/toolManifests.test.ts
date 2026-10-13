// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../database/PGLiteDatabaseWorker', () => ({ database: { query: vi.fn().mockResolvedValue({ rows: [] }) } }));

import { setLanguage } from '@nimbalyst/runtime/i18n';
import { TOOL_MANIFEST_REF_METADATA_KEY } from '@nimbalyst/runtime/ai/server/providers/teamContext';
import { TOOL_MANIFEST_MAX_CHARS } from '@nimbalyst/runtime/ai/server/providers/toolManifest';
import { database } from '../../../database/PGLiteDatabaseWorker';
import {
  TOOL_MANIFEST_NOTICE_CONTEXT,
  buildToolManifestNotice,
  formatToolManifestSummary,
  manifestNumber,
  persistArchitectManifest,
  planToolManifestPersistence,
  recordToolManifestRef,
  toolManifestContentHash,
  type StoredToolManifest,
  type ToolManifestTrackerPort,
} from '../toolManifests';

/** A complete, contract-valid manifest (the validator accepts it), as the architect's final message. */
function manifestText(id = 'M-1', extra = ''): string {
  return [
    '```yaml',
    'toolManifest: 1',
    `id: ${id}`,
    ...(extra ? [extra] : []),
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
    'eccCapabilities:',
    '  - { id: "ecc:skill:tdd-workflow", for: implementer, class: A, purpose: tests first }',
    'toolsAllowed:',
    '  implementer: [Read, Edit, Bash]',
    '  reviewer: [Read, run_project_tests]',
    'toolsForbidden: [WebFetch]',
    'mcpRecommended: []',
    'mcpForbidden: []',
    'testsRequired:',
    '  - { name: T1, how: "npm test", gate: blocking }',
    'validationStrategy: "tests first"',
    'risks:',
    '  - { id: R1, severity: low, text: "trim on output", mitigation: "guard only" }',
    'openQuestions: []',
    'doneCriteria: ["npm test green"]',
    'limitations: ["no commit"]',
    'evidence: ["src/greeting.js"]',
    'confidence: high',
    'generatedBy: { role: architect, model: claude-code:opus, ecc: 2.2.3 }',
    '```',
    '',
    '## Oracle findings',
    'The test file is the contract.',
    '',
    'Preparation: complete',
  ].join('\n');
}

const settle = (overrides: Partial<Parameters<typeof persistArchitectManifest>[0]> = {}) => ({
  sessionId: 'arch-1',
  rootSessionId: 'root-1',
  workspacePath: '/ws',
  model: 'claude-code:opus',
  finalOutput: manifestText(),
  ...overrides,
});

function fakePort(existing: StoredToolManifest[] = []) {
  const created: Array<Parameters<ToolManifestTrackerPort['create']>[0]> = [];
  const statuses: Array<[string, string]> = [];
  let counter = 0;
  const port: ToolManifestTrackerPort = {
    listTeamManifests: vi.fn(async (rootSessionId: string) => existing.filter(() => rootSessionId === 'root-1')),
    create: vi.fn(async (payload) => {
      created.push(payload);
      counter += 1;
      return { itemId: `item-${counter}`, ref: `NIB.${30 + counter}` };
    }),
    setStatus: vi.fn(async (itemId, status) => { statuses.push([itemId, status]); }),
  };
  return { port, created, statuses };
}

const stored = (overrides: Partial<StoredToolManifest>): StoredToolManifest => ({
  itemId: 'item-0', ref: 'NIB.30', manifestId: 'M-1', status: 'draft', architectSessionId: 'arch-1', declaredManifestId: null, contentHash: 'h0', archived: false,
  ...overrides,
});

beforeEach(() => {
  setLanguage('en');
  vi.mocked(database.query).mockClear();
});

describe('the deterministic rule', () => {
  it('a first manifest keeps its declared id and supersedes nothing', () => {
    expect(planToolManifestPersistence({ id: 'M-1', contentHash: 'h1' }, [], 'arch-1')).toEqual({
      action: 'create', manifestId: 'M-1', declaredManifestId: null, supersedesItemId: null, superseded: [],
    });
    expect(manifestNumber('M-12')).toBe(12);
    expect(manifestNumber('manifest')).toBe(0);
  });

  it('a follow-up M-2 supersedes M-1, accepted or not, and links to it', () => {
    const plan = planToolManifestPersistence({ id: 'M-2', contentHash: 'h2' }, [stored({ status: 'accepted' })], 'arch-1');
    expect(plan).toEqual({
      action: 'create', manifestId: 'M-2', declaredManifestId: null, supersedesItemId: 'item-0',
      superseded: [{ itemId: 'item-0', manifestId: 'M-1', ref: 'NIB.30' }],
    });
  });

  it('a replay (same architect, same id, same body) is recognized and nothing is written', () => {
    const hash = toolManifestContentHash(manifestText());
    expect(planToolManifestPersistence({ id: 'M-1', contentHash: hash }, [stored({ contentHash: hash })], 'arch-1'))
      .toEqual({ action: 'skip', reason: 'already-persisted', itemId: 'item-0' });
    // The same id with another body is a new version, never an overwrite.
    const plan = planToolManifestPersistence({ id: 'M-1', contentHash: 'changed' }, [stored({ contentHash: hash })], 'arch-1');
    expect(plan).toMatchObject({ action: 'create', manifestId: 'M-2', declaredManifestId: 'M-1', supersedesItemId: 'item-0' });
  });

  it('ids are monotonic per team: a taken or lower id gets the next number, a higher one is kept', () => {
    const existing = [stored({ manifestId: 'M-1', status: 'superseded' }), stored({ itemId: 'item-3', ref: 'NIB.33', manifestId: 'M-3', architectSessionId: 'arch-9', contentHash: 'h3' })];
    expect(planToolManifestPersistence({ id: 'M-1', contentHash: 'x' }, existing, 'arch-2'))
      .toMatchObject({ action: 'create', manifestId: 'M-4', declaredManifestId: 'M-1', supersedesItemId: 'item-3', superseded: [{ itemId: 'item-3', manifestId: 'M-3', ref: 'NIB.33' }] });
    expect(planToolManifestPersistence({ id: 'M-7', contentHash: 'x' }, existing, 'arch-2'))
      .toMatchObject({ action: 'create', manifestId: 'M-7', declaredManifestId: null });
    // A superseded manifest is never superseded again; only the current ones are.
    expect(planToolManifestPersistence({ id: 'M-7', contentHash: 'x' }, existing, 'arch-2').action === 'create'
      && planToolManifestPersistence({ id: 'M-7', contentHash: 'x' }, existing, 'arch-2')).toMatchObject({ superseded: [{ itemId: 'item-3' }] });
  });
});

describe('the deterministic rule, archived items', () => {
  it('an archived manifest still counts for numbering and replay, but is never the current one', () => {
    const archived = stored({ status: 'accepted', archived: true });
    expect(planToolManifestPersistence({ id: 'M-1', contentHash: 'h9' }, [archived], 'arch-2'))
      .toEqual({ action: 'create', manifestId: 'M-2', declaredManifestId: 'M-1', supersedesItemId: null, superseded: [] });
    expect(planToolManifestPersistence({ id: 'M-1', contentHash: 'h0' }, [archived], 'arch-1'))
      .toEqual({ action: 'skip', reason: 'already-persisted', itemId: 'item-0' });
  });
});

describe('persistArchitectManifest', () => {
  it('stores a valid manifest with host provenance, the whole report as the body and status draft', async () => {
    const { port, created } = fakePort();
    const recordRootRef = vi.fn(async () => {});
    const result = await persistArchitectManifest(settle(), port, { recordRootRef, now: () => new Date('2026-10-13T18:00:00Z') });
    expect(result).toMatchObject({ persisted: true, itemId: 'item-1', ref: 'NIB.31', manifestId: 'M-1', declaredManifestId: null, confidence: 'high', superseded: [], supersedeFailures: [] });
    expect(created).toHaveLength(1);
    expect(created[0].title).toBe('M-1: Make formatGreeting reject blank names');
    expect(created[0].status).toBe('draft');
    expect(created[0].description).toBe(manifestText());
    expect(created[0].customFields).toEqual({
      manifestId: 'M-1', manifestVersion: '1', teamRootSessionId: 'root-1', architectSessionId: 'arch-1',
      generatedByRole: 'architect', model: 'claude-code:opus', confidence: 'high', contentHash: toolManifestContentHash(manifestText()),
    });
    expect(port.listTeamManifests).toHaveBeenCalledWith('root-1');
    expect(recordRootRef).toHaveBeenCalledWith('root-1', { itemId: 'item-1', ref: 'NIB.31', manifestId: 'M-1', architectSessionId: 'arch-1', at: '2026-10-13T18:00:00.000Z' });
  });

  it('never stores a TOO LONG, an INVALID or a non-manifest report, nor an empty output', async () => {
    const { port, created } = fakePort();
    const tooLong = manifestText('M-1') + '\n' + 'x'.repeat(TOOL_MANIFEST_MAX_CHARS);
    expect(await persistArchitectManifest(settle({ finalOutput: tooLong }), port)).toMatchObject({ persisted: false, reason: 'too-long' });
    const invalid = manifestText('M-1').replace('confidence: high', 'confidence: certain');
    expect(await persistArchitectManifest(settle({ finalOutput: invalid }), port)).toMatchObject({ persisted: false, reason: 'invalid', detail: expect.stringMatching(/confidence/) });
    expect(await persistArchitectManifest(settle({ finalOutput: 'I read the files; no manifest yet.' }), port)).toEqual({ persisted: false, reason: 'not-a-manifest' });
    expect(await persistArchitectManifest(settle({ finalOutput: null }), port)).toEqual({ persisted: false, reason: 'no-output' });
    expect(created).toHaveLength(0);
    expect(port.listTeamManifests).not.toHaveBeenCalled();
  });

  it('a replayed completion writes nothing and produces no notice material', async () => {
    const hash = toolManifestContentHash(manifestText());
    const { port, created } = fakePort([stored({ contentHash: hash })]);
    expect(await persistArchitectManifest(settle(), port, { recordRootRef: async () => {} })).toEqual({ persisted: false, reason: 'already-persisted', detail: 'item-0' });
    expect(created).toHaveLength(0);
    expect(port.setStatus).not.toHaveBeenCalled();
  });

  it('M-2 after an accepted M-1: M-1 becomes superseded, M-2 is the current draft linked to M-1', async () => {
    const { port, created, statuses } = fakePort([stored({ status: 'accepted' })]);
    const result = await persistArchitectManifest(settle({ finalOutput: manifestText('M-2', 'supersedes: M-1') }), port, { recordRootRef: async () => {} });
    expect(result).toMatchObject({ persisted: true, manifestId: 'M-2', supersedesItemId: 'item-0', superseded: [{ itemId: 'item-0', manifestId: 'M-1', ref: 'NIB.30' }] });
    expect(created[0].customFields).toMatchObject({ manifestId: 'M-2', supersedes: ['item-0'] });
    expect(statuses).toEqual([['item-0', 'superseded']]);
  });

  it('an invalid M-1 followed by a valid M-2 leaves M-2 as the only manifest, with its declared id', async () => {
    const { port, created } = fakePort();
    const invalid = manifestText('M-1').replace('confidence: high', 'confidence: certain');
    expect(await persistArchitectManifest(settle({ finalOutput: invalid }), port)).toMatchObject({ persisted: false, reason: 'invalid' });
    // A block that does not even declare toolManifest: 1 is no manifest at all; it is not stored either.
    expect(await persistArchitectManifest(settle({ finalOutput: manifestText('M-1').replace('toolManifest: 1', 'toolManifest: 2') }), port))
      .toEqual({ persisted: false, reason: 'not-a-manifest' });
    const result = await persistArchitectManifest(settle({ finalOutput: manifestText('M-2', 'supersedes: M-1') }), port, { recordRootRef: async () => {} });
    expect(result).toMatchObject({ persisted: true, manifestId: 'M-2', declaredManifestId: null, supersedesItemId: null, superseded: [] });
    expect(created).toHaveLength(1);
  });

  it('only the team\'s own manifests count: the port is asked for this root, another root\'s items are invisible', async () => {
    const { port } = fakePort([stored({ status: 'accepted' })]);
    const result = await persistArchitectManifest(settle({ rootSessionId: 'root-2', sessionId: 'arch-2' }), port, { recordRootRef: async () => {} });
    expect(port.listTeamManifests).toHaveBeenCalledWith('root-2');
    expect(result).toMatchObject({ persisted: true, manifestId: 'M-1', superseded: [] });
    expect(port.setStatus).not.toHaveBeenCalled();
  });

  it('a tracker failure is the result\'s reason, never a throw; a failed supersede is reported, not hidden', async () => {
    const broken: ToolManifestTrackerPort = {
      listTeamManifests: async () => { throw new Error('db locked'); },
      create: async () => { throw new Error('unreachable'); },
      setStatus: async () => {},
    };
    const log = vi.fn();
    expect(await persistArchitectManifest(settle(), broken, { log })).toEqual({ persisted: false, reason: 'failed', detail: 'db locked' });
    expect(log).toHaveBeenCalledWith('persistence failed', expect.any(Error));

    const { port } = fakePort([stored({ status: 'accepted' })]);
    vi.mocked(port.setStatus).mockRejectedValueOnce(new Error('row gone'));
    const result = await persistArchitectManifest(settle({ finalOutput: manifestText('M-2') }), port, { recordRootRef: async () => {}, log });
    expect(result).toMatchObject({ persisted: true, manifestId: 'M-2', superseded: [], supersedeFailures: [{ itemId: 'item-0', manifestId: 'M-1', ref: 'NIB.30' }] });
  });

  it('a failing root-ref write does not undo the stored item', async () => {
    const { port, created } = fakePort();
    const log = vi.fn();
    const result = await persistArchitectManifest(settle(), port, { recordRootRef: async () => { throw new Error('no root'); }, log });
    expect(result).toMatchObject({ persisted: true, itemId: 'item-1' });
    expect(created).toHaveLength(1);
    expect(log).toHaveBeenCalledWith('could not record the manifest ref on the team root', expect.any(Error));
  });
});

describe('the root pointer', () => {
  it('is a short ref merged into the root metadata by the host, never the manifest', async () => {
    await recordToolManifestRef('root-1', { itemId: 'item-1', ref: 'NIB.31', manifestId: 'M-1', architectSessionId: 'arch-1', at: 'now' });
    expect(database.query).toHaveBeenCalledTimes(1);
    const [sql, params] = vi.mocked(database.query).mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE ai_sessions SET metadata = COALESCE\(metadata, '\{\}'::jsonb\) \|\| \$1::jsonb WHERE id = \$2/);
    expect(params[1]).toBe('root-1');
    const merged = JSON.parse(params[0] as string);
    expect(Object.keys(merged)).toEqual([TOOL_MANIFEST_REF_METADATA_KEY]);
    expect(merged[TOOL_MANIFEST_REF_METADATA_KEY]).toEqual({ itemId: 'item-1', ref: 'NIB.31', manifestId: 'M-1', architectSessionId: 'arch-1', at: 'now' });
    expect((params[0] as string).length).toBeLessThan(300);
  });
});

describe('the notice', () => {
  const persisted = {
    persisted: true as const, itemId: 'item-1', ref: 'NIB.31', manifestId: 'M-2', declaredManifestId: null, confidence: 'high',
    architectSessionId: 'arch-1', rootSessionId: 'root-1', supersedesItemId: 'item-0',
    superseded: [{ itemId: 'item-0', manifestId: 'M-1', ref: 'NIB.30' }], supersedeFailures: [],
  };

  it('names the id, the item ref, the architect session and the confidence, never the manifest body', () => {
    const notice = buildToolManifestNotice(persisted);
    expect(notice).toContain('[Tool Manifest] M-2 from the architect (session arch-1) is stored as tracker item NIB.31 (confidence: high)');
    expect(notice).toContain('mark the item accepted with tracker_update (status only)');
    expect(notice).toContain('a divergence becomes a Team Note, never an edit of the item');
    expect(notice).toContain('tracker_get NIB.31 returns it');
    expect(notice).toContain('It supersedes M-1 (NIB.30), now marked superseded: M-2 is the current manifest.');
    expect(notice).not.toContain('toolManifest: 1');
    expect(notice.length).toBeLessThan(900);
    expect(buildToolManifestNotice({ ...persisted, declaredManifestId: 'M-1' })).toContain('The architect declared it M-1; that id was already used in this team, so Nimbalyst numbered it M-2.');
    expect(buildToolManifestNotice({ ...persisted, superseded: [], confidence: null })).not.toContain('supersedes');
    expect(buildToolManifestNotice({ ...persisted, superseded: [], confidence: null })).toContain('(confidence: unknown)');
    // A supersede the tracker refused is named, so the coordinator knows the old item still says accepted.
    expect(buildToolManifestNotice({ ...persisted, superseded: [], supersedeFailures: [{ itemId: 'item-0', manifestId: 'M-1', ref: 'NIB.30' }] }))
      .toContain('Nimbalyst could not mark M-1 (NIB.30) as superseded; M-2 is still the current manifest, as the newest id.');
  });

  it('follows the UI language and is queued as system orchestration with its own origin', () => {
    setLanguage('pt-BR');
    const notice = buildToolManifestNotice(persisted);
    expect(notice).toContain('[Tool Manifest] M-2 do architect (sessão arch-1) foi gravado como item NIB.31 do Tracker (confiança: high)');
    expect(notice).toContain('Ele substitui M-1 (NIB.30), agora marcado como superseded: M-2 é o manifesto atual.');
    expect(TOOL_MANIFEST_NOTICE_CONTEXT).toEqual({
      promptOrigin: 'tool_manifest',
      promptProvenance: { actor: 'system', origin: 'session-orchestration', messageKind: 'status' },
    });
  });

  it('lists compactly for tracker_list', () => {
    const line = formatToolManifestSummary({ title: 'M-2: Make formatGreeting reject blank names', status: 'accepted', customFields: { manifestId: 'M-2', architectSessionId: 'arch-1-abcdef', confidence: 'high' } }, 'NIB.31');
    expect(line).toBe('- [MANIFEST M-2] M-2: Make formatGreeting reject blank names (accepted) [ref: NIB.31] · architect session arch-1-a, confidence high');
  });
});
