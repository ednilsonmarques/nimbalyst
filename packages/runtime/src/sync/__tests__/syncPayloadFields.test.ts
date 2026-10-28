// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { buildSyncPayload } from '../SyncedSessionStore';
import { SYNC_RELEVANT_FIELDS } from '../syncableMetadata';

/**
 * Regression lock for the REAL-TIME create/update push path.
 *
 * `buildSyncPayload` projects a create()/updateMetadata() payload down to the
 * `metadata_updated` change that is pushed via `pushChange`. Only fields listed
 * in `SYNC_RELEVANT_FIELDS.columns` survive the projection, so this is the exact
 * point where the meta-agent grouping fields used to be dropped: a freshly
 * created meta agent / spawned child reached the server + phone WITHOUT
 * `agentRole` / `createdBySessionId` (until a later full bulk resync rebuilt the
 * index via `buildSyncedSessionIndexFields`).
 *
 * For a not-yet-cached session the pushed metadata lands in the `newEntry`
 * branch of `CollabV3Sync`, which copies these fields straight onto the wire
 * `SessionIndexEntry`. If they are missing from the payload here, that branch
 * has nothing to forward -- hence this lock sits on the payload builder.
 *
 * null -> undefined normalization of `createdBySessionId` happens downstream in
 * `CollabV3Sync` (newEntry / cached-merge branches), mirroring
 * `buildSyncedSessionIndexFields`; it is locked by sessionIndexEntryFields.test.ts.
 */
describe('SYNC_RELEVANT_FIELDS.columns', () => {
  it('includes the meta-agent grouping fields so the push payload carries them', () => {
    expect(SYNC_RELEVANT_FIELDS.columns).toContain('agentRole');
    expect(SYNC_RELEVANT_FIELDS.columns).toContain('createdBySessionId');
  });

  it('does not treat grouping fields as sort-relevant (no list re-sort on group change)', () => {
    expect(SYNC_RELEVANT_FIELDS.sortRelevantColumns).not.toContain('agentRole');
    expect(SYNC_RELEVANT_FIELDS.sortRelevantColumns).not.toContain('createdBySessionId');
  });
});

describe('buildSyncPayload (create/metadata_updated push payload)', () => {
  it('promotes persisted host attribution onto the real-time sync payload', () => {
    expect(buildSyncPayload({ metadata: { hostDeviceId: 'desktop-1' } })).toEqual({
      hostDeviceId: 'desktop-1',
    });
  });

  it('carries agentRole for a freshly created meta-agent session', () => {
    const metadata = buildSyncPayload(
      { id: 'meta-1', title: 'Meta agent', provider: 'claude-code', agentRole: 'meta-agent' },
      { forceUpdatedAt: true },
    );
    expect(metadata.agentRole).toBe('meta-agent');
  });

  it('carries both grouping fields for a spawned child session', () => {
    const metadata = buildSyncPayload(
      {
        id: 'child-1',
        title: 'Child session',
        provider: 'claude-code',
        agentRole: 'standard',
        createdBySessionId: 'meta-session-123',
      },
      { forceUpdatedAt: true },
    );
    expect(metadata.agentRole).toBe('standard');
    expect(metadata.createdBySessionId).toBe('meta-session-123');
  });

  it('does not fabricate grouping fields for a plain session', () => {
    const metadata = buildSyncPayload(
      { id: 'plain-1', title: 'Plain session', provider: 'claude-code' },
      { forceUpdatedAt: true },
    );
    expect('agentRole' in metadata).toBe(false);
    expect('createdBySessionId' in metadata).toBe(false);
  });

  it('forwards a grouping-only update (e.g. agentRole promotion) without forcing a re-sort', () => {
    const metadata = buildSyncPayload({ agentRole: 'meta-agent' });
    expect(metadata.agentRole).toBe('meta-agent');
    // No sort-relevant column changed, so updatedAt must not be stamped.
    expect('updatedAt' in metadata).toBe(false);
  });
});

// F1 S3: the team root's lifecycle keys are local to the machine that runs the
// mission. The push path projects a whitelist, so a key that is not named here
// never reaches another device; adding one is a decision this closed list makes
// visible (the index/bulk path is pinned in PGLiteSessionStore.test.ts).
describe('the team lifecycle root keys never ride the real-time push', () => {
  const LIFECYCLE_KEYS = ['teamFront', 'teamGoal', 'teamMissionStatus', 'teamMissionContext', 'teamDoneCriterion', 'teamMissionVersion'];

  it('SYNC_RELEVANT_FIELDS.metadataKeys is exactly phase, tags and hostDeviceId', () => {
    expect([...SYNC_RELEVANT_FIELDS.metadataKeys]).toEqual(['phase', 'tags', 'hostDeviceId']);
    for (const key of LIFECYCLE_KEYS) {
      expect(SYNC_RELEVANT_FIELDS.metadataKeys as readonly string[], key).not.toContain(key);
      expect(SYNC_RELEVANT_FIELDS.columns as readonly string[], key).not.toContain(key);
    }
  });

  it('a create or update payload for a team root pushes none of them', () => {
    const metadata = {
      teamMode: true,
      teamFront: 'team-front_1',
      teamGoal: 'Ship F1',
      teamMissionStatus: 'active',
      teamMissionContext: 'Bootstrap block',
      teamDoneCriterion: 'S3 green',
      teamMissionVersion: 1,
      phase: 'implementing',
      tags: ['sync'],
    };
    for (const payload of [
      { id: 'root', title: 'Root', provider: 'claude-code', metadata },
      { metadata },
    ]) {
      const pushed = buildSyncPayload(payload as never, { forceUpdatedAt: true });
      expect(pushed.phase).toBe('implementing');
      for (const key of [...LIFECYCLE_KEYS, 'teamMode']) expect(key in pushed, key).toBe(false);
    }
  });
});
