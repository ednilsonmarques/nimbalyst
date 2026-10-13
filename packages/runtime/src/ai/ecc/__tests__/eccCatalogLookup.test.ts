// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ECC_LOOKUP_DEFAULT_LIMIT,
  ECC_LOOKUP_DESCRIPTION_MAX_CHARS,
  ECC_LOOKUP_MAX_LIMIT,
  ECC_LOOKUP_NOTE,
  clampEccLookupLimit,
  lookupEccCatalog,
  normalizeEccId,
  truncateEccDescription,
  validateEccCatalog,
  type EccCatalogDocument,
} from '../eccCatalogLookup';
import {
  ECC_CATALOG_INDEX_ALL_CLASSES,
  ECC_CATALOG_INDEX_CLASSES,
  ECC_CATALOG_INDEX_NOTES,
  ECC_CATALOG_INDEX_SHA,
  ECC_CATALOG_INDEX_VERSION,
} from '../eccCatalogIndex.generated';
import { isToolDeniedForScope, toolScopeDeniedTools } from '../../server/providers/claudeCode/toolPolicy';

const expected = { version: '2.2.3', sha: 'deadbeefcafe' };
const catalog: EccCatalogDocument = {
  ecc: { ...expected },
  entries: [
    {
      id: 'ecc:skill:tdd-workflow', kind: 'skill', name: 'tdd-workflow',
      description: 'Test-driven development workflow: write a failing test first, watch it fail, implement the smallest change to green. '.repeat(4),
      category: 'workflow-quality',
      requires: { shell: true, network: true, mcp: [], fork: false, writes: false },
      executableInScope: { read: true, review: true, write: true, full: true },
      classificationConfidence: 'high', overridden: true,
    },
    {
      id: 'ecc:skill:exa-search', kind: 'skill', name: 'exa-search', description: 'Search the web through the Exa MCP server',
      requires: { mcp: ['exa'], network: true }, executableInScope: { read: false, review: false, write: false, full: true },
      classificationConfidence: 'high',
    },
    {
      id: 'ecc:hook:lint', kind: 'hook', name: 'lint', description: 'Runs the linter after every edit',
      requires: { shell: true, writes: true }, executableInScope: { full: true }, classificationConfidence: 'high',
    },
    { id: 'ecc:skill:mystery', kind: 'skill', name: 'mystery', description: 'No signals here', classificationConfidence: 'low' },
    ...Array.from({ length: 10 }, (_, index) => ({
      id: `ecc:command:suite-${index}`, kind: 'command', name: `suite-${index}`,
      description: `Runs the test suite number ${index} for testing`, classificationConfidence: 'high',
    })),
  ],
};
const classes = { 'ecc:skill:tdd-workflow': 'A', 'ecc:skill:exa-search': 'C', 'ecc:hook:lint': 'D', 'ecc:skill:mystery': 'low' };
const notes = { 'ecc:skill:tdd-workflow': 'method the architect applies itself' };
const lookup = (args: Record<string, unknown>) => lookupEccCatalog(catalog, args, classes, notes);

describe('validateEccCatalog', () => {
  it('accepts the pinned version and refuses anything else, clearly', () => {
    expect(validateEccCatalog(catalog, expected)).toEqual({ ok: true, catalog });
    expect(validateEccCatalog(null, expected)).toMatchObject({ ok: false, error: expect.stringMatching(/not a JSON object/) });
    expect(validateEccCatalog({ entries: [] }, expected)).toMatchObject({ ok: false, error: expect.stringMatching(/missing ecc.version/) });
    expect(validateEccCatalog({ ...catalog, ecc: { version: '2.3.0', sha: 'other' } }, expected))
      .toMatchObject({ ok: false, error: expect.stringMatching(/version 2\.3\.0 .*packaged index was generated from version 2\.2\.3/) });
    expect(validateEccCatalog({ ...catalog, entries: [] }, expected)).toMatchObject({ ok: false, error: expect.stringMatching(/no entries/) });
    expect(validateEccCatalog({ ...catalog, entries: [{ id: 'skill:x' }] }, expected)).toMatchObject({ ok: false, error: expect.stringMatching(/entry 0 has no id, kind or name/) });
  });
});

