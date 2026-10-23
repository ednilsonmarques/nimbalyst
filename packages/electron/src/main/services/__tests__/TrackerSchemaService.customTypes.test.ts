import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Reuse the same electron / ipc / chokidar mocks as the watcher test so the
// real TrackerSchemaService can run headless against a temp workspace dir.
const { mockSafeHandle, mockWatch, mockWindowSend } = vi.hoisted(() => ({
  mockSafeHandle: vi.fn(),
  mockWatch: vi.fn(() => ({
    on() {
      return this;
    },
    close: vi.fn().mockResolvedValue(undefined),
  })),
  mockWindowSend: vi.fn(),
}));

vi.mock('electron', async () => ({
  app: {
    getPath: (await import('../../../../test-stubs/privateUserData')).testApp.getPath,
    isPackaged: false,
    getName: vi.fn(() => 'Nimbalyst'),
    getVersion: vi.fn(() => '0.0.0-test'),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
    isReady: vi.fn(() => true),
    quit: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send: mockWindowSend } }],
  },
}));

vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: mockSafeHandle,
  safeOn: vi.fn(),
  safeOnce: vi.fn(),
}));

vi.mock('chokidar', () => ({
  default: { watch: mockWatch },
}));

// TrackerSchemaService transitively imports ../../database/initialize (via
// trackerTypeDefStore -> getDatabase). That module pulls in RepositoryManager
// and the sync/auth graph, which a neighbor test's leaked mock can deadlock
// under vitest 4's shared worker module registry -- the dynamic
// `await import('../TrackerSchemaService')` below would then never resolve and
// the beforeEach hook times out. Stub getDatabase here so this file owns the
// state and never depends on that fragile graph. DB writes are best-effort and
// tolerate a null database, so returning null preserves test intent.
vi.mock('../../database/initialize', () => ({
  getDatabase: () => null,
}));

// Schema projection only needs a team-name lookup here. Loading TeamService
// pulls in the runtime and sync/auth graph, timing out setup under suite load.
vi.mock('../TeamService', () => ({
  findTeamForWorkspace: vi.fn(async () => null),
}));
// Watcher attribution is not exercised by these direct schema operations.
vi.mock('../TrackerIdentityService', () => ({
  getCurrentIdentity: vi.fn(() => ({})),
}));

/** The destructive-change guard rail's opt-in, on every schema write path. */
interface TestSchemaWriteOptions {
  confirmDestructive?: boolean;
  actorRole?: 'admin' | 'member';
}

interface TrackerSchemaServiceModule {
  initTrackerSchemaService: (workspacePath?: string | null) => void;
  updateTrackerSchemaWorkspace: (workspacePath: string | null) => void;
  ensureWorkspaceTrackerSchemasLoaded: (workspacePath: string | null | undefined) => void;
  getTrackerSchema: (type: string) => { type: string } | undefined;
  getAllTrackerSchemas: () => Array<{ type: string }>;
  isBuiltinTrackerSchema: (type: string) => boolean;
  upsertWorkspaceTrackerSchema: (
    workspacePath: string,
    schema: string,
    options?: TestSchemaWriteOptions & {
      fileName?: string;
      overwrite?: boolean;
      allowBuiltinOverride?: boolean;
    },
  ) => Promise<{ model: { type: string }; filePath: string; backupPath?: string }>;
  customizeWorkspaceTrackerSchema: (
    workspacePath: string,
    type: string,
  ) => Promise<{ model: { type: string; displayName?: string }; filePath: string; created: boolean }>;
  resetWorkspaceTrackerSchemaOverride: (
    workspacePath: string,
    type: string,
    options?: TestSchemaWriteOptions,
  ) => Promise<{ reset: boolean; filePath?: string }>;
  getWorkspaceTrackerSchemaOverride: (
    workspacePath: string,
    type: string,
  ) => Promise<{ overridden: boolean; filePath?: string }>;
  applyRemoteWorkspaceTrackerSchemaDef: (
    workspacePath: string,
    def: { type: string; model: string | null; syncId: number },
  ) => Promise<{ applied: boolean; deleted?: boolean; reason?: string }>;
  upsertWorkspaceTrackerSchemaPatch: (
    workspacePath: string,
    patch: unknown,
    options?: TestSchemaWriteOptions & { overwrite?: boolean },
  ) => Promise<{ model: { type: string; fields: any[] }; filePath: string; backupPath?: string }>;
  TrackerTypeExistsError: new (...args: any[]) => Error;
}

