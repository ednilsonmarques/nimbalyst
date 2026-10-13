/**
 * `ecc_catalog_lookup` (Phase 1B of the ECC Architect): the host half.
 *
 * Loads exactly one file, the packaged catalog the architect's index was
 * generated from (`resources/ecc-catalog/ecc-<index version>.json`, shipped
 * through electron-builder `extraResources`), validates it against the index
 * version and commit, and keeps it in memory. A missing or corrupted file is a
 * clear error to the caller; there is no directory scan, no other version, no
 * fallback to an installed ECC plugin and no access to `~/.claude` at runtime:
 * the catalog is passive data built offline (scripts/ecc-catalog-build.mjs).
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { ECC_CATALOG_INDEX_VERSION } from '@nimbalyst/runtime/ai/ecc/eccCatalogIndex.generated';
import {
  lookupEccCatalog,
  validateEccCatalog,
  type EccCatalogDocument,
  type EccCatalogLookupArgs,
  type EccCatalogLookupResult,
} from '@nimbalyst/runtime/ai/ecc/eccCatalogLookup';
import { getPackageRoot } from '../../utils/appPaths';

export const ECC_CATALOG_FILE_NAME = `ecc-${ECC_CATALOG_INDEX_VERSION}.json`;

/** The only path the lookup reads: packaged under resources/, or the package's resources/ folder in dev. */
export function getEccCatalogPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'ecc-catalog', ECC_CATALOG_FILE_NAME);
  }
  return path.join(getPackageRoot(), 'resources', 'ecc-catalog', ECC_CATALOG_FILE_NAME);
}

export type EccCatalogLoad =
  | { ok: true; catalog: EccCatalogDocument; path: string }
  | { ok: false; error: string; path: string };

let cached: { path: string; catalog: EccCatalogDocument } | null = null;

export function resetEccCatalogCache(): void {
  cached = null;
}

/** Load (once) and validate the packaged catalog. Only a successful load is cached. */
export async function loadEccCatalog(
  catalogPath: string = getEccCatalogPath(),
  readFile: (file: string) => Promise<string> = (file) => fs.promises.readFile(file, 'utf8'),
): Promise<EccCatalogLoad> {
  if (cached && cached.path === catalogPath) return { ok: true, catalog: cached.catalog, path: catalogPath };
  let text: string;
  try {
    text = await readFile(catalogPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      path: catalogPath,
      error: `ECC catalog unavailable: ${ECC_CATALOG_FILE_NAME} could not be read (${message}). ` +
        'Nimbalyst ships the catalog with the app; no other copy is consulted.',
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, path: catalogPath, error: `ECC catalog is corrupted: ${ECC_CATALOG_FILE_NAME} is not valid JSON (${message}).` };
  }
  const validation = validateEccCatalog(parsed);
  if (!validation.ok) return { ok: false, path: catalogPath, error: validation.error };
  cached = { path: catalogPath, catalog: validation.catalog };
  return { ok: true, catalog: validation.catalog, path: catalogPath };
}

/** The tool: load the catalog and answer; a load failure is the tool's (clear) answer. */
export async function eccCatalogLookupTool(
  args: EccCatalogLookupArgs | undefined,
  load: () => Promise<EccCatalogLoad> = () => loadEccCatalog(),
): Promise<EccCatalogLookupResult> {
  const loaded = await load();
  if (!loaded.ok) return { error: loaded.error };
  return lookupEccCatalog(loaded.catalog, args ?? {});
}
