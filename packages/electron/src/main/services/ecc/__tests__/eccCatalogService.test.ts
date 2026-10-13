// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const electronState = vi.hoisted(() => ({ isPackaged: false, appPath: 'C:/dev/nimbalyst/packages/electron' }));
vi.mock('electron', () => ({
  app: {
    get isPackaged() { return electronState.isPackaged; },
    getAppPath: () => electronState.appPath,
  },
}));
vi.mock('../../../utils/appPaths', () => ({ getPackageRoot: () => electronState.appPath }));

import { ECC_CATALOG_INDEX_SHA, ECC_CATALOG_INDEX_VERSION } from '@nimbalyst/runtime/ai/ecc/eccCatalogIndex.generated';
import {
  ECC_CATALOG_FILE_NAME,
  eccCatalogLookupTool,
  getEccCatalogPath,
  loadEccCatalog,
  resetEccCatalogCache,
} from '../eccCatalogService';

const repoRoot = path.resolve(__dirname, '../../../../../../..');
const packagedCatalog = path.join(repoRoot, 'packages', 'electron', 'resources', 'ecc-catalog', ECC_CATALOG_FILE_NAME);
const good = JSON.stringify({ ecc: { version: ECC_CATALOG_INDEX_VERSION, sha: ECC_CATALOG_INDEX_SHA }, entries: [
  { id: 'ecc:skill:tdd-workflow', kind: 'skill', name: 'tdd-workflow', description: 'Tests first', requires: { shell: true }, executableInScope: { read: true }, classificationConfidence: 'high' },
] });

afterEach(() => {
  resetEccCatalogCache();
  electronState.isPackaged = false;
});

describe('the catalog path', () => {
  it('is pinned to the index version, under resources/ in dev and under the app resources when packaged; never ~/.claude', () => {
    expect(ECC_CATALOG_FILE_NAME).toBe(`ecc-${ECC_CATALOG_INDEX_VERSION}.json`);
    const dev = getEccCatalogPath().replace(/\\/g, '/');
    expect(dev).toBe(`${electronState.appPath}/resources/ecc-catalog/${ECC_CATALOG_FILE_NAME}`);
    electronState.isPackaged = true;
    const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
    (process as { resourcesPath?: string }).resourcesPath = 'C:/Program Files/Nimbalyst/resources';
    try {
      const packaged = getEccCatalogPath().replace(/\\/g, '/');
      expect(packaged).toBe(`C:/Program Files/Nimbalyst/resources/ecc-catalog/${ECC_CATALOG_FILE_NAME}`);
      for (const candidate of [dev, packaged]) expect(candidate).not.toMatch(/\.claude/);
    } finally {
      (process as { resourcesPath?: string }).resourcesPath = resourcesPath;
    }
  });

  it('electron-builder ships that folder', () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'packages', 'electron', 'package.json'), 'utf8'));
    const entry = pkg.build.extraResources.find((resource: { from: string }) => resource.from === 'resources/ecc-catalog');
    expect(entry).toEqual({ from: 'resources/ecc-catalog', to: 'ecc-catalog', filter: ['ecc-*.json'] });
  });
});

describe('loading', () => {
  it('a missing file is a clear error, not a fallback', async () => {
    const result = await loadEccCatalog('/nowhere/ecc.json', async () => { throw new Error('ENOENT'); });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/ECC catalog unavailable: .*could not be read \(ENOENT\).*no other copy is consulted/) });
    const tool = await eccCatalogLookupTool({ ids: ['skill:tdd-workflow'] }, () => loadEccCatalog('/nowhere/ecc.json', async () => { throw new Error('ENOENT'); }));
    expect(tool).toEqual({ error: expect.stringMatching(/ECC catalog unavailable/) });
  });

  it('a corrupted file is a clear error: bad JSON, wrong shape, another version', async () => {
    expect(await loadEccCatalog('/c/ecc.json', async () => '{not json')).toMatchObject({ ok: false, error: expect.stringMatching(/not valid JSON/) });
    expect(await loadEccCatalog('/c/ecc.json', async () => '{"entries":[]}')).toMatchObject({ ok: false, error: expect.stringMatching(/missing ecc.version/) });
    const other = JSON.stringify({ ecc: { version: '9.9.9', sha: 'other' }, entries: [{ id: 'ecc:skill:x', kind: 'skill', name: 'x' }] });
    expect(await loadEccCatalog('/c/ecc.json', async () => other)).toMatchObject({ ok: false, error: expect.stringMatching(/version 9\.9\.9 .* packaged index was generated from version/) });
  });

  it('a valid file is read once and cached; a failure is never cached', async () => {
    const reads = vi.fn(async () => good);
    const first = await loadEccCatalog('/c/ecc.json', reads);
    expect(first.ok).toBe(true);
    const second = await loadEccCatalog('/c/ecc.json', reads);
    expect(second.ok).toBe(true);
    expect(reads).toHaveBeenCalledTimes(1);
    resetEccCatalogCache();
    const failing = vi.fn(async () => '{');
    expect((await loadEccCatalog('/c/ecc.json', failing)).ok).toBe(false);
    expect((await loadEccCatalog('/c/ecc.json', failing)).ok).toBe(false);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('the tool answers from the loaded catalog with the version it came from', async () => {
    const result = await eccCatalogLookupTool({ ids: ['skill:tdd-workflow'] }, () => loadEccCatalog('/c/ecc.json', async () => good));
    if ('error' in result) throw new Error(result.error);
    expect(result.catalog).toEqual({ version: ECC_CATALOG_INDEX_VERSION, sha: ECC_CATALOG_INDEX_SHA });
    expect(result.matches.map((m) => m.id)).toEqual(['ecc:skill:tdd-workflow']);
    expect(result.matches[0].class).toBe('A');
    expect(await eccCatalogLookupTool(undefined, () => loadEccCatalog('/c/ecc.json', async () => good))).toEqual({ error: expect.stringMatching(/needs ids/) });
  });

  it('the packaged file loads through the real reader', async () => {
    if (!existsSync(packagedCatalog)) throw new Error(`packaged catalog missing: ${packagedCatalog}`);
    const result = await loadEccCatalog(packagedCatalog);
    if (!result.ok) throw new Error(result.error);
    expect(result.catalog.entries.length).toBeGreaterThan(400);
  });
});
