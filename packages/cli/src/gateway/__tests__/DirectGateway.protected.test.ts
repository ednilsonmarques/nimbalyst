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

describe('team-note offline (F1 S2): nextAction, handoff, front', () => {
  beforeEach(() => {
    // From before nextAction existed: a pending note without one, with a front stored as a plain id.
    seed({ id: 'team-note_legacy', type: 'team-note', data: { ...NOTE_DATA, noteKind: 'pending', front: 'team-front_1' }, content: NOTE_DATA.description });
    seed({ id: 'team-note_handoff', type: 'team-note', data: { ...NOTE_DATA, noteKind: 'handoff', nextAction: 'Run C0.', result: 'partial', front: 'team-front_1' }, content: NOTE_DATA.description });
  });

  it('a pending note needs a next action; with one it is stored', async () => {
    await expect(gateway().createTracker(WORKSPACE, { type: 'team-note', title: 'No step', fields: { noteKind: 'pending' } })).rejects.toThrow(/nextAction/);
    await expect(gateway().createTracker(WORKSPACE, { type: 'team-note', title: 'No step', fields: { noteKind: 'pending', nextAction: '   ' } })).rejects.toThrow(/nextAction/);
    const created = await gateway().createTracker(WORKSPACE, { type: 'team-note', title: 'With step', description: 'Short.', fields: { noteKind: 'pending', nextAction: 'Ask PCP.' } });
    expect(rawRow(created.id).data).toMatchObject({ noteKind: 'pending', nextAction: 'Ask PCP.', createdByAgent: false });
  });

  it('a handoff needs its result and next action and takes a body up to 2,500 characters (its description is the body offline)', async () => {
    await expect(gateway().createTracker(WORKSPACE, { type: 'team-note', title: 'H', fields: { noteKind: 'handoff', nextAction: 'n' } })).rejects.toThrow(/result/);
    await expect(gateway().createTracker(WORKSPACE, { type: 'team-note', title: 'H', fields: { noteKind: 'handoff', result: 'completed' } })).rejects.toThrow(/nextAction/);
    await expect(gateway().createTracker(WORKSPACE, { type: 'team-note', title: 'H', description: 'h'.repeat(2501), fields: { noteKind: 'handoff', nextAction: 'n', result: 'completed' } })).rejects.toThrow(/limit is 2500/);
    await expect(gateway().createTracker(WORKSPACE, { type: 'team-note', title: 'D', description: 'h'.repeat(601), fields: { noteKind: 'decision' } })).rejects.toThrow(/limit is 600/);
    const created = await gateway().createTracker(WORKSPACE, { type: 'team-note', title: 'H', description: 'h'.repeat(2500), fields: { noteKind: 'handoff', nextAction: 'n', result: 'completed', commits: ['abc1234 add rules'] } });
    expect(rawRow(created.id).data).toMatchObject({ noteKind: 'handoff', result: 'completed', commits: ['abc1234 add rules'] });
  });

  it('the handoff-only fields are refused on every other kind, and nobody sets the front by hand', async () => {
    await expect(gateway().createTracker(WORKSPACE, { type: 'team-note', title: 'D', fields: { noteKind: 'decision', result: 'completed' } })).rejects.toThrow(/only for notes of kind handoff/);
    await expect(gateway().createTracker(WORKSPACE, { type: 'team-note', title: 'D', fields: { noteKind: 'decision', front: 'team-front_1' } })).rejects.toThrow(/front is set by Nimbalyst/);
  });

  it('a legacy pending note without nextAction still resolves, goes obsolete and takes a new title', async () => {
    await gateway().updateTracker(WORKSPACE, 'team-note_legacy', { title: 'Renamed' });
    await gateway().updateTracker(WORKSPACE, 'team-note_legacy', { status: 'resolved' });
    await gateway().updateTracker(WORKSPACE, 'team-note_legacy', { status: 'obsolete' });
    expect(rawRow('team-note_legacy').data).toMatchObject({ title: 'Renamed', status: 'obsolete', front: 'team-front_1' });
  });

  it('clearing the next action of a pending note or a handoff is refused; the front cannot be changed or cleared', async () => {
    await gateway().updateTracker(WORKSPACE, 'team-note_legacy', { fields: { nextAction: 'Ask PCP.' } });
    await expect(gateway().updateTracker(WORKSPACE, 'team-note_legacy', { fields: { nextAction: '' } })).rejects.toThrow(/nextAction/);
    await expect(gateway().updateTracker(WORKSPACE, 'team-note_handoff', { unsetFields: ['nextAction'] })).rejects.toThrow(/nextAction/);
    await expect(gateway().updateTracker(WORKSPACE, 'team-note_handoff', { fields: { front: 'team-front_9' } })).rejects.toThrow(/front records where the note came from/);
    await expect(gateway().updateTracker(WORKSPACE, 'team-note_handoff', { unsetFields: ['front'] })).rejects.toThrow(/front records/);
    expect(rawRow('team-note_handoff').data).toMatchObject({ nextAction: 'Run C0.', front: 'team-front_1' });
  });

  it('the body cap on update follows the kind: 2,000 on a handoff, 600 on a decision', async () => {
    await gateway().updateTracker(WORKSPACE, 'team-note_handoff', { description: 'h'.repeat(2000) });
    expect(rawRow('team-note_handoff').data.description).toHaveLength(2000);
    await expect(gateway().updateTracker(WORKSPACE, 'team-note_handoff', { description: 'h'.repeat(2501) })).rejects.toThrow(/limit is 2500/);
    await expect(gateway().updateTracker(WORKSPACE, 'team-note_1', { description: 'y'.repeat(2000) })).rejects.toThrow(/limit is 600/);
    await expect(gateway().updateTracker(WORKSPACE, 'team-note_handoff', { fields: { noteKind: 'decision' } })).rejects.toThrow(/only for notes of kind handoff/);
  });
});

