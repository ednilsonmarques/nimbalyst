#!/usr/bin/env node
/**
 * ECC Architect capability index (Phase 1A).
 *
 * Reads the COMMITTED passive catalog (packages/electron/resources/ecc-catalog/
 * ecc-<version>.json) and the class overlay (scripts/ecc-architect-classes.json),
 * and writes ONE TypeScript module with a static constant the architect member
 * reads in its system prompt. The catalog builder is untouched: this script is
 * the catalog's only consumer, and it is just as passive (text in, text out; no
 * ECC code is imported, executed or evaluated; no network).
 *
 *   node scripts/ecc-architect-index-build.mjs
 *   node scripts/ecc-architect-index-build.mjs --catalog <file> --classes <file> --out <file>
 *
 * Classes (the overlay wins over the rule):
 *   A  method the architect applies itself: content executable in a read scope
 *      that needs no MCP server, network or sub-agents. A read-executable entry
 *      whose heuristics flag one of those is C unless the overlay says A: the
 *      human decision is then written down, with its reason, in the overlay.
 *   B  recommendable to an executor role within that role's scope: pure
 *      instruction that needs shell or writes to be carried out.
 *   C  needs an authorization the team does not have by default: an MCP server,
 *      network or sub-agents (council, dev-team: real sessions in Nimbalyst).
 *   D  incompatible with the architect: hooks, memory, orchestration engines,
 *      external runtimes. Never listed.
 *   E  mutable or operational only (scripts, resolvers, agents with shell or
 *      writes). Never listed.
 *   Entries without classification signals (`classificationConfidence: "low"`)
 *   are never listed either: unknown is not safe.
 *
 * Only A, B and C appear in the index, sorted by class then id, with the first
 * eight words of the description. Deterministic output.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const INDEX_CLASSES = Object.freeze(['A', 'B', 'C', 'D', 'E']);
export const LISTED_CLASSES = Object.freeze(['A', 'B', 'C']);
const SUMMARY_WORDS = 8;

/** Class of one catalog entry by rule alone (the overlay is applied by classifyEntry). */
export function classifyByRule(entry) {
  if (entry.kind === 'hook' || entry.mechanics === 'hook' || entry.mechanics === 'memory') return 'D';
  if (entry.classificationConfidence === 'low') return 'low';
  const requires = entry.requires ?? {};
  const mcp = Array.isArray(requires.mcp) ? requires.mcp : [];
  const needsAuthorization = mcp.length > 0 || requires.network === true || requires.fork === true;
  if (entry.executableInScope?.read === true) return needsAuthorization ? 'C' : 'A';
  if (needsAuthorization) return 'C';
  if (entry.mechanics === 'instruction' && (requires.shell === true || requires.writes === true)) return 'B';
  return 'E';
}

/**
 * Class of one entry: the overlay (`{ classes: { [id]: { class } } }`) wins,
 * otherwise the rule. A low-confidence entry stays unlisted even when the
 * overlay names it, unless the overlay says so explicitly: that is a human
 * decision recorded in the overlay file, not a heuristic.
 */
export function classifyEntry(entry, overlay = {}) {
  const forced = overlay?.classes?.[entry.id]?.class;
  if (forced !== undefined) {
    if (!INDEX_CLASSES.includes(forced)) throw new Error(`Classe inválida no overlay para ${entry.id}: ${JSON.stringify(forced)}`);
    return forced;
  }
  return classifyByRule(entry);
}

export function summarize(description) {
  const words = String(description ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).slice(0, SUMMARY_WORDS);
  return words.join(' ').replace(/[\s,;:.]+$/u, '');
}

function scopeLabel(executableInScope) {
  const s = executableInScope ?? {};
  const parts = [];
  if (s.read) parts.push('R');
  if (s.review) parts.push('Rv');
  if (s.write) parts.push('W');
  if (s.full !== false) parts.push('F');
  return parts.join('/') || '-';
}

/**
 * Build the index from a parsed catalog JSON and the overlay. Pure.
 * Returns the listed entries, the counts per class and the overlay ids that
 * matched nothing (warnings for the caller; the index itself is unaffected).
 */
export function buildIndex(catalog, overlay = {}) {
  const entries = Array.isArray(catalog?.entries) ? catalog.entries : [];
  const counts = { A: 0, B: 0, C: 0, D: 0, E: 0, low: 0 };
  const listed = [];
  const ids = new Set(entries.map((e) => e.id));
  for (const entry of entries) {
    const cls = classifyEntry(entry, overlay);
    counts[cls] += 1;
    if (!LISTED_CLASSES.includes(cls)) continue;
    listed.push({
      id: entry.id,
      class: cls,
      kind: entry.kind,
      name: entry.name,
      scopes: scopeLabel(entry.executableInScope),
      summary: summarize(entry.description),
    });
  }
  listed.sort((a, b) => (a.class === b.class ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.class < b.class ? -1 : 1));
  const unknownOverrides = Object.keys(overlay?.classes ?? {}).filter((id) => !ids.has(id)).sort();
  return {
    version: String(catalog?.ecc?.version ?? 'unknown'),
    sha: String(catalog?.ecc?.sha ?? 'unknown'),
    total: entries.length,
    counts,
    listed,
    unknownOverrides,
  };
}

