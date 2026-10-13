/**
 * `ecc_catalog_lookup` (Phase 1B of the ECC Architect): the pure half.
 *
 * The architect's system prompt carries only the capability index (ids,
 * classes, eight-word summaries). This module answers a lookup by id or by
 * query against the packaged, versioned catalog with the passive facts the
 * catalog builder recorded: kind, name, a short description, the class, the
 * requirements (shell, writes, network, MCP servers, sub-agents), the scopes
 * the entry's content is executable in, and the classification confidence.
 *
 * Lookup only. Nothing here runs, installs, authorizes or widens anything: a
 * requirement is a fact about the entry, never a permission; executableInScope
 * describes the entry's content, never the caller's tools. The host half
 * (electron services/ecc/eccCatalogService.ts) loads exactly the catalog file
 * the index was generated from and fails clearly when it is missing or
 * corrupted; no other copy of ECC is consulted.
 */

import {
  ECC_CATALOG_INDEX_ALL_CLASSES,
  ECC_CATALOG_INDEX_NOTES,
  ECC_CATALOG_INDEX_SHA,
  ECC_CATALOG_INDEX_VERSION,
} from './eccCatalogIndex.generated';

export const ECC_LOOKUP_DEFAULT_LIMIT = 5;
export const ECC_LOOKUP_MAX_LIMIT = 8;
export const ECC_LOOKUP_MAX_IDS = 8;
export const ECC_LOOKUP_DESCRIPTION_MAX_CHARS = 240;
const QUERY_MIN_TOKEN_LENGTH = 2;

export const ECC_LOOKUP_NOTE =
  'Lookup only: nothing here grants a tool, a server, a scope or an execution. ' +
  'requires lists what the entry would need; executableInScope describes its content, not your permissions. ' +
  'Only citable entries (classes A, B, C: the ones in your index) may be cited in a manifest.';

export type EccCatalogClass = 'A' | 'B' | 'C' | 'D' | 'E';
export const ECC_CITABLE_CLASSES: readonly EccCatalogClass[] = ['A', 'B', 'C'];

export interface EccCatalogEntryRequires {
  shell?: boolean;
  inlineExec?: boolean;
  fork?: boolean;
  mcp?: string[];
  network?: boolean;
  writes?: boolean;
  scripts?: boolean;
}

export interface EccCatalogEntryScopes {
  read?: boolean;
  review?: boolean;
  write?: boolean;
  full?: boolean;
}

export interface EccCatalogEntry {
  id: string;
  kind: string;
  name: string;
  description?: string | null;
  category?: string | null;
  mechanics?: string | null;
  requires?: EccCatalogEntryRequires | null;
  executableInScope?: EccCatalogEntryScopes | null;
  classificationConfidence?: string | null;
  overridden?: boolean;
}

export interface EccCatalogDocument {
  schemaVersion?: unknown;
  ecc: { version: string; sha: string };
  entries: EccCatalogEntry[];
}

export type EccCatalogValidation =
  | { ok: true; catalog: EccCatalogDocument }
  | { ok: false; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Structural check of a parsed catalog file, pinned to the version and commit
 * the packaged index was generated from: any other catalog is refused, so the
 * lookup never answers from a different ECC than the architect's index.
 */
export function validateEccCatalog(
  raw: unknown,
  expected: { version: string; sha: string } = { version: ECC_CATALOG_INDEX_VERSION, sha: ECC_CATALOG_INDEX_SHA },
): EccCatalogValidation {
  if (!isRecord(raw)) return { ok: false, error: 'ECC catalog is corrupted: not a JSON object.' };
  const ecc = raw.ecc;
  if (!isRecord(ecc) || typeof ecc.version !== 'string' || typeof ecc.sha !== 'string') {
    return { ok: false, error: 'ECC catalog is corrupted: missing ecc.version or ecc.sha.' };
  }
  if (ecc.version !== expected.version || ecc.sha !== expected.sha) {
    return {
      ok: false,
      error:
        `ECC catalog is version ${ecc.version} (${ecc.sha.slice(0, 12)}) but the packaged index was generated from ` +
        `version ${expected.version} (${expected.sha.slice(0, 12)}); the lookup answers only from that catalog.`,
    };
  }
  const entries = raw.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: false, error: 'ECC catalog is corrupted: no entries.' };
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id.startsWith('ecc:')
      || typeof entry.kind !== 'string' || typeof entry.name !== 'string') {
      return { ok: false, error: `ECC catalog is corrupted: entry ${index} has no id, kind or name.` };
    }
  }
  return { ok: true, catalog: raw as unknown as EccCatalogDocument };
}

export interface EccCatalogLookupArgs {
  ids?: unknown;
  query?: unknown;
  limit?: unknown;
}

export interface EccCatalogMatch {
  id: string;
  kind: string;
  name: string;
  description: string;
  /** A, B, C (citable), D, E; null when the catalog has no classification signals for the entry. */
  class: EccCatalogClass | null;
  /** Whether a manifest may cite the entry (classes A, B and C: the index the architect reads). */
  citable: boolean;
  requires: { shell: boolean; writes: boolean; network: boolean; mcp: string[]; fork: boolean };
  executableInScope: { read: boolean; review: boolean; write: boolean; full: boolean };
  confidence: string;
  /** A human classified this entry by hand (scripts/ecc-architect-classes.json). */
  override: boolean;
  note?: string;
}

