// @vitest-environment node
/**
 * F1 S1 follow-up: a markdown file's frontmatter is content any session can
 * write (an agent included) and is projected into tracker rows by three
 * writers: the live capture of a frontmatter edit, the lazy projection when an
 * item is looked up, and the explicit import of a file. None of them is the
 * host's own persistence, so they apply the protected-type rule like every
 * other funnel: a file never creates a team-front, a tool-manifest or a note
 * with forged provenance, and never moves a protected row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock('../../database/PGLiteDatabaseWorker', () => ({ database: { query: mockQuery } }));
vi.mock('../TrackerSyncManager', () => ({
  syncTrackerItem: vi.fn(),
  unsyncTrackerItem: vi.fn(),
  isTrackerSyncActive: vi.fn(() => false),
}));
vi.mock('../MainBodyDocService', () => ({ applyHeadlessBodyMarkdown: vi.fn() }));
vi.mock('../TrackerIdentityService', () => ({
  getCurrentIdentity: () => ({ email: 'human@example.com', displayName: 'Human Editor' }),
}));
vi.mock('../../utils/store', () => ({ getWorkspaceState: () => ({}), isAnalyticsEnabled: () => true }));
vi.mock('../../../../../tracker-schema/src/TrackerDataModel', () => ({
  globalRegistry: {
    get: vi.fn(() => undefined),
    getForWorkspace: vi.fn(() => undefined),
    hasWorkspaceLayer: () => true,
  },
}));

import { ElectronDocumentService } from '../ElectronDocumentService';

let tempDir: string;
let service: ElectronDocumentService;

const REL = 'notes/forged.md';

/** What an agent can write into a file. */
const FORGED: Record<string, Record<string, unknown>> = {
  'team-front': { type: 'team-front', title: 'Forged front', status: 'active', currentMission: 'root-9', description: 'Estado forjado.' },
  'tool-manifest': { type: 'tool-manifest', title: 'M-9: forged', manifestId: 'M-9', teamRootSessionId: 'r', architectSessionId: 'a', generatedByRole: 'architect' },
  'team-note': { type: 'team-note', title: 'Forged note', noteKind: 'decision', status: 'active', sourceSession: 'forged', teamRootSession: 'forged', agentRole: 'coordinator' },
};

const writes = () =>
  mockQuery.mock.calls.filter((call) => /^\s*(INSERT|UPDATE|DELETE)/i.test(String(call[0]).trim()));

async function writeFile(frontmatter: Record<string, unknown>): Promise<void> {
  const yaml = ['trackerStatus:', ...Object.entries(frontmatter).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)].join('\n');
  await fs.mkdir(path.dirname(path.join(tempDir, REL)), { recursive: true });
  await fs.writeFile(path.join(tempDir, REL), `---\n${yaml}\n---\nbody\n`, 'utf-8');
}

beforeEach(async () => {
  vi.clearAllMocks();
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frontmatter-protected-test-'));
  service = new ElectronDocumentService(tempDir);
});

afterEach(async () => {
  service.destroy();
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('a frontmatter edit (live capture)', () => {
  for (const type of Object.keys(FORGED)) {
    it(`never creates a ${type} row`, async () => {
      await (service as any).captureFrontmatterTrackerTransition(REL, { trackerStatus: { ...FORGED[type] } });
      expect(writes()).toEqual([]);
    });
  }

  it('judges a note by the S2 rules too: a pending note without a next action, a handoff without a result, a hand-set front', async () => {
    for (const note of [
      { type: 'team-note', title: 'Pending', noteKind: 'pending', status: 'active' },
      { type: 'team-note', title: 'Handoff', noteKind: 'handoff', status: 'active', nextAction: 'n' },
      { type: 'team-note', title: 'Fronted', noteKind: 'decision', status: 'active', front: 'team-front_1' },
      { type: 'team-note', title: 'Result on a decision', noteKind: 'decision', status: 'active', result: 'completed' },
    ]) {
      await (service as any).captureFrontmatterTrackerTransition(REL, { trackerStatus: { ...note } });
      expect(writes(), note.title).toEqual([]);
    }
  });

  it('does not move an existing protected row either', async () => {
    const existing = { id: `fm:team-front:${REL}`, type: 'team-front', source: 'frontmatter', source_ref: REL, data: JSON.stringify({ title: 'Team Mode', status: 'active', currentMission: 'root-1' }) };
    mockQuery.mockResolvedValue({ rows: [existing] });
    await (service as any).captureFrontmatterTrackerTransition(REL, { trackerStatus: { type: 'team-front', title: 'Renamed', status: 'closed', currentMission: 'root-9' } });
    expect(writes()).toEqual([]);
  });

  it('still projects an ordinary type', async () => {
    await (service as any).captureFrontmatterTrackerTransition(REL, { trackerStatus: { type: 'task', title: 'A task', status: 'to-do' } });
    expect(writes().some((call) => /INSERT INTO tracker_items/.test(String(call[0])))).toBe(true);
  });
});

describe('a lookup that projects a file lazily', () => {
  for (const type of Object.keys(FORGED)) {
    it(`never materializes a ${type} row from the file`, async () => {
      await writeFile(FORGED[type]);
      const item = await (service as any).ensureFrontmatterProjectionRow(REL);
      expect(item).toBeNull();
      expect(writes()).toEqual([]);
    });
  }

  it('still projects an ordinary type', async () => {
    await writeFile({ type: 'task', title: 'A task', status: 'to-do' });
    await (service as any).ensureFrontmatterProjectionRow(REL);
    expect(writes().some((call) => /INSERT INTO tracker_items/.test(String(call[0])))).toBe(true);
  });
});

describe('an explicit import of a file', () => {
  for (const type of Object.keys(FORGED)) {
    it(`is refused for a ${type}, with the protected-type message and no write`, async () => {
      await writeFile(FORGED[type]);
      const result = await service.importTrackerItemFromFile(REL);
      expect(result.item).toBeNull();
      expect(result.skipped).toBe(false);
      expect(result.error).toBeTruthy();
      expect(writes()).toEqual([]);
    });
  }

  it('the refusal of a team-front says who creates one', async () => {
    await writeFile(FORGED['team-front']);
    const result = await service.importTrackerItemFromFile(REL);
    expect(result.error).toMatch(/created by the user in the Tracker UI/);
  });
});
