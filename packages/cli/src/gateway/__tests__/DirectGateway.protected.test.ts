// @vitest-environment node
/**
 * NIB.26: the offline gateway applies the same protected-type rule as every
 * write funnel of the app (tracker-core `protectedTrackerTypes`). A Tool
 * Manifest is written only by the host from an architect session; a Team Note
 * carries host-filled provenance and a capped body. Neither can be forged or
 * rewritten from the terminal, while ordinary types keep working offline.
 *
 * Covered elsewhere: the host-owned creation path (electron
 * createNativeTrackerItem.hostOwned.test.ts), the coordinator accepting a
 * manifest through the agent tool (toolManifestToolGuard.test.ts), and the
 * agent-tool / IPC behavior (teamNoteToolGuard, trackerToolHandlers).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../../db/openDatabase.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DirectGateway } from '../DirectGateway.js';
import { normalizeRelationshipValue } from '@nimbalyst/tracker-core';

const WORKSPACE = '/tmp/fixture-protected-workspace';

// Mirror of the relevant part of 0001_initial.sql (tracker_items + body cache).
const SCHEMA = `
CREATE TABLE _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT);
CREATE TABLE tracker_items (
  id TEXT PRIMARY KEY,
  issue_number INTEGER,
  issue_key TEXT,
  local_key TEXT,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  workspace TEXT NOT NULL,
  document_path TEXT,
  line_number INTEGER,
  content TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  source TEXT DEFAULT 'inline',
  source_ref TEXT,
  type_tags TEXT NOT NULL DEFAULT '[]',
  sync_status TEXT DEFAULT 'local',
  sync_id INTEGER,
  body_version INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  last_indexed TEXT NOT NULL DEFAULT '',
  title TEXT GENERATED ALWAYS AS (json_extract(data, '$.title')) STORED,
  status TEXT GENERATED ALWAYS AS (json_extract(data, '$.status')) STORED,
  kanban_sort_order TEXT GENERATED ALWAYS AS (json_extract(data, '$.kanbanSortOrder')) STORED
);
CREATE TABLE tracker_body_cache (
  item_id TEXT NOT NULL, body_version INTEGER NOT NULL, content TEXT NOT NULL,
  cached_at TEXT, PRIMARY KEY (item_id, body_version)
);
CREATE TABLE tracker_type_defs (
  id TEXT PRIMARY KEY, workspace TEXT NOT NULL, type TEXT NOT NULL, model TEXT NOT NULL,
  source TEXT, updated TEXT NOT NULL, deleted_at TEXT, sync_id INTEGER, sync_status TEXT DEFAULT 'local'
);
`;

let dir: string;
let dbPath: string;

/** Insert a seed row directly (bypassing the gateway), as the app would have stored it. */
function seed(row: { id: string; type: string; data: Record<string, unknown>; content?: string; typeTags?: string[] }): void {
  const db = openDatabase(dbPath);
  const iso = new Date().toISOString();
  db.prepare(
    `INSERT INTO tracker_items (id, type, data, workspace, document_path, type_tags, sync_status, body_version, content, created, updated)
     VALUES (@id, @type, @data, @workspace, '', @typeTags, 'local', @bodyVersion, @content, @created, @updated)`,
  ).run({
    id: row.id,
    type: row.type,
    data: JSON.stringify(row.data),
    workspace: WORKSPACE,
    typeTags: JSON.stringify(row.typeTags ?? [row.type]),
    bodyVersion: row.content ? 1 : 0,
    content: row.content ? JSON.stringify(row.content) : null,
    created: iso,
    updated: iso,
  });
  db.close();
}

function rawRow(id: string): any {
  const db = openDatabase(dbPath, { readonly: true });
  const row = db.prepare('SELECT * FROM tracker_items WHERE id = ?').get(id) as any;
  db.close();
  return { ...row, data: JSON.parse(row.data) };
}

/** A manifest as the host stores it (Phase 1B). */
const MANIFEST_DATA = {
  title: 'M-1: Make formatGreeting reject blank names',
  status: 'draft',
  priority: 'medium',
  description: '```yaml\ntoolManifest: 1\nid: M-1\n```\nPreparation: complete',
  manifestId: 'M-1',
  manifestVersion: '1',
  teamRootSessionId: 'root-1',
  architectSessionId: 'arch-1',
  generatedByRole: 'architect',
  model: 'claude-code:opus',
  confidence: 'high',
  contentHash: '0123456789abcdef',
  createdByAgent: true,
};
/** A note as the app's agent tool stores it (provenance from the coordinator session). */
const NOTE_DATA = {
  title: 'Port the rules gradually',
  status: 'active',
  priority: 'medium',
  noteKind: 'decision',
  description: 'Decided with the user.',
  sourceSession: 'root-1',
  teamRootSession: 'root-1',
  agentRole: 'coordinator',
  createdByAgent: true,
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-cli-protected-'));
  dbPath = path.join(dir, 'nimbalyst.sqlite');
  const db = openDatabase(dbPath);
  db.exec(SCHEMA);
  db.prepare('INSERT INTO _migrations (version, name, applied_at) VALUES (?,?,?)').run(11, 'fixture', 'now');
  db.close();
  seed({ id: 'tool-manifest_1', type: 'tool-manifest', data: MANIFEST_DATA, content: MANIFEST_DATA.description });
  seed({ id: 'team-note_1', type: 'team-note', data: NOTE_DATA, content: NOTE_DATA.description });
  seed({ id: 'task_1', type: 'task', data: { title: 'Ordinary task', status: 'to-do', priority: 'low' } });
});

afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const gateway = () => new DirectGateway(dbPath);

describe('tool-manifest offline (NIB.26)', () => {
  it('is never created from the terminal, not even as a type tag', async () => {
    await expect(gateway().createTracker(WORKSPACE, {
      type: 'tool-manifest', title: 'M-9: forged', description: 'toolManifest: 1',
      fields: { manifestId: 'M-9', teamRootSessionId: 'root-1', architectSessionId: 'arch-1', generatedByRole: 'architect' },
    })).rejects.toThrow(/written by Nimbalyst when an architect session completes/);
    await expect(gateway().createTracker(WORKSPACE, { type: 'task', title: 'x', typeTags: ['tool-manifest'] })).rejects.toThrow(/can only be the primary type of an item, not a type tag/);
    const db = openDatabase(dbPath, { readonly: true });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM tracker_items WHERE type = 'tool-manifest'`).get()).toEqual({ n: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM tracker_items`).get()).toEqual({ n: 3 });
    db.close();
  });

  it('its provenance cannot be forged and its body, title, version link and type cannot change', async () => {
    const before = rawRow('tool-manifest_1');
    const attempts: Array<[Record<string, unknown>, RegExp]> = [
      [{ fields: { architectSessionId: 'me' } }, /architectSessionId is set by Nimbalyst/],
      [{ fields: { teamRootSessionId: 'other-root' } }, /teamRootSessionId is set by Nimbalyst/],
      [{ fields: { generatedByRole: 'coordinator' } }, /generatedByRole is set by Nimbalyst/],
      [{ fields: { manifestId: 'M-9' } }, /manifestId is set by Nimbalyst/],
      [{ fields: { manifestVersion: '2' } }, /manifestVersion is set by Nimbalyst/],
      [{ fields: { contentHash: 'ffff' } }, /contentHash is set by Nimbalyst/],
      [{ fields: { supersedes: ['tool-manifest_0'] } }, /supersedes is set by Nimbalyst/],
      [{ description: 'rewritten manifest' }, /never edited/],
      [{ title: 'renamed' }, /title is set by Nimbalyst/],
      [{ primaryType: 'task' }, /cannot change type/],
      [{ unsetFields: ['architectSessionId'] }, /architectSessionId is set by Nimbalyst/],
    ];
    for (const [input, message] of attempts) {
      await expect(gateway().updateTracker(WORKSPACE, 'tool-manifest_1', input), JSON.stringify(input)).rejects.toThrow(message);
    }
    const after = rawRow('tool-manifest_1');
    expect(after.data).toEqual(before.data);
    expect(after.content).toBe(before.content);
    expect(after.type).toBe('tool-manifest');
    expect(after.updated).toBe(before.updated);
  });

  it('is never accepted, superseded or otherwise moved from the terminal: that decision belongs to a session inside the app', async () => {
    for (const input of [{ status: 'accepted' }, { status: 'superseded' }, { status: 'draft' }, { fields: { status: 'accepted' } }]) {
      await expect(gateway().updateTracker(WORKSPACE, 'tool-manifest_1', input), JSON.stringify(input)).rejects.toThrow(/accepted in the app .* offline writes carry no session identity/);
    }
    expect(rawRow('tool-manifest_1').data.status).toBe('draft');
  });

  it('a synced item keeps its provenance in the nested customFields bag: a top-level write that disagrees is refused too', async () => {
    seed({
      id: 'tool-manifest_2', type: 'tool-manifest',
      data: { title: 'M-2: synced', status: 'draft', priority: 'medium', description: 'toolManifest: 1', createdByAgent: true,
        customFields: { manifestId: 'M-2', manifestVersion: '1', teamRootSessionId: 'root-1', architectSessionId: 'arch-1', generatedByRole: 'architect', contentHash: 'abcd' } },
    });
    await expect(gateway().updateTracker(WORKSPACE, 'tool-manifest_2', { fields: { architectSessionId: 'me' } })).rejects.toThrow(/architectSessionId is set by Nimbalyst/);
    await expect(gateway().updateTracker(WORKSPACE, 'tool-manifest_2', { fields: { manifestId: 'M-9' } })).rejects.toThrow(/manifestId is set by Nimbalyst/);
    expect(rawRow('tool-manifest_2').data.architectSessionId).toBeUndefined();
    seed({
      id: 'team-note_2', type: 'team-note',
      data: { title: 'Synced note', status: 'active', priority: 'medium', description: 'short', createdByAgent: true,
        customFields: { noteKind: 'decision', sourceSession: 'root-1', teamRootSession: 'root-1', agentRole: 'coordinator' } },
    });
    await expect(gateway().updateTracker(WORKSPACE, 'team-note_2', { fields: { sourceSession: 'other' } })).rejects.toThrow(/sourceSession records where the note came from/);
    await gateway().updateTracker(WORKSPACE, 'team-note_2', { status: 'resolved' });
    expect(rawRow('team-note_2').data.status).toBe('resolved');
  });

  it('still takes a comment and an archive flag: neither touches what is protected', async () => {
    await gateway().commentTracker(WORKSPACE, 'tool-manifest_1', 'Read it; looks right.');
    expect(rawRow('tool-manifest_1').data.comments).toHaveLength(1);
    await gateway().setArchived(WORKSPACE, 'tool-manifest_1', true);
    expect(rawRow('tool-manifest_1').archived).toBe(1);
    expect(rawRow('tool-manifest_1').data.architectSessionId).toBe('arch-1');
  });
});