describe('team-front offline (F1 S1)', () => {
  /** A front as the app stores it: created by the user, one mission active. */
  const FRONT_DATA = {
    title: 'Team Mode',
    status: 'active',
    priority: 'medium',
    description: 'Estado inicial. Autoridade: ESTADO.md.',
    currentMission: 'root-1',
    createdByAgent: false,
  };
  beforeEach(() => {
    seed({ id: 'team-front_1', type: 'team-front', data: FRONT_DATA, content: FRONT_DATA.description });
  });

  it('the user creates a front from the terminal: active, manual, with no mission', async () => {
    const created = await gateway().createTracker(WORKSPACE, { type: 'team-front', title: 'Portal', description: 'Estado do Portal.' });
    const row = rawRow(created.id);
    expect(row.type).toBe('team-front');
    expect(row.data).toMatchObject({ title: 'Portal', status: 'active', description: 'Estado do Portal.', createdByAgent: false });
    expect(row.data.currentMission).toBeUndefined();
    const paused = await gateway().createTracker(WORKSPACE, { type: 'team-front', title: 'Office', status: 'paused', description: 'Estado do Office.' });
    expect(rawRow(paused.id).data.status).toBe('paused');
  });

  it('needs its state: a front with no description is refused, whitespace included, and nothing is written', async () => {
    const refused = /A team-front needs its state: write a description or a body\./;
    await expect(gateway().createTracker(WORKSPACE, { type: 'team-front', title: 'Portal' })).rejects.toThrow(refused);
    await expect(gateway().createTracker(WORKSPACE, { type: 'team-front', title: 'Portal', description: '   ' })).rejects.toThrow(refused);
    await expect(gateway().createTracker(WORKSPACE, { type: 'team-front', title: 'Portal', description: '' })).rejects.toThrow(refused);
    const db = openDatabase(dbPath, { readonly: true });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM tracker_items WHERE type = 'team-front'`).get()).toEqual({ n: 1 });
    db.close();
  });

  it('the description is also the body offline, so it satisfies the state on its own; clearing it clears the body too and is refused', async () => {
    const created = await gateway().createTracker(WORKSPACE, { type: 'team-front', title: 'Portal', description: 'Estado do Portal.' });
    expect(rawRow(created.id).content).toBe(JSON.stringify('Estado do Portal.'));
    await expect(gateway().updateTracker(WORKSPACE, created.id, { description: '' })).rejects.toThrow(/A team-front needs its state/);
    await expect(gateway().updateTracker(WORKSPACE, created.id, { description: '  ' })).rejects.toThrow(/A team-front needs its state/);
    expect(rawRow(created.id).data.description).toBe('Estado do Portal.');
    // Replacing it is fine, and an edit that leaves it alone is too.
    await gateway().updateTracker(WORKSPACE, created.id, { description: 'Estado novo.' });
    await gateway().updateTracker(WORKSPACE, created.id, { status: 'paused' });
    expect(rawRow(created.id).data).toMatchObject({ description: 'Estado novo.', status: 'paused' });
  });

  it('keeps its policy: no hand-set mission, one of three statuses, a state of at most 2,000 characters, never a type tag', async () => {
    await expect(gateway().createTracker(WORKSPACE, { type: 'team-front', title: 'Forged', fields: { currentMission: 'root-9' } })).rejects.toThrow(/currentMission is set by Nimbalyst/);
    await expect(gateway().createTracker(WORKSPACE, { type: 'team-front', title: 'Status', status: 'done' })).rejects.toThrow(/status must be one of: active, paused, closed/);
    await expect(gateway().createTracker(WORKSPACE, { type: 'team-front', title: 'Long', description: 'x'.repeat(2001) })).rejects.toThrow(/limit is 2000/);
    await expect(gateway().createTracker(WORKSPACE, { type: 'task', title: 'x', typeTags: ['team-front'] })).rejects.toThrow(/not a type tag/);
    const db = openDatabase(dbPath, { readonly: true });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM tracker_items WHERE type = 'team-front'`).get()).toEqual({ n: 1 });
    db.close();
  });

  it('the user edits title, status and description; the mission, the type and the caps hold', async () => {
    await gateway().updateTracker(WORKSPACE, 'team-front_1', { title: 'Team Mode v2', status: 'paused', description: 'Estado novo.' });
    expect(rawRow('team-front_1').data).toMatchObject({ title: 'Team Mode v2', status: 'paused', description: 'Estado novo.', currentMission: 'root-1' });
    await gateway().updateTracker(WORKSPACE, 'team-front_1', { status: 'closed' });
    expect(rawRow('team-front_1').data.status).toBe('closed');
    await expect(gateway().updateTracker(WORKSPACE, 'team-front_1', { fields: { currentMission: 'root-9' } })).rejects.toThrow(/currentMission is set by Nimbalyst/);
    await expect(gateway().updateTracker(WORKSPACE, 'team-front_1', { unsetFields: ['currentMission'] })).rejects.toThrow(/currentMission is set by Nimbalyst/);
    await expect(gateway().updateTracker(WORKSPACE, 'team-front_1', { status: 'done' })).rejects.toThrow(/status must be one of: active, paused, closed/);
    await expect(gateway().updateTracker(WORKSPACE, 'team-front_1', { description: 'y'.repeat(2001) })).rejects.toThrow(/limit is 2000/);
    await expect(gateway().updateTracker(WORKSPACE, 'team-front_1', { primaryType: 'task' })).rejects.toThrow(/cannot change type/);
    await expect(gateway().updateTracker(WORKSPACE, 'task_1', { typeTags: ['task', 'team-front'] })).rejects.toThrow(/cannot be turned into a team-front/);
    await expect(gateway().updateTracker(WORKSPACE, 'task_1', { primaryType: 'team-front' })).rejects.toThrow(/cannot be turned into a team-front/);
    expect(rawRow('team-front_1').data.currentMission).toBe('root-1');
    expect(rawRow('task_1').type).toBe('task');
  });
});