function statusOptionValues(service: TrackerSchemaServiceModule, type: string): string[] {
  const model = service.getTrackerSchema(type) as unknown as { fields: any[] } | undefined;
  const status = model?.fields.find((f) => f.name === 'status');
  return (status?.options ?? []).map((o: any) => o.value);
}

function buildCustomYaml(type: string, displayName: string): string {
  return `packageVersion: 1.0.0
packageId: developer

type: ${type}
displayName: ${displayName}
displayNamePlural: ${displayName}s
icon: campaign
color: "#0f766e"

modes:
  inline: true
  fullDocument: false

sharing: personal
draftByDefault: false

idPrefix: ${type.slice(0, 3)}
idFormat: ulid

fields:
  - name: title
    type: string
    required: true
    displayInline: true

roles:
  title: title
`;
}

function buildSyncedModel(type: string, displayName: string): string {
  return JSON.stringify({
    type,
    displayName,
    fields: [
      { name: 'title', type: 'string', required: true },
    ],
    roles: { title: 'title' },
  });
}

// A base with a select, and a subtype that only adds a field, for the
// "base narrows a select" probe a frozen resolved copy fails.
const techYaml = `type: tech
displayName: Tech
displayNamePlural: Techs
icon: memory
color: "#7c3aed"
modes:
  inline: true
idPrefix: tec
fields:
  - name: title
    type: string
    required: true
  - name: status
    type: select
    options: [adopted, trial, retiring]
roles:
  title: title
`;

function narrowTechStatus(registry: { get(type: string): any; register(model: any): void }): void {
  const tech = registry.get('tech');
  registry.register({
    ...tech,
    fields: tech.fields.map((f: any) => (f.name === 'status' ? { ...f, options: f.options.slice(0, 2) } : f)),
  });
}

describe('TrackerSchemaService custom-type visibility (NIM-760)', () => {
  let workspacePath: string;
  let trackersDir: string;
  let service: TrackerSchemaServiceModule;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-schema-custom-'));
    trackersDir = path.join(workspacePath, '.nimbalyst', 'trackers');
    await fs.mkdir(trackersDir, { recursive: true });
    await fs.writeFile(
      path.join(trackersDir, 'marketing.yaml'),
      buildCustomYaml('marketing', 'Marketing'),
      'utf-8',
    );

    service = (await import('../TrackerSchemaService')) as unknown as TrackerSchemaServiceModule;
    // Initialize with NO workspace: builtins load, IPC registers, but the
    // workspace's custom schemas are never loaded -- this is the registry state
    // the in-process MCP server sees when window/session events have not loaded
    // (or have cleared) the active workspace's schemas. Custom types are invisible.
    service.initTrackerSchemaService();
  });

  afterEach(async () => {
    service.updateTrackerSchemaWorkspace(null);
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  it('registers workspace YAML types into the registry the MCP handlers read', () => {
    // Bug state: the registry the MCP path reads only has builtins.
    expect(service.getTrackerSchema('marketing')).toBeUndefined();
    expect(service.getAllTrackerSchemas().some((m) => m.type === 'marketing')).toBe(false);

    service.ensureWorkspaceTrackerSchemasLoaded(workspacePath);

    // Fixed: the custom type is now visible to list_types and assignable by
    // create/update validation (which read the same globalRegistry).
    const model = service.getTrackerSchema('marketing');
    expect(model).toBeDefined();
    expect(model?.type).toBe('marketing');
    expect(service.getAllTrackerSchemas().some((m) => m.type === 'marketing')).toBe(true);
    expect(service.isBuiltinTrackerSchema('marketing')).toBe(false);
  });
});

