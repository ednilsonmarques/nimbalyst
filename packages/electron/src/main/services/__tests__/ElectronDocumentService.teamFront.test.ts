// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// F1 S1: the desktop Tracker UI and its IPC edit a team-front through
// ElectronDocumentService.updateTrackerItem / updateTrackerItemContent. The user
// edits title, status and description; the host's currentMission, the three
// statuses, the caps and the type are held by the same protected-type rule every
// other funnel applies.
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

const FRONT = {
  title: 'Team Mode',
  status: 'active',
  description: 'Estado inicial. Autoridade: ESTADO.md.',
  currentMission: 'root-1',
  activity: [],
};

function frontRow(data: Record<string, unknown>, type = 'team-front', content: unknown = null) {
  return {
    content,
    id: 'front-1',
    type,
    source: 'native',
    source_ref: null,
    document_path: null,
    workspace: tempDir,
    data: JSON.stringify(data),
    sync_status: 'local',
    last_indexed: new Date().toISOString(),
    body_version: 0,
    archived: false,
  };
}

function installRow(data: Record<string, unknown>, type = 'team-front', content: unknown = null) {
  const state = { row: frontRow(data, type, content) as Record<string, unknown> };
  mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (normalized.startsWith('SELECT')) return { rows: [state.row] };
    if (normalized.startsWith('UPDATE tracker_items SET data = $1')) {
      state.row = { ...state.row, data: params?.[0] as string };
      return { rows: [state.row] };
    }
    if (normalized.startsWith('UPDATE tracker_items SET type_tags')) return { rows: [] };
    throw new Error(`Unexpected query in test: ${normalized}`);
  });
  return state;
}

const writes = () => mockQuery.mock.calls.filter((c) => String(c[0]).replace(/\s+/g, ' ').trim().startsWith('UPDATE'));
const stored = (state: { row: Record<string, unknown> }) => JSON.parse(state.row.data as string);

beforeEach(async () => {
  vi.clearAllMocks();
  mockQuery.mockReset();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-front-service-test-'));
  service = new ElectronDocumentService(tempDir);
});