describe('a front whose state is only its body, offline (F1 S1)', () => {
  const BODY = 'Estado da frente';
  beforeEach(() => {
    seed({ id: 'team-front_body', type: 'team-front', data: { title: 'Só corpo', status: 'active', priority: 'medium', description: '', createdByAgent: false }, content: BODY });
    // A front synced from an older peer: neither a description nor a body.
    seed({ id: 'team-front_legacy', type: 'team-front', data: { title: 'Antiga', status: 'active', priority: 'medium', createdByAgent: false } });
  });

  it('keeps its body: an empty or blank description is refused (it would overwrite the body) and nothing is persisted', async () => {
    const before = rawRow('team-front_body');
    for (const input of [{ description: '' }, { description: '   ' }, { description: ' \n ' }]) {
      await expect(gateway().updateTracker(WORKSPACE, 'team-front_body', input), JSON.stringify(input)).rejects.toThrow(/A team-front needs its state: write a description or a body\./);
    }
    const after = rawRow('team-front_body');
    expect(after.data).toEqual(before.data);
    expect(after.content).toBe(before.content);
    expect(after.body_version).toBe(before.body_version);
    expect(after.updated).toBe(before.updated);
    expect(after.content).toBe(JSON.stringify(BODY));
  });

  it('a title or status edit that does not touch the description leaves the body alone and is accepted', async () => {
    await gateway().updateTracker(WORKSPACE, 'team-front_body', { title: 'Só corpo v2', status: 'paused' });
    const row = rawRow('team-front_body');
    expect(row.data).toMatchObject({ title: 'Só corpo v2', status: 'paused', description: '' });
    expect(row.content).toBe(JSON.stringify(BODY));
  });

  it('a real description replaces the body and is the state', async () => {
    await gateway().updateTracker(WORKSPACE, 'team-front_body', { description: 'Estado novo.' });
    expect(rawRow('team-front_body').content).toBe(JSON.stringify('Estado novo.'));
  });

  it('a legacy front with neither description nor body still takes a title and a status edit', async () => {
    await gateway().updateTracker(WORKSPACE, 'team-front_legacy', { title: 'Antiga v2' });
    await gateway().updateTracker(WORKSPACE, 'team-front_legacy', { status: 'closed' });
    expect(rawRow('team-front_legacy').data).toMatchObject({ title: 'Antiga v2', status: 'closed' });
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