describe('team-note offline (NIB.26)', () => {
  it('keeps its policy: a kind is required, provenance is never hand-set, the body is capped, the status is one of its three', async () => {
    await expect(gateway().createTracker(WORKSPACE, { type: 'team-note', title: 'No kind' })).rejects.toThrow(/needs noteKind/);
    await expect(gateway().createTracker(WORKSPACE, { type: 'team-note', title: 'Forged', fields: { noteKind: 'risk', sourceSession: 'root-1', agentRole: 'coordinator' } })).rejects.toThrow(/sourceSession is set by Nimbalyst from the agent session/);
    await expect(gateway().createTracker(WORKSPACE, { type: 'team-note', title: 'Long', fields: { noteKind: 'risk' }, description: 'x'.repeat(601) })).rejects.toThrow(/limit is 600/);
    await expect(gateway().createTracker(WORKSPACE, { type: 'team-note', title: 'Status', status: 'done', fields: { noteKind: 'risk' } })).rejects.toThrow(/status must be one of: active, resolved, obsolete/);
    await expect(gateway().createTracker(WORKSPACE, { type: 'task', title: 'x', typeTags: ['team-note'] })).rejects.toThrow(/not a type tag/);

    const created = await gateway().createTracker(WORKSPACE, { type: 'team-note', title: 'Manual note', description: 'Written from the terminal.', fields: { noteKind: 'context' } });
    const row = rawRow(created.id);
    expect(row.data).toMatchObject({ title: 'Manual note', noteKind: 'context', status: 'active', createdByAgent: false });
    for (const field of ['sourceSession', 'teamRootSession', 'agentRole', 'branch', 'worktree']) expect(row.data[field], field).toBeUndefined();
  });

  it('an existing note resolves, but its provenance, kind validity, body cap and type hold', async () => {
    await gateway().updateTracker(WORKSPACE, 'team-note_1', { status: 'resolved' });
    expect(rawRow('team-note_1').data.status).toBe('resolved');
    await expect(gateway().updateTracker(WORKSPACE, 'team-note_1', { fields: { sourceSession: 'other' } })).rejects.toThrow(/sourceSession records where the note came from and cannot be changed/);
    await expect(gateway().updateTracker(WORKSPACE, 'team-note_1', { unsetFields: ['teamRootSession'] })).rejects.toThrow(/teamRootSession records where the note came from/);
    await expect(gateway().updateTracker(WORKSPACE, 'team-note_1', { fields: { noteKind: 'wish' } })).rejects.toThrow(/needs noteKind, one of/);
    await expect(gateway().updateTracker(WORKSPACE, 'team-note_1', { description: 'y'.repeat(601) })).rejects.toThrow(/limit is 600/);
    await expect(gateway().updateTracker(WORKSPACE, 'team-note_1', { status: 'done' })).rejects.toThrow(/status must be one of: active, resolved, obsolete/);
    await expect(gateway().updateTracker(WORKSPACE, 'team-note_1', { primaryType: 'task' })).rejects.toThrow(/cannot change type/);
    await expect(gateway().updateTracker(WORKSPACE, 'task_1', { typeTags: ['task', 'team-note'] })).rejects.toThrow(/cannot be turned into a team-note/);
    expect(rawRow('team-note_1').data).toMatchObject({ sourceSession: 'root-1', teamRootSession: 'root-1', agentRole: 'coordinator', noteKind: 'decision', status: 'resolved' });
  });
});

