// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// F1 S2: the desktop Tracker UI and its IPC edit a team-note through
// ElectronDocumentService.updateTrackerItem / updateTrackerItemContent. The
// front is the host's, a pending note or a handoff keeps its next action, and
// the body cap follows the kind; a pending note from before nextAction existed
// keeps accepting every unrelated edit.
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

const NOTE = {
  title: 'Port the rules',
  status: 'active',
  noteKind: 'decision',
  description: 'Decided with the user.',
  sourceSession: 'root-1',
  teamRootSession: 'root-1',
  agentRole: 'coordinator',
  front: 'team-front_1',
  activity: [],
};

function installRow(data: Record<string, unknown>, content: unknown = null) {
  const state = {
    row: {
      id: 'note-1', type: 'team-note', source: 'native', source_ref: null, document_path: null, workspace: tempDir,
      data: JSON.stringify(data), sync_status: 'local', last_indexed: new Date().toISOString(), body_version: 0, archived: false, content,
    } as Record<string, unknown>,
  };
  mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (normalized.startsWith('SELECT')) return { rows: [state.row] };
    if (normalized.startsWith('UPDATE tracker_items SET data = $1')) {
      state.row = { ...state.row, data: params?.[0] as string };
      return { rows: [state.row] };
    }
    if (normalized.startsWith('UPDATE tracker_items SET content')) {
      state.row = { ...state.row, content: params?.[0] as string, data: params?.[1] as string, body_version: 1 };
      return { rows: [state.row] };
    }
    if (normalized.startsWith('UPDATE tracker_items SET type_tags') || normalized.startsWith('INSERT INTO tracker_body_cache')) return { rows: [] };
    throw new Error(`Unexpected query in test: ${normalized}`);
  });
  return state;
}

const writes = () => mockQuery.mock.calls.filter((c) => String(c[0]).replace(/\s+/g, ' ').trim().startsWith('UPDATE'));
const stored = (state: { row: Record<string, unknown> }) => JSON.parse(state.row.data as string);

beforeEach(async () => {
  vi.clearAllMocks();
  mockQuery.mockReset();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-note-service-test-'));
  service = new ElectronDocumentService(tempDir);
});