describe('lookup by id', () => {
  it('answers exact ids with or without the ecc: prefix, once each, and names the unknown ones', () => {
    const result = lookup({ ids: ['skill:tdd-workflow', 'ecc:skill:tdd-workflow', 'ecc:skill:nope', ' ecc:skill:exa-search '] });
    if ('error' in result) throw new Error(result.error);
    expect(result.catalog).toEqual(expected);
    expect(result.matches.map((m) => m.id)).toEqual(['ecc:skill:tdd-workflow', 'ecc:skill:exa-search']);
    expect(result.unknownIds).toEqual(['ecc:skill:nope']);
    expect(result.truncated).toBe(false);
    expect(result.note).toBe(ECC_LOOKUP_NOTE);
    expect(normalizeEccId(' skill:x ')).toBe('ecc:skill:x');
  });

  it('returns the compact facts: class, citability, requirements, scopes, confidence, override and note', () => {
    const result = lookup({ ids: ['ecc:skill:tdd-workflow', 'ecc:skill:exa-search', 'ecc:hook:lint', 'ecc:skill:mystery'] });
    if ('error' in result) throw new Error(result.error);
    const [tdd, exa, hook, mystery] = result.matches;
    expect(tdd).toMatchObject({
      kind: 'skill', name: 'tdd-workflow', class: 'A', citable: true,
      requires: { shell: true, writes: false, network: true, mcp: [], fork: false },
      executableInScope: { read: true, review: true, write: true, full: true },
      confidence: 'high', override: true, note: 'method the architect applies itself',
    });
    expect(tdd.description.length).toBeLessThanOrEqual(ECC_LOOKUP_DESCRIPTION_MAX_CHARS);
    expect(tdd.description.endsWith('…')).toBe(true);
    expect(exa).toMatchObject({ class: 'C', citable: true, requires: { mcp: ['exa'], network: true, shell: false }, executableInScope: { read: false, full: true }, override: false });
    expect(exa.note).toBeUndefined();
    expect(hook).toMatchObject({ class: 'D', citable: false });
    expect(mystery).toMatchObject({ class: null, citable: false, confidence: 'low' });
    expect(truncateEccDescription('  a  b  ', 5)).toBe('a b');
  });
});

describe('lookup by query', () => {
  it('ranks name matches first and cuts at the limit, saying so', () => {
    const tdd = lookup({ query: 'tdd workflow' });
    if ('error' in tdd) throw new Error(tdd.error);
    expect(tdd.matches[0].id).toBe('ecc:skill:tdd-workflow');
    const suites = lookup({ query: 'test suite' });
    if ('error' in suites) throw new Error(suites.error);
    expect(suites.matches).toHaveLength(ECC_LOOKUP_DEFAULT_LIMIT);
    expect(suites.truncated).toBe(true);
    const capped = lookup({ query: 'test suite', limit: 50 });
    if ('error' in capped) throw new Error(capped.error);
    expect(capped.matches).toHaveLength(ECC_LOOKUP_MAX_LIMIT);
    expect(clampEccLookupLimit(0)).toBe(ECC_LOOKUP_DEFAULT_LIMIT);
    expect(clampEccLookupLimit('x')).toBe(ECC_LOOKUP_DEFAULT_LIMIT);
    expect(clampEccLookupLimit('3')).toBe(3);
    expect(clampEccLookupLimit(99)).toBe(ECC_LOOKUP_MAX_LIMIT);
  });

  it('ids and a query combine without duplicates; nothing to look up is an error', () => {
    const both = lookup({ ids: ['ecc:skill:exa-search'], query: 'exa', limit: 8 });
    if ('error' in both) throw new Error(both.error);
    expect(both.matches.map((m) => m.id)).toEqual(['ecc:skill:exa-search']);
    expect(lookup({})).toEqual({ error: expect.stringMatching(/needs ids .* or a query/) });
    expect(lookup({ query: 'a' })).toEqual({ error: expect.stringMatching(/needs ids/) });
    expect(lookup({ ids: 'ecc:skill:x' })).toEqual({ error: expect.stringMatching(/needs ids/) });
  });
});