describe('ordinary types offline (NIB.26)', () => {
  it('create, update, comment and archive work exactly as before', async () => {
    const created = await gateway().createTracker(WORKSPACE, { type: 'bug', title: 'Login times out', priority: 'high', fields: { severity: 'critical' } });
    expect(rawRow(created.id).data).toMatchObject({ title: 'Login times out', status: 'to-do', priority: 'high', severity: 'critical', createdByAgent: true });
    await gateway().updateTracker(WORKSPACE, 'task_1', { status: 'in-progress', title: 'Renamed task', fields: { owner: 'me' }, description: 'Body text' });
    expect(rawRow('task_1').data).toMatchObject({ status: 'in-progress', title: 'Renamed task', owner: 'me', description: 'Body text' });
    await gateway().commentTracker(WORKSPACE, 'task_1', 'Repro confirmed');
    expect(rawRow('task_1').data.comments).toHaveLength(1);
    await gateway().setArchived(WORKSPACE, 'task_1', true);
    expect(rawRow('task_1').archived).toBe(1);
    await gateway().updateTracker(WORKSPACE, 'task_1', { primaryType: 'bug' });
    expect(rawRow('task_1').type).toBe('bug');
  });
});

describe('tool-manifest supersedes offline (NIB.29)', () => {
  /** The team's second manifest as the host stores it: the link as a target id. */
  const SUPERSEDING = { ...MANIFEST_DATA, title: 'M-2: Make formatGreeting reject blank names', manifestId: 'M-2', supersedes: ['tool-manifest_1'] };
  const targets = (id: string) => normalizeRelationshipValue(rawRow(id).data.customFields?.supersedes ?? rawRow(id).data.supersedes).map((entry) => entry.itemId);
  beforeEach(() => {
    seed({ id: 'tool-manifest_2', type: 'tool-manifest', data: SUPERSEDING, content: SUPERSEDING.description });
  });

  it('another target, one more, or none at all is refused in either shape', async () => {
    const before = rawRow('tool-manifest_2');
    const attempts: Array<Record<string, unknown>> = [
      { fields: { supersedes: ['tool-manifest_0'] } },
      { fields: { supersedes: [{ itemId: 'tool-manifest_0' }] } },
      { fields: { supersedes: ['tool-manifest_1', 'tool-manifest_0'] } },
      { fields: { supersedes: [] } },
      { unsetFields: ['supersedes'] },
    ];
    for (const input of attempts) {
      await expect(gateway().updateTracker(WORKSPACE, 'tool-manifest_2', input), JSON.stringify(input)).rejects.toThrow(/supersedes is set by Nimbalyst/);
    }
    expect(rawRow('tool-manifest_2').data).toEqual(before.data);
    expect(targets('tool-manifest_2')).toEqual(['tool-manifest_1']);
  });

  it('entries that name no target never pass as "no link": refused on a manifest without one, and next to a real target', async () => {
    for (const garbage of [[{ title: 'x' }], [{}], [{ itemId: '' }], ['']]) {
      await expect(gateway().updateTracker(WORKSPACE, 'tool-manifest_1', { fields: { supersedes: garbage } }), JSON.stringify(garbage)).rejects.toThrow(/supersedes is set by Nimbalyst/);
      await expect(gateway().updateTracker(WORKSPACE, 'tool-manifest_2', { fields: { supersedes: [{ itemId: 'tool-manifest_1' }, ...garbage] } }), JSON.stringify(garbage)).rejects.toThrow(/supersedes is set by Nimbalyst/);
    }
    expect(rawRow('tool-manifest_1').data.supersedes).toBeUndefined();
    expect(targets('tool-manifest_2')).toEqual(['tool-manifest_1']);
  });

  it('the same link written in the canonical object shape is no change: the targets stay what the host recorded', async () => {
    await gateway().updateTracker(WORKSPACE, 'tool-manifest_2', { fields: { supersedes: [{ itemId: 'tool-manifest_1' }] } });
    expect(targets('tool-manifest_2')).toEqual(['tool-manifest_1']);
    expect(rawRow('tool-manifest_2').data.status).toBe('draft');
  });

  it('its status still never changes from the terminal, link or no link', async () => {
    for (const input of [{ status: 'accepted' }, { fields: { status: 'accepted' } }, { status: 'superseded' }]) {
      await expect(gateway().updateTracker(WORKSPACE, 'tool-manifest_2', input), JSON.stringify(input)).rejects.toThrow(/offline writes carry no session identity/);
    }
    expect(rawRow('tool-manifest_2').data.status).toBe('draft');
  });
});