export type EccCatalogLookupResult =
  | {
      catalog: { version: string; sha: string };
      matches: EccCatalogMatch[];
      truncated: boolean;
      unknownIds: string[];
      note: string;
    }
  | { error: string };

/** `skill:tdd-workflow` and `ecc:skill:tdd-workflow` name the same entry. */
export function normalizeEccId(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith('ecc:') ? trimmed : `ecc:${trimmed}`;
}

export function clampEccLookupLimit(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value) || value < 1) return ECC_LOOKUP_DEFAULT_LIMIT;
  return Math.min(ECC_LOOKUP_MAX_LIMIT, Math.floor(value));
}

export function truncateEccDescription(description: unknown, max = ECC_LOOKUP_DESCRIPTION_MAX_CHARS): string {
  const text = String(description ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function queryTokens(query: unknown): string[] {
  if (typeof query !== 'string') return [];
  return Array.from(new Set(
    query.toLowerCase().split(/[^a-z0-9+#.-]+/u).map((token) => token.trim()).filter((token) => token.length >= QUERY_MIN_TOKEN_LENGTH),
  ));
}

function scoreEntry(entry: EccCatalogEntry, tokens: string[]): number {
  const id = entry.id.toLowerCase();
  const name = entry.name.toLowerCase();
  const description = String(entry.description ?? '').toLowerCase();
  const category = String(entry.category ?? '').toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (name.includes(token)) score += 3;
    else if (id.includes(token)) score += 2;
    if (description.includes(token)) score += 1;
    if (category.includes(token)) score += 1;
  }
  return score;
}

function toMatch(
  entry: EccCatalogEntry,
  classes: Readonly<Record<string, string>>,
  notes: Readonly<Record<string, string>>,
): EccCatalogMatch {
  const rawClass = classes[entry.id];
  const cls = rawClass === 'A' || rawClass === 'B' || rawClass === 'C' || rawClass === 'D' || rawClass === 'E' ? rawClass : null;
  const requires = entry.requires ?? {};
  const scopes = entry.executableInScope ?? {};
  const match: EccCatalogMatch = {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    description: truncateEccDescription(entry.description),
    class: cls,
    citable: cls !== null && ECC_CITABLE_CLASSES.includes(cls),
    requires: {
      shell: requires.shell === true,
      writes: requires.writes === true,
      network: requires.network === true,
      mcp: Array.isArray(requires.mcp) ? requires.mcp.filter((server): server is string => typeof server === 'string') : [],
      fork: requires.fork === true,
    },
    executableInScope: {
      read: scopes.read === true,
      review: scopes.review === true,
      write: scopes.write === true,
      full: scopes.full === true,
    },
    confidence: typeof entry.classificationConfidence === 'string' ? entry.classificationConfidence : 'unknown',
    override: entry.overridden === true,
  };
  const note = notes[entry.id];
  if (typeof note === 'string' && note.trim()) match.note = note.trim();
  return match;
}

/**
 * Answer a lookup. Ids are exact (with or without the `ecc:` prefix, at most
 * eight); a query is matched by tokens against name, id, description and
 * category, best matches first; the result holds at most `limit` entries
 * (default 5, maximum 8) and says when it was cut. Pure: no I/O, no state.
 */
export function lookupEccCatalog(
  catalog: EccCatalogDocument,
  args: EccCatalogLookupArgs,
  classes: Readonly<Record<string, string>> = ECC_CATALOG_INDEX_ALL_CLASSES,
  notes: Readonly<Record<string, string>> = ECC_CATALOG_INDEX_NOTES,
): EccCatalogLookupResult {
  const rawIds = Array.isArray(args.ids) ? args.ids.filter((id): id is string => typeof id === 'string' && id.trim() !== '') : [];
  const tokens = queryTokens(args.query);
  if (rawIds.length === 0 && tokens.length === 0) {
    return { error: 'ecc_catalog_lookup needs ids (catalog ids, with or without the ecc: prefix) or a query of at least two characters.' };
  }
  const limit = clampEccLookupLimit(args.limit);
  const byId = new Map(catalog.entries.map((entry) => [entry.id, entry] as const));

  const picked: EccCatalogEntry[] = [];
  const seen = new Set<string>();
  const unknownIds: string[] = [];
  let truncated = false;

  const ids = Array.from(new Set(rawIds.map(normalizeEccId)));
  if (ids.length > ECC_LOOKUP_MAX_IDS) truncated = true;
  for (const id of ids.slice(0, ECC_LOOKUP_MAX_IDS)) {
    const entry = byId.get(id);
    if (!entry) {
      unknownIds.push(id);
      continue;
    }
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      picked.push(entry);
    }
  }

  if (tokens.length > 0) {
    const scored = catalog.entries
      .map((entry) => ({ entry, score: scoreEntry(entry, tokens) }))
      .filter((candidate) => candidate.score > 0 && !seen.has(candidate.entry.id))
      .sort((a, b) => b.score - a.score || (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0));
    for (const candidate of scored) {
      seen.add(candidate.entry.id);
      picked.push(candidate.entry);
    }
  }

  if (picked.length > limit) truncated = true;
  return {
    catalog: { version: catalog.ecc.version, sha: catalog.ecc.sha },
    matches: picked.slice(0, limit).map((entry) => toMatch(entry, classes, notes)),
    truncated,
    unknownIds,
    note: ECC_LOOKUP_NOTE,
  };
}