describe('tracker_define_type clobber guard (NIM-760)', () => {
  let workspacePath: string;
  let trackersDir: string;
  let marketingFile: string;
  let service: TrackerSchemaServiceModule;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-schema-clobber-'));
    trackersDir = path.join(workspacePath, '.nimbalyst', 'trackers');
    await fs.mkdir(trackersDir, { recursive: true });
    marketingFile = path.join(trackersDir, 'marketing.yaml');
    await fs.writeFile(marketingFile, buildCustomYaml('marketing', 'Marketing'), 'utf-8');

    service = (await import('../TrackerSchemaService')) as unknown as TrackerSchemaServiceModule;
    service.initTrackerSchemaService(workspacePath);
  });

  afterEach(async () => {
    service.updateTrackerSchemaWorkspace(null);
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  it('refuses to overwrite an existing custom type without opt-in', async () => {
    await expect(
      service.upsertWorkspaceTrackerSchema(
        workspacePath,
        buildCustomYaml('marketing', 'Marketing REPLACED'),
      ),
    ).rejects.toBeInstanceOf(service.TrackerTypeExistsError);

    // The original definition must survive untouched (no silent data loss).
    const onDisk = await fs.readFile(marketingFile, 'utf-8');
    expect(onDisk).toContain('displayName: Marketing');
    expect(onDisk).not.toContain('Marketing REPLACED');
  });

  it('backs up the existing definition when overwrite is opted in', async () => {
    const result = await service.upsertWorkspaceTrackerSchema(
      workspacePath,
      buildCustomYaml('marketing', 'Marketing REPLACED'),
      // Replacing a definition wholesale drops the fields it had, so it is a
      // destructive change and states its confirmation like any other.
      { overwrite: true, confirmDestructive: true },
    );

    expect(result.backupPath).toBeDefined();

    // New definition written.
    const onDisk = await fs.readFile(marketingFile, 'utf-8');
    expect(onDisk).toContain('Marketing REPLACED');

    // Backup holds the original, and is not loadable as a schema (.bak suffix).
    const backup = await fs.readFile(result.backupPath!, 'utf-8');
    expect(backup).toContain('displayName: Marketing');
    expect(backup).not.toContain('Marketing REPLACED');
    expect(result.backupPath!.endsWith('.bak')).toBe(true);
  });

  it('keeps built-in clobber guard for direct define calls', async () => {
    await expect(
      service.upsertWorkspaceTrackerSchema(
        workspacePath,
        buildCustomYaml('bug', 'Bug Override'),
      ),
    ).rejects.toThrow("Cannot redefine built-in tracker type 'bug'");
  });

  it('customizes and resets a built-in through the explicit override path', async () => {
    const customized = await service.customizeWorkspaceTrackerSchema(workspacePath, 'bug');

    expect(customized.created).toBe(true);
    expect(customized.model.type).toBe('bug');
    expect(path.basename(customized.filePath)).toBe('bug.yaml');

    const override = await service.getWorkspaceTrackerSchemaOverride(workspacePath, 'bug');
    expect(override).toEqual({ overridden: true, filePath: customized.filePath });
    expect(await fs.readFile(customized.filePath, 'utf-8')).toContain('type: bug');

    const reset = await service.resetWorkspaceTrackerSchemaOverride(workspacePath, 'bug');
    expect(reset).toEqual({ reset: true, filePath: customized.filePath });
    await expect(fs.stat(customized.filePath)).rejects.toThrow();

    const after = await service.getWorkspaceTrackerSchemaOverride(workspacePath, 'bug');
    expect(after).toEqual({ overridden: false });
  });

  it('opens an existing override instead of overwriting it', async () => {
    const first = await service.customizeWorkspaceTrackerSchema(workspacePath, 'bug');
    await fs.writeFile(first.filePath, buildCustomYaml('bug', 'Bug Customized'), 'utf-8');

    const second = await service.customizeWorkspaceTrackerSchema(workspacePath, 'bug');

    expect(second.created).toBe(false);
    expect(second.filePath).toBe(first.filePath);
    expect(second.model.displayName).toBe('Bug Customized');
  });
});