/** The index as the architect reads it. English, like the rest of the system prompt. */
export function renderIndexText(index) {
  const c = index.counts;
  const lines = [];
  lines.push(
    `ECC ${index.version} capability index (${index.total} entries; ${index.listed.length} listed). ` +
    'Classes: A = a method you apply yourself (read-only content); ' +
    "B = recommend to an executor role, within that role's scope; " +
    'C = needs an authorization the team does not have by default (an MCP server, network access or sub-agents): list it under mcpRecommended or openQuestions, never as granted. ' +
    `Not listed and never to be cited: ${c.low} entries without classification signals, ${c.D} hooks, memory and orchestration entries, ${c.E} mutable-only entries. ` +
    'Each line: class kind:name (scopes R/Rv/W/F) - summary.',
  );
  for (const item of index.listed) {
    const shortId = item.id.replace(/^ecc:/, '');
    lines.push(`${item.class} ${shortId} (${item.scopes}) - ${item.summary}`);
  }
  return lines.join('\n');
}

function escapeTemplate(text) {
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/** The generated TypeScript module. */
export function renderIndexModule(index, sources) {
  const classes = index.listed.map((item) => `  ${JSON.stringify(item.id)}: ${JSON.stringify(item.class)},`).join('\n');
  return `/* eslint-disable */
// Generated by scripts/ecc-architect-index-build.mjs from ${sources.catalog} and ${sources.classes}.
// Do not edit by hand: regenerate with \`node scripts/ecc-architect-index-build.mjs\`.
// Static per ECC version, so the architect's system prompt stays byte-stable for the prompt cache.

/** ECC version the index was built from. */
export const ECC_CATALOG_INDEX_VERSION = ${JSON.stringify(index.version)};

/** Git commit of that ECC version. */
export const ECC_CATALOG_INDEX_SHA = ${JSON.stringify(index.sha)};

/**
 * Catalog ids an architect may cite in a Tool Manifest, with their class:
 * A = method it applies, B = recommendable to an executor role, C = needs an
 * authorization the team does not have by default. Anything else in the catalog
 * (hooks, memory, orchestration engines, mutable-only entries, entries without
 * classification signals) is absent on purpose and is refused by the manifest validator.
 */
export const ECC_CATALOG_INDEX_CLASSES: Readonly<Record<string, 'A' | 'B' | 'C'>> = Object.freeze({
${classes}
});

/** The index as the architect reads it in its system prompt. */
export const ECC_CATALOG_INDEX_TEXT = \`${escapeTemplate(renderIndexText(index))}\`;
`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Argumento sem valor: ${arg}`);
      return argv[i];
    };
    if (arg === '--catalog') out.catalog = take();
    else if (arg === '--classes') out.classes = take();
    else if (arg === '--out') out.out = take();
    else throw new Error(`Argumento desconhecido: ${arg}`);
  }
  return out;
}

export function defaultPaths(repoRoot) {
  const catalogDir = path.join(repoRoot, 'packages', 'electron', 'resources', 'ecc-catalog');
  const catalogs = fs.existsSync(catalogDir)
    ? fs.readdirSync(catalogDir).filter((name) => /^ecc-[0-9A-Za-z][0-9A-Za-z.+-]*\.json$/.test(name)).sort()
    : [];
  return {
    catalog: catalogs.length ? path.join(catalogDir, catalogs[catalogs.length - 1]) : path.join(catalogDir, 'ecc-2.2.3.json'),
    classes: path.join(repoRoot, 'scripts', 'ecc-architect-classes.json'),
    out: path.join(repoRoot, 'packages', 'runtime', 'src', 'ai', 'ecc', 'eccCatalogIndex.generated.ts'),
  };
}

/** Build and write the module; writes exactly one file (`--out`). */
export function run(argv, { warn = (message) => console.warn(`ecc-architect-index-build: ${message}`) } = {}) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..');
  const args = parseArgs(argv);
  const defaults = defaultPaths(repoRoot);
  const catalogPath = path.resolve(args.catalog ?? defaults.catalog);
  const classesPath = path.resolve(args.classes ?? defaults.classes);
  const outPath = path.resolve(args.out ?? defaults.out);
  if (!outPath.endsWith('.ts')) throw new Error(`--out deve ser um arquivo .ts: ${outPath}`);
  const catalog = readJson(catalogPath);
  const overlay = fs.existsSync(classesPath) ? readJson(classesPath) : {};
  const index = buildIndex(catalog, overlay);
  for (const id of index.unknownOverrides) warn(`override sem entrada no catálogo: ${id}`);
  const sources = {
    catalog: path.relative(repoRoot, catalogPath).split(path.sep).join('/'),
    classes: path.relative(repoRoot, classesPath).split(path.sep).join('/'),
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, renderIndexModule(index, sources), 'utf8');
  return { outPath, index };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { outPath, index } = run(process.argv.slice(2));
    console.log(`Índice ECC Architect gerado em ${outPath}`);
    console.log(`versão=${index.version} entradas=${index.total} listadas=${index.listed.length} classes=${JSON.stringify(index.counts)}`);
  } catch (error) {
    console.error(`ecc-architect-index-build: ${error.message}`);
    process.exitCode = 1;
  }
}
