// @vitest-environment node
/**
 * An approved commit marks the session complete only when it really closed a
 * tracker item. A commit that says "Closes <team-front>" keeps the front open
 * (its status is the user's), so it must not complete the session either.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { linkBySession, applySessionMetadata } = vi.hoisted(() => ({
  linkBySession: vi.fn(),
  applySessionMetadata: vi.fn(async () => undefined),
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', isPackaged: false, getName: () => 'Nimbalyst', on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { on: vi.fn(), handle: vi.fn(), once: vi.fn(), removeListener: vi.fn(), removeHandler: vi.fn() },
}));
vi.mock('../../../services/CommitTrackerLinker', () => ({ commitTrackerLinker: { linkBySession } }));
vi.mock('../../../services/SessionNamingService', () => ({
  SessionNamingService: { getInstance: () => ({ applySessionMetadata }) },
}));

import { linkCommitToTrackerItems } from '../interactiveToolHandlers';

beforeEach(() => {
  linkBySession.mockReset();
  applySessionMetadata.mockClear();
});

describe('linkCommitToTrackerItems', () => {
  it('marks the session complete when the commit closed an item', async () => {
    linkBySession.mockResolvedValue({ closedItemIds: ['task-1'] });
    await linkCommitToTrackerItems('abcdef0', 'Closes NIM-1', 'session-1', '/ws');
    expect(applySessionMetadata).toHaveBeenCalledWith('session-1', { phase: 'complete' });
  });

  it('writes no session metadata when the commit closed nothing (a team-front kept open, an item already closed)', async () => {
    linkBySession.mockResolvedValue({ closedItemIds: [] });
    await linkCommitToTrackerItems('abcdef0', 'Closes NIM-2', 'session-1', '/ws');
    expect(linkBySession).toHaveBeenCalledTimes(1);
    expect(applySessionMetadata).not.toHaveBeenCalled();
  });
});