describe('TrackerSchemaService builtin override via patch', () => {
  let workspacePath: string;
  let trackersDir: string;
  let service: TrackerSchemaServiceModule;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-schema-patch-'));
    trackersDir = path.join(workspacePath, '.nimbalyst', 'trackers');
    await fs.mkdir(trackersDir, { recursive: true });

    service = (await import('../TrackerSchemaService')) as unknown as TrackerSchemaServiceModule;
    service.initTrackerSchemaService(workspacePath);
  });

  afterEach(async () => {
    service.updateTrackerSchemaWorkspace(null);
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  it('writes <type>.patch.yaml and registers the resolved builtin override', async () => {
    // 'task' is a builtin; adding a status via patch must NOT be refused and
    // must resolve against the live builtin (keeping its shipped options).
    const before = statusOptionValues(service, 'task');
    expect(before).toContain('to-do');
    expect(before).not.toContain('archived');

    const result = await service.upsertWorkspaceTrackerSchemaPatch(workspacePath, {
      type: 'task',
      fields: [
        { name: 'status', options: { set: [{ value: 'archived', label: 'Archived', icon: 'inventory_2' }] } },
      ],
    });

    expect(path.basename(result.filePath)).toBe('task.patch.yaml');
    // On-disk artifact is a small delta, not a full snapshot.
    const onDisk = await fs.readFile(result.filePath, 'utf-8');
    expect(onDisk).toContain('type: task');
    expect(onDisk).toContain('archived');
    expect(onDisk).not.toContain('displayNamePlural'); // not a full schema copy

    // Registry now holds the resolved model: shipped options + the new one.
    const after = statusOptionValues(service, 'task');
    expect(after).toContain('to-do');
    expect(after).toContain('archived');
    expect(service.isBuiltinTrackerSchema('task')).toBe(true);
  });

  it('re-resolves a patch on load and reports the override', async () => {
    // Write a patch file directly, then re-load the workspace from disk.
    await fs.writeFile(
      path.join(trackersDir, 'bug.patch.yaml'),
      `type: bug\nfields:\n  - name: status\n    options:\n      set:\n        - value: cannot-reproduce\n          label: Cannot Reproduce\n          icon: help\n`,
      'utf-8',
    );
    service.updateTrackerSchemaWorkspace(null);
    service.updateTrackerSchemaWorkspace(workspacePath);

    expect(statusOptionValues(service, 'bug')).toContain('cannot-reproduce');
    const override = await service.getWorkspaceTrackerSchemaOverride(workspacePath, 'bug');
    expect(override.overridden).toBe(true);
    expect(path.basename(override.filePath!)).toBe('bug.patch.yaml');
  });

  it('opens an existing patch override instead of throwing on it (NIM-3065)', async () => {
    // A patch has no `displayName` by design, and this path used to run the
    // full-model parser over it: the throw meant the IPC handler never returned
    // a filePath, so the Settings "Edit schema override" pencil silently did
    // nothing for every overridden builtin.
    await fs.writeFile(
      path.join(trackersDir, 'bug.patch.yaml'),
      `type: bug\nfields:\n  - name: status\n    options:\n      set:\n        - value: wont-fix\n          label: Wont Fix\n          icon: block\n`,
      'utf-8',
    );
    service.updateTrackerSchemaWorkspace(null);
    service.updateTrackerSchemaWorkspace(workspacePath);

    const opened = await service.customizeWorkspaceTrackerSchema(workspacePath, 'bug');

    expect(opened.created).toBe(false);
    expect(path.basename(opened.filePath)).toBe('bug.patch.yaml');
    // Resolved against the builtin seed, so it is a usable model, not the delta.
    expect(opened.model.type).toBe('bug');
    expect(opened.model.displayName).toBeTruthy();
  });

  it('resets a patch override back to the builtin default', async () => {
    await service.upsertWorkspaceTrackerSchemaPatch(workspacePath, {
      type: 'task',
      fields: [{ name: 'status', options: { set: [{ value: 'archived', label: 'Archived' }] } }],
    });
    expect(statusOptionValues(service, 'task')).toContain('archived');

    const reset = await service.resetWorkspaceTrackerSchemaOverride(workspacePath, 'task', {
      confirmDestructive: true,
    });
    expect(reset.reset).toBe(true);

    // Builtin restored: the patched option is gone.
    expect(statusOptionValues(service, 'task')).not.toContain('archived');
    const after = await service.getWorkspaceTrackerSchemaOverride(workspacePath, 'task');
    expect(after.overridden).toBe(false);
  });
});

describe('TrackerSchemaService reset propagates a tombstone', () => {
  let workspacePath: string;
  let service: TrackerSchemaServiceModule;
  let removeMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    removeMock = vi.fn(async () => undefined);
    vi.doMock('../tracker/trackerTypeDefStore', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../tracker/trackerTypeDefStore')>();
      return { ...actual, removeTrackerTypeDef: removeMock };
    });

    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-schema-reset-'));
    await fs.mkdir(path.join(workspacePath, '.nimbalyst', 'trackers'), { recursive: true });

    service = (await import('../TrackerSchemaService')) as unknown as TrackerSchemaServiceModule;
    service.initTrackerSchemaService(workspacePath);
  });

  afterEach(async () => {
    service.updateTrackerSchemaWorkspace(null);
    vi.doUnmock('../tracker/trackerTypeDefStore');
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  it('tombstones the mirror row so the reset reaches the team', async () => {
    await service.upsertWorkspaceTrackerSchemaPatch(workspacePath, {
      type: 'task',
      fields: [{ name: 'status', options: { set: [{ value: 'archived', label: 'Archived' }] } }],
    });

    const reset = await service.resetWorkspaceTrackerSchemaOverride(workspacePath, 'task', {
      confirmDestructive: true,
    });
    expect(reset.reset).toBe(true);
    // The tombstone is what propagates the reset (pending delete → pushed → peers
    // restore the builtin). Without it the stale override row keeps syncing.
    expect(removeMock).toHaveBeenCalledWith(workspacePath, 'task');
  });

  it('does not tombstone when there was no override to reset', async () => {
    const reset = await service.resetWorkspaceTrackerSchemaOverride(workspacePath, 'task');
    expect(reset.reset).toBe(false);
    expect(removeMock).not.toHaveBeenCalled();
  });
});