afterEach(async () => {
  service.destroy();
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('the Tracker UI edits a team-note (F1 S2)', () => {
  it('a legacy pending note without nextAction still resolves, goes obsolete and takes a new title and body', async () => {
    const state = installRow({ ...NOTE, noteKind: 'pending' });
    await service.updateTrackerItem('note-1', { status: 'resolved' });
    await service.updateTrackerItem('note-1', { status: 'obsolete' });
    await service.updateTrackerItem('note-1', { title: 'Renamed' });
    await service.updateTrackerItem('note-1', { description: 'A shorter text.' });
    expect(stored(state)).toMatchObject({ noteKind: 'pending', status: 'obsolete', title: 'Renamed', front: 'team-front_1' });
    expect(writes()).toHaveLength(4);
  });

  it('clearing the next action of a pending note is refused, and nothing is written', async () => {
    const state = installRow({ ...NOTE, noteKind: 'pending', nextAction: 'Ask PCP.' });
    await expect(service.updateTrackerItem('note-1', { nextAction: '' })).rejects.toThrow(/nextAction/);
    await expect(service.updateTrackerItem('note-1', { nextAction: '  ' })).rejects.toThrow(/nextAction/);
    expect(writes()).toHaveLength(0);
    expect(stored(state).nextAction).toBe('Ask PCP.');
    await service.updateTrackerItem('note-1', { nextAction: 'Ask PCP again.' });
    expect(stored(state).nextAction).toBe('Ask PCP again.');
  });

  it('changing the kind needs what the new kind needs', async () => {
    installRow({ ...NOTE });
    await expect(service.updateTrackerItem('note-1', { noteKind: 'pending' })).rejects.toThrow(/nextAction/);
    await expect(service.updateTrackerItem('note-1', { noteKind: 'handoff', nextAction: 'n' })).rejects.toThrow(/result/);
    expect(writes()).toHaveLength(0);
  });

  it('the front is the host\'s: not set, changed or cleared from the UI funnel', async () => {
    const state = installRow({ ...NOTE });
    await expect(service.updateTrackerItem('note-1', { front: 'team-front_9' })).rejects.toThrow(/front records where the note came from/);
    await expect(service.updateTrackerItem('note-1', { front: null })).rejects.toThrow(/front records/);
    expect(writes()).toHaveLength(0);
    expect(stored(state).front).toBe('team-front_1');
    // Writing the id it already has is no change.
    await service.updateTrackerItem('note-1', { front: 'team-front_1', title: 'Same front' });
    expect(stored(state).title).toBe('Same front');
  });

  it('the rich body of a handoff may reach 2,500 characters; every other kind is held to 600', async () => {
    const handoff = installRow({ ...NOTE, noteKind: 'handoff', nextAction: 'n', result: 'completed' });
    await service.updateTrackerItemContent('note-1', 'h'.repeat(2500));
    expect(handoff.row.content).toBe(JSON.stringify('h'.repeat(2500)));
    await expect(service.updateTrackerItemContent('note-1', 'h'.repeat(2501))).rejects.toThrow(/limit is 2500/);
    installRow({ ...NOTE, noteKind: 'decision' });
    await expect(service.updateTrackerItemContent('note-1', 'h'.repeat(2000))).rejects.toThrow(/limit is 600/);
  });
});

describe('review follow-up (F1 S2b): the UI funnel', () => {
  const LEAVE_HANDOFF = { noteKind: 'decision', result: '', commits: [], pendings: [], relatedNotes: [] };
  const handoff = { ...NOTE, noteKind: 'handoff', nextAction: 'Run C0.', result: 'partial', commits: [], pendings: [], relatedNotes: [] };

  it('a handoff that leaves its kind has its stored rich body judged against the 600 of the new kind', async () => {
    const state = installRow(handoff, JSON.stringify('x'.repeat(2400)));
    await expect(service.updateTrackerItem('note-1', LEAVE_HANDOFF)).rejects.toThrow(/limit is 600/);
    expect(writes()).toHaveLength(0);
    expect(stored(state).noteKind).toBe('handoff');
  });

  it('the same change with a short body passes, and so does an unrelated edit of the long handoff', async () => {
    const short = installRow(handoff, JSON.stringify('A short body.'));
    await service.updateTrackerItem('note-1', LEAVE_HANDOFF);
    expect(stored(short)).toMatchObject({ noteKind: 'decision' });
    const long = installRow(handoff, JSON.stringify('x'.repeat(2400)));
    await service.updateTrackerItem('note-1', { status: 'resolved' });
    expect(stored(long)).toMatchObject({ noteKind: 'handoff', status: 'resolved' });
  });

  it('a front that is not shaped like a relationship is refused and nothing is persisted, even on a note that had none', async () => {
    const { front: _front, ...noFront } = NOTE;
    for (const value of [{}, 42, true, [42], { title: 'x' }]) {
      const state = installRow(noFront);
      mockQuery.mockClear();
      await expect(service.updateTrackerItem('note-1', { front: value }), JSON.stringify(value)).rejects.toThrow(/front must be empty or a relationship/);
      expect(writes(), JSON.stringify(value)).toHaveLength(0);
      expect(stored(state).front, JSON.stringify(value)).toBeUndefined();
    }
  });

  it('pendings and relatedNotes of a handoff are held to the same shape', async () => {
    for (const field of ['pendings', 'relatedNotes']) {
      const state = installRow(handoff);
      mockQuery.mockClear();
      await expect(service.updateTrackerItem('note-1', { [field]: 42 }), field).rejects.toThrow(new RegExp(`${field} must be empty or a relationship`));
      expect(writes(), field).toHaveLength(0);
      expect(stored(state)[field]).toEqual([]);
    }
  });
});