afterEach(async () => {
  service.destroy();
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('the Tracker UI edits a team-front', () => {
  it('the user changes the title, the status (all three) and the description', async () => {
    const state = installRow(FRONT);
    await service.updateTrackerItem('front-1', { title: 'Team Mode v2' });
    await service.updateTrackerItem('front-1', { status: 'paused' });
    await service.updateTrackerItem('front-1', { status: 'closed' });
    await service.updateTrackerItem('front-1', { description: 'Estado novo.' });
    expect(stored(state)).toMatchObject({ title: 'Team Mode v2', status: 'closed', description: 'Estado novo.', currentMission: 'root-1' });
    expect(writes()).toHaveLength(4);
  });

  it('nobody sets or clears the host-owned currentMission through the UI funnel', async () => {
    const state = installRow(FRONT);
    await expect(service.updateTrackerItem('front-1', { currentMission: 'root-9' })).rejects.toThrow(/currentMission is set by Nimbalyst/);
    await expect(service.updateTrackerItem('front-1', { currentMission: '' })).rejects.toThrow(/currentMission is set by Nimbalyst/);
    expect(writes()).toHaveLength(0);
    expect(stored(state).currentMission).toBe('root-1');
  });

  it('refuses a status outside the three, an empty title, a description over the cap and a change of type', async () => {
    const state = installRow(FRONT);
    await expect(service.updateTrackerItem('front-1', { status: 'done' })).rejects.toThrow(/status must be one of: active, paused, closed/);
    await expect(service.updateTrackerItem('front-1', { title: '' })).rejects.toThrow(/needs a title/);
    await expect(service.updateTrackerItem('front-1', { description: 'x'.repeat(2001) })).rejects.toThrow(/limit is 2000/);
    await expect(service.updateTrackerItem('front-1', { type: 'task' })).rejects.toThrow(/cannot change type/);
    expect(writes()).toHaveLength(0);
    expect(stored(state)).toMatchObject({ title: 'Team Mode', status: 'active' });
  });

  it('a rich body of the front is capped at 2,000 characters', async () => {
    installRow(FRONT);
    await expect(service.updateTrackerItemContent('front-1', 'x'.repeat(2001))).rejects.toThrow(/limit is 2000/);
    expect(writes()).toHaveLength(0);
  });

  describe('the state is a description or a body', () => {
    const refused = /A team-front needs its state: write a description or a body\./;

    it('clearing the description is refused when the stored body is empty', async () => {
      const state = installRow(FRONT);
      await expect(service.updateTrackerItem('front-1', { description: '' })).rejects.toThrow(refused);
      await expect(service.updateTrackerItem('front-1', { description: '   ' })).rejects.toThrow(refused);
      expect(writes()).toHaveLength(0);
      expect(stored(state).description).toBe(FRONT.description);
    });

    it('clearing the description is fine when the stored body holds the state, as text, JSON-quoted or rich', async () => {
      for (const content of [JSON.stringify('Estado no corpo.'), 'Estado no corpo.', { root: { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', text: 'Estado.' }] }] } }]) {
        const state = installRow(FRONT, 'team-front', content);
        await service.updateTrackerItem('front-1', { description: '' });
        expect(stored(state).description).toBe('');
      }
    });

    it('a body that is only whitespace is no state', async () => {
      installRow(FRONT, 'team-front', JSON.stringify('   '));
      await expect(service.updateTrackerItem('front-1', { description: '' })).rejects.toThrow(refused);
    });

    it('emptying the body is refused when the description is empty, and fine when it is not', async () => {
      installRow({ ...FRONT, description: '' }, 'team-front', JSON.stringify('Estado no corpo.'));
      await expect(service.updateTrackerItemContent('front-1', '   ')).rejects.toThrow(refused);
      expect(writes()).toHaveLength(0);
      mockQuery.mockReset();
      installRow(FRONT, 'team-front', JSON.stringify('Estado no corpo.'));
      mockQuery.mockImplementation(async (sql: string) => {
        const normalized = sql.replace(/\s+/g, ' ').trim();
        if (normalized.startsWith('SELECT')) return { rows: [frontRow(FRONT, 'team-front', JSON.stringify('Estado no corpo.'))] };
        return { rows: [{ ...frontRow(FRONT), body_version: 1 }] };
      });
      await expect(service.updateTrackerItemContent('front-1', '   ')).resolves.toBeUndefined();
    });

    it('an edit that does not touch the description does not hold up a front that already lacks a state', async () => {
      const state = installRow({ ...FRONT, description: '' });
      await service.updateTrackerItem('front-1', { status: 'paused' });
      expect(stored(state).status).toBe('paused');
      await service.updateTrackerItem('front-1', { title: 'Renamed' });
      expect(stored(state)).toMatchObject({ status: 'paused', title: 'Renamed' });
    });

    it('a front whose state is only its body takes a title edit (the UI funnel keeps the body)', async () => {
      const state = installRow({ ...FRONT, description: '' }, 'team-front', JSON.stringify('Estado da frente'));
      await service.updateTrackerItem('front-1', { title: 'Renamed', status: 'paused' });
      expect(stored(state)).toMatchObject({ title: 'Renamed', status: 'paused', description: '' });
    });
  });

  it('a task cannot be turned into a team-front through the UI funnel', async () => {
    installRow({ title: 'A task', status: 'to-do', activity: [] }, 'task');
    await expect(service.updateTrackerItem('front-1', { type: 'team-front' })).rejects.toThrow(/cannot be turned into a team-front/);
    await expect(service.updateTrackerItem('front-1', { typeTags: ['task', 'team-front'] })).rejects.toThrow(/cannot be turned into a team-front/);
    expect(writes()).toHaveLength(0);
  });
});