describe('TrackerSchemaService remote schema sync apply', () => {
  let workspacePath: string;
  let service: TrackerSchemaServiceModule;
  let applyRemoteMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    applyRemoteMock = vi.fn(async (_workspacePath: string, def: { model: string | null }) => ({
      applied: true,
      deleted: def.model === null,
    }));
    vi.doMock('../tracker/trackerTypeDefStore', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../tracker/trackerTypeDefStore')>();
      return {
        ...actual,
        applyRemoteTrackerSchemaDef: applyRemoteMock,
      };
    });

    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-schema-sync-'));
    await fs.mkdir(path.join(workspacePath, '.nimbalyst', 'trackers'), { recursive: true });

    service = (await import('../TrackerSchemaService')) as unknown as TrackerSchemaServiceModule;
    service.initTrackerSchemaService(workspacePath);
  });

  afterEach(async () => {
    service.updateTrackerSchemaWorkspace(null);
    vi.doUnmock('../tracker/trackerTypeDefStore');
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  it('registers a valid applied remote schema in the active workspace registry', async () => {
    const model = buildSyncedModel('remoteEpic', 'Remote Epic');
    const result = await service.applyRemoteWorkspaceTrackerSchemaDef(workspacePath, {
      type: 'remoteEpic',
      model,
      syncId: 42,
    });

    expect(result).toEqual({ applied: true, deleted: false });
    expect(applyRemoteMock).toHaveBeenCalledWith(workspacePath, {
      type: 'remoteEpic',
      model: JSON.stringify({ ...JSON.parse(model), sharing: 'team', draftByDefault: false }),
      syncId: 42,
    });
    expect(service.getTrackerSchema('remoteEpic')?.type).toBe('remoteEpic');
    expect(mockWindowSend).toHaveBeenCalledWith('tracker-schema:changed', expect.any(Array));
  });

  it('projects and mirrors a synced subtype as declared, even from a payload with no declaration', async () => {
    await fs.writeFile(path.join(workspacePath, '.nimbalyst', 'trackers', 'tech.yaml'), techYaml, 'utf-8');
    service.ensureWorkspaceTrackerSchemasLoaded(workspacePath);
    const { globalRegistry } = await import('@nimbalyst/tracker-schema');
    const tech = globalRegistry.get('tech')!;
    // The shape the live mirror holds: the resolved copy, inherited fields and all.
    const resolved = { ...tech, type: 'lib', extends: 'tech', displayName: 'Lib', idPrefix: 'lib',
      fields: [...tech.fields, { name: 'npmPackage', type: 'string' }] };

    await service.applyRemoteWorkspaceTrackerSchemaDef(workspacePath, { type: 'lib', model: JSON.stringify(resolved), syncId: 9 });

    const stored = JSON.parse(applyRemoteMock.mock.calls[0][1].model);
    expect(stored.declaredForm.fields.map((f: any) => f.name)).toEqual(['npmPackage']);
    const file = await fs.readFile(path.join(workspacePath, '.nimbalyst', 'trackers', 'lib.yaml'), 'utf-8');
    expect(file).toContain('extends: tech');
    expect(file).not.toContain('name: status');
    narrowTechStatus(globalRegistry);
    expect(service.getTrackerSchema('lib')).toBeDefined();
  });

  it('rejects malformed remote schema JSON before it reaches the DB mirror', async () => {
    const result = await service.applyRemoteWorkspaceTrackerSchemaDef(workspacePath, {
      type: 'remoteEpic',
      model: '{"type":"different","fields":[]}',
      syncId: 1,
    });

    expect(result).toEqual({ applied: false, reason: 'invalid' });
    expect(applyRemoteMock).not.toHaveBeenCalled();
    expect(service.getTrackerSchema('remoteEpic')).toBeUndefined();
  });

  it('does not let a remote team schema replace a personal workspace tracker', async () => {
    await fs.writeFile(
      path.join(workspacePath, '.nimbalyst', 'trackers', 'remoteEpic.yaml'),
      buildCustomYaml('remoteEpic', 'Personal Epic'),
      'utf-8',
    );
    const { updateWorkspaceState } = await import('../../utils/store');
    updateWorkspaceState(workspacePath, (draft) => {
      const divergence = {
        trackerType: 'remoteEpic',
        legacySchemaMode: 'shared' as const,
        legacyItemMode: 'local' as const,
        sharing: 'personal' as const,
        draftByDefault: false,
        diverged: true,
      };
      draft.trackerSharingMigration = {
        version: 1,
        migratedAt: 1,
        entries: [divergence],
        divergences: [divergence],
      };
    });

    const result = await service.applyRemoteWorkspaceTrackerSchemaDef(workspacePath, {
      type: 'remoteEpic',
      model: buildSyncedModel('remoteEpic', 'Remote Epic'),
      syncId: 42,
    });

    expect(result).toEqual({ applied: false, reason: 'personal' });
    expect(applyRemoteMock).not.toHaveBeenCalled();
  });

  it('applies a remote tombstone to the active registry', async () => {
    await service.applyRemoteWorkspaceTrackerSchemaDef(workspacePath, {
      type: 'remoteEpic',
      model: buildSyncedModel('remoteEpic', 'Remote Epic'),
      syncId: 1,
    });
    expect(service.getTrackerSchema('remoteEpic')).toBeDefined();
    mockWindowSend.mockClear();

    const result = await service.applyRemoteWorkspaceTrackerSchemaDef(workspacePath, {
      type: 'remoteEpic',
      model: null,
      syncId: 2,
    });

    expect(result).toEqual({ applied: true, deleted: true });
    expect(service.getTrackerSchema('remoteEpic')).toBeUndefined();
    expect(mockWindowSend).toHaveBeenCalledWith('tracker-schema:changed', expect.any(Array));
  });

  it('applies a synced BUILTIN override on a peer, and a tombstone restores the builtin', async () => {
    // A resolved-snapshot override for a builtin arrives from the admin. The peer
    // must register it over the builtin (task gains an extra status), keeping
    // isBuiltin true; a later tombstone restores the shipped builtin.
    const overrideModel = JSON.stringify({
      type: 'task',
      displayName: 'Task',
      displayNamePlural: 'Tasks',
      icon: 'task_alt',
      color: '#2563eb',
      modes: { inline: true, fullDocument: false },
      idPrefix: 'tsk',
      idFormat: 'ulid',
      sharing: 'team',
      draftByDefault: false,
      fields: [
        { name: 'title', type: 'string', required: true },
        {
          name: 'status',
          type: 'select',
          options: [
            { value: 'to-do', label: 'To Do' },
            { value: 'archived', label: 'Archived' },
          ],
        },
      ],
      roles: { title: 'title', workflowStatus: 'status' },
    });

    const applied = await service.applyRemoteWorkspaceTrackerSchemaDef(workspacePath, {
      type: 'task',
      model: overrideModel,
      syncId: 10,
    });
    expect(applied.applied).toBe(true);
    expect(service.isBuiltinTrackerSchema('task')).toBe(true);
    const taskModel = service.getTrackerSchema('task') as unknown as { fields: any[] };
    const values = taskModel.fields.find((f) => f.name === 'status')?.options?.map((o: any) => o.value);
    expect(values).toContain('archived');

    // Tombstone (reset from the admin) restores the shipped builtin.
    const del = await service.applyRemoteWorkspaceTrackerSchemaDef(workspacePath, {
      type: 'task',
      model: null,
      syncId: 11,
    });
    expect(del).toEqual({ applied: true, deleted: true });
    expect(service.isBuiltinTrackerSchema('task')).toBe(true);
    const restored = service.getTrackerSchema('task') as unknown as { fields: any[] };
    const restoredValues = restored.fields.find((f) => f.name === 'status')?.options?.map((o: any) => o.value);
    expect(restoredValues).not.toContain('archived');
  });
});