describe('lookup is not authorization', () => {
  it('a lookup result carries no grant, and the scope policy is exactly what it was', () => {
    const result = lookup({ ids: ['ecc:skill:tdd-workflow', 'ecc:skill:exa-search'] });
    if ('error' in result) throw new Error(result.error);
    const text = JSON.stringify(result).toLowerCase();
    for (const word of ['allowed', 'granted', 'permission', 'authorized']) expect(text, word).not.toContain(`"${word}"`);
    // The entry says it needs a shell, the network and an MCP server; a read child still has none of them.
    expect(result.matches[0].requires.shell).toBe(true);
    expect(isToolDeniedForScope('read', 'Bash')).toBe(true);
    expect(isToolDeniedForScope('read', 'WebFetch')).toBe(true);
    expect(isToolDeniedForScope('read', 'mcp__exa__search', ['exa'])).toBe(true);
    expect(isToolDeniedForScope('review', 'mcp__exa__search', ['exa'])).toBe(true);
    expect(isToolDeniedForScope('read', 'mcp__nimbalyst-host__run_project_tests')).toBe(true);
    // executableInScope.full on an entry changes nobody's scope.
    expect(result.matches[1].executableInScope.full).toBe(true);
    expect(toolScopeDeniedTools('read')).toContain('Bash');
  });
});

describe('the packaged catalog', () => {
  const catalogPath = path.resolve(__dirname, '../../../../../electron/resources/ecc-catalog', `ecc-${ECC_CATALOG_INDEX_VERSION}.json`);

  it('is the one the index was generated from, every entry has a class, and the answer stays small', () => {
    if (!existsSync(catalogPath)) throw new Error(`packaged catalog missing: ${catalogPath}`);
    const validation = validateEccCatalog(JSON.parse(readFileSync(catalogPath, 'utf8').replace(/^﻿/, '')));
    if (!validation.ok) throw new Error(validation.error);
    const packaged = validation.catalog;
    expect(packaged.ecc).toEqual({ version: ECC_CATALOG_INDEX_VERSION, sha: ECC_CATALOG_INDEX_SHA, root: expect.any(String) });
    expect(packaged.entries.length).toBeGreaterThan(400);
    for (const entry of packaged.entries) expect(ECC_CATALOG_INDEX_ALL_CLASSES[entry.id], entry.id).toBeDefined();
    // Citable means listed in the architect's index (the validator's set), nothing more.
    const result = lookupEccCatalog(packaged, { ids: ['skill:tdd-workflow', 'agent:code-reviewer', 'ecc:hook:' + packaged.entries.find((e) => e.kind === 'hook')!.name] });
    if ('error' in result) throw new Error(result.error);
    expect(result.matches.length).toBeGreaterThanOrEqual(2);
    for (const match of result.matches) {
      expect(match.citable, match.id).toBe(match.id in ECC_CATALOG_INDEX_CLASSES);
      expect(match.class, match.id).toBe(ECC_CATALOG_INDEX_ALL_CLASSES[match.id] === 'low' ? null : ECC_CATALOG_INDEX_ALL_CLASSES[match.id]);
      if (ECC_CATALOG_INDEX_NOTES[match.id]) expect(match.note).toBe(ECC_CATALOG_INDEX_NOTES[match.id]);
    }
    // The full catalog never travels: a maximal answer is a few kilobytes.
    const maximal = lookupEccCatalog(packaged, { query: 'test', limit: 8 });
    expect(JSON.stringify(maximal).length).toBeLessThan(8_000);
    expect(readFileSync(catalogPath, 'utf8').length).toBeGreaterThan(500_000);
  });
});