describe('TrackerSchemaService derived types (extends)', () => {
  let workspacePath: string;
  let trackersDir: string;
  let service: TrackerSchemaServiceModule & {
    encodeTrackerSchemaDefForPush: <T extends { type: string; model: string | null }>(def: T) => T;
  };

  // Sorts BEFORE its base on disk, so the loader cannot rely on file order.
  const derivedYaml = `type: campaign
extends: marketing
displayName: Campaign
displayNamePlural: Campaigns
idPrefix: cmp
fields:
  - name: channel
    type: string
`;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-schema-derived-'));
    trackersDir = path.join(workspacePath, '.nimbalyst', 'trackers');
    await fs.mkdir(trackersDir, { recursive: true });
    await fs.writeFile(path.join(trackersDir, 'marketing.yaml'), buildCustomYaml('marketing', 'Marketing'), 'utf-8');
    service = (await import('../TrackerSchemaService')) as unknown as typeof service;
  });

  afterEach(async () => {
    service.updateTrackerSchemaWorkspace(null);
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  function fieldNames(type: string): string[] {
    return ((service.getTrackerSchema(type) as unknown as { fields?: any[] })?.fields ?? []).map((f) => f.name);
  }

  it('loads a derived type file and syncs it with its extends', async () => {
    await fs.writeFile(path.join(trackersDir, 'campaign.yaml'), derivedYaml, 'utf-8');
    service.initTrackerSchemaService(workspacePath);

    expect(fieldNames('campaign')).toEqual(expect.arrayContaining(['title', 'channel']));
    const pushed = service.encodeTrackerSchemaDefForPush({ type: 'campaign', model: '{}' });
    expect(pushed.model).toContain('"extends":"marketing"');
  });

  it('defines a derived type through the upsert the tool uses', async () => {
    service.initTrackerSchemaService(workspacePath);

    const { model, filePath } = await service.upsertWorkspaceTrackerSchema(workspacePath, derivedYaml);

    expect(model.type).toBe('campaign');
    expect(await fs.readFile(filePath, 'utf-8')).toContain('extends: marketing');
    expect(fieldNames('campaign')).toEqual(expect.arrayContaining(['title', 'channel']));
  });

  it('keeps the declaration in force through a team write-through of the resolved model', async () => {
    await fs.writeFile(path.join(trackersDir, 'tech.yaml'), techYaml, 'utf-8');
    const libPath = path.join(trackersDir, 'lib.yaml');
    await fs.writeFile(libPath, 'type: lib\nextends: tech\nfields:\n  - name: npmPackage\n    type: string\n', 'utf-8');
    service.initTrackerSchemaService(workspacePath);
    const { globalRegistry } = await import('@nimbalyst/tracker-schema');
    const { writeThroughTeamTrackerSchemaEdit } = await import('../tracker/trackerSchemaProjection');

    await writeThroughTeamTrackerSchemaEdit(workspacePath, libPath, { ...globalRegistry.get('lib')!, sharing: 'team' });

    expect(globalRegistry.getDeclaredModel('lib')?.fields?.map((f) => f.name)).toEqual(['npmPackage']);
    narrowTechStatus(globalRegistry);
    expect(service.getTrackerSchema('lib')).toBeDefined();
  });

  it('loads a subtype saved before its base once the base file appears', async () => {
    service.initTrackerSchemaService(workspacePath);
    const reload = (service as unknown as { reloadWorkspaceSchema(ws: string, file: string): Promise<void> }).reloadWorkspaceSchema;
    const libPath = path.join(trackersDir, 'lib.yaml');
    await fs.writeFile(libPath, 'type: lib\nextends: tech\nfields:\n  - name: npmPackage\n    type: string\n', 'utf-8');
    await reload(workspacePath, libPath);
    expect(service.getTrackerSchema('lib')).toBeUndefined();

    const techPath = path.join(trackersDir, 'tech.yaml');
    await fs.writeFile(techPath, techYaml, 'utf-8');
    await reload(workspacePath, techPath);

    expect(fieldNames('lib')).toEqual(expect.arrayContaining(['title', 'status', 'npmPackage']));
  });

  it('loads a derived type for a workspace that is not the active one', async () => {
    await fs.writeFile(path.join(trackersDir, 'campaign.yaml'), derivedYaml, 'utf-8');
    service.initTrackerSchemaService();
    service.updateTrackerSchemaWorkspace(await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-schema-other-')));

    service.ensureWorkspaceTrackerSchemasLoaded(workspacePath);

    const { globalRegistry } = await import('@nimbalyst/tracker-schema');
    const layered = globalRegistry.getForWorkspace(workspacePath, 'campaign');
    expect(layered?.fields.map((f) => f.name)).toEqual(expect.arrayContaining(['title', 'channel']));
  });
});

describe('TrackerSchemaService refuses to patch or override a protected type (NIB.130)', () => {
  const PROTECTED = ['team-note', 'tool-manifest', 'team-front'] as const;
  let workspacePath: string;
  let trackersDir: string;
  let service: TrackerSchemaServiceModule;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-schema-protected-'));
    trackersDir = path.join(workspacePath, '.nimbalyst', 'trackers');
    await fs.mkdir(trackersDir, { recursive: true });

    service = (await import('../TrackerSchemaService')) as unknown as TrackerSchemaServiceModule;
    service.initTrackerSchemaService(workspacePath);
  });

  afterEach(async () => {
    service.updateTrackerSchemaWorkspace(null);
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  async function trackerFiles(): Promise<string[]> {
    return (await fs.readdir(trackersDir)).filter((name) => !name.endsWith('.bak'));
  }

  for (const type of PROTECTED) {
    it(`${type}: the builtin is in force, and a patch of any kind is refused with a clear error and writes nothing`, async () => {
      expect(service.isBuiltinTrackerSchema(type)).toBe(true);
      const before = JSON.stringify(service.getTrackerSchema(type));
      const patches: Array<Record<string, unknown>> = [
        { type, fields: [{ name: 'extra', set: { type: 'string' } }] },
        { type, fields: [{ name: 'status', options: { set: [{ value: 'sneaky', label: 'Sneaky' }] } }] },
        { type, sharing: 'personal' },
        { type, roles: { workflowStatus: 'priority' } },
        { type, archived: true },
        { type, icon: 'bolt', color: '#000000', displayName: 'Renamed' },
      ];
      for (const patch of patches) {
        await expect(service.upsertWorkspaceTrackerSchemaPatch(workspacePath, patch), JSON.stringify(patch))
          .rejects.toThrow(new RegExp(`'${type}' is protected.*cannot be patched or overridden`));
      }
      // Not even with the destructive-change opt-in.
      await expect(service.upsertWorkspaceTrackerSchemaPatch(workspacePath, { type, icon: 'bolt' }, { confirmDestructive: true, overwrite: true }))
        .rejects.toThrow(/is protected/);
      expect(await trackerFiles()).toEqual([]);
      expect(JSON.stringify(service.getTrackerSchema(type))).toBe(before);
    });

    it(`${type}: customizing it (a full override file) is refused too, so no <type>.yaml is ever materialized`, async () => {
      await expect(service.customizeWorkspaceTrackerSchema(workspacePath, type)).rejects.toThrow(/is protected/);
      await expect(
        service.upsertWorkspaceTrackerSchema(workspacePath, buildCustomYaml(type, 'Override'), { allowBuiltinOverride: true }),
      ).rejects.toThrow(/is protected/);
      expect(await trackerFiles()).toEqual([]);
      expect(await service.getWorkspaceTrackerSchemaOverride(workspacePath, type)).toEqual({ overridden: false });
    });
  }

  it('a patch on a non-protected builtin is still accepted and written, right after a refused protected one', async () => {
    await expect(service.upsertWorkspaceTrackerSchemaPatch(workspacePath, { type: 'team-front', icon: 'bolt' })).rejects.toThrow(/is protected/);
    const result = await service.upsertWorkspaceTrackerSchemaPatch(workspacePath, {
      type: 'bug',
      fields: [{ name: 'status', options: { set: [{ value: 'cannot-reproduce', label: 'Cannot Reproduce' }] } }],
    });
    expect(path.basename(result.filePath)).toBe('bug.patch.yaml');
    expect(statusOptionValues(service, 'bug')).toContain('cannot-reproduce');
    expect(await trackerFiles()).toEqual(['bug.patch.yaml']);
  });

  it('custom types are unaffected: define one, then patch it', async () => {
    const defined = await service.upsertWorkspaceTrackerSchema(workspacePath, buildCustomYaml('marketing', 'Marketing'));
    expect(defined.model.type).toBe('marketing');
    const patched = await service.upsertWorkspaceTrackerSchemaPatch(workspacePath, { type: 'marketing', icon: 'bolt' });
    expect(patched.model.type).toBe('marketing');
  });

  it('resetting an existing override of a protected type stays possible: it is the way back to the shipped schema', async () => {
    // An override written before the guard existed (or by hand), loaded from disk.
    await fs.writeFile(
      path.join(trackersDir, 'team-note.patch.yaml'),
      `type: team-note\nfields:\n  - name: status\n    options:\n      set:\n        - value: legacy\n          label: Legacy\n`,
      'utf-8',
    );
    service.updateTrackerSchemaWorkspace(null);
    service.updateTrackerSchemaWorkspace(workspacePath);
    expect(statusOptionValues(service, 'team-note')).toContain('legacy');

    const reset = await service.resetWorkspaceTrackerSchemaOverride(workspacePath, 'team-note', { confirmDestructive: true });
    expect(reset.reset).toBe(true);
    expect(statusOptionValues(service, 'team-note')).not.toContain('legacy');
  });

  it('the on-disk loader path is untouched by the guard: a hand-placed patch of a non-protected type still loads', async () => {
    await fs.writeFile(
      path.join(trackersDir, 'task.patch.yaml'),
      `type: task\nfields:\n  - name: status\n    options:\n      set:\n        - value: from-disk\n          label: From Disk\n`,
      'utf-8',
    );
    service.updateTrackerSchemaWorkspace(null);
    service.updateTrackerSchemaWorkspace(workspacePath);
    // A non-protected type, only to prove the loader path is unchanged by the new guard.
    expect(statusOptionValues(service, 'task')).toContain('from-disk');
  });
});
