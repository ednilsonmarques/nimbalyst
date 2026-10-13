import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  LISTED_CLASSES,
  buildIndex,
  classifyByRule,
  classifyEntry,
  renderIndexModule,
  renderIndexText,
  run,
  summarize,
} from '../ecc-architect-index-build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const catalogPath = path.join(repoRoot, 'packages', 'electron', 'resources', 'ecc-catalog', 'ecc-2.2.3.json');
const classesPath = path.join(repoRoot, 'scripts', 'ecc-architect-classes.json');
const generatedPath = path.join(repoRoot, 'packages', 'runtime', 'src', 'ai', 'ecc', 'eccCatalogIndex.generated.ts');
const normalizeEol = (text) => text.replace(/\r\n/g, '\n');

const entry = (id, over = {}) => ({
  id,
  kind: id.split(':')[1],
  name: id.split(':')[2],
  description: `Description of ${id} with more than eight words in it, truly.`,
  mechanics: 'instruction',
  classificationConfidence: 'high',
  requires: { shell: false, inlineExec: false, fork: false, mcp: [], network: false, writes: false, scripts: false },
  executableInScope: { read: false, review: false, write: false, full: true },
  ...over,
});

test('rule: hooks and memory are D, no-signal entries are unlisted, read content is A, mcp/network/fork are C, instruction with shell or writes is B, the rest is E', () => {
  assert.equal(classifyByRule(entry('ecc:hook:pre:x', { kind: 'hook', mechanics: 'hook' })), 'D');
  assert.equal(classifyByRule(entry('ecc:skill:memory', { mechanics: 'memory' })), 'D');
  assert.equal(classifyByRule(entry('ecc:skill:blank', { classificationConfidence: 'low' })), 'low');
  assert.equal(classifyByRule(entry('ecc:skill:method', { executableInScope: { read: true, review: true, write: true, full: true } })), 'A');
  // Read-executable content that still needs an MCP server, network or sub-agents is C by rule; only the overlay can say A.
  assert.equal(classifyByRule(entry('ecc:skill:read-mcp', { executableInScope: { read: true }, requires: { mcp: ['github'] } })), 'C');
  assert.equal(classifyByRule(entry('ecc:skill:read-fork', { executableInScope: { read: true }, requires: { fork: true } })), 'C');
  assert.equal(classifyByRule(entry('ecc:skill:read-net', { executableInScope: { read: true }, requires: { network: true } })), 'C');
  assert.equal(classifyByRule(entry('ecc:skill:read-shell', { executableInScope: { read: true }, requires: { shell: true, writes: true } })), 'A');
  assert.equal(classifyByRule(entry('ecc:skill:mcp', { requires: { mcp: ['context7'] } })), 'C');
  assert.equal(classifyByRule(entry('ecc:skill:net', { requires: { network: true } })), 'C');
  assert.equal(classifyByRule(entry('ecc:skill:fork', { requires: { fork: true } })), 'C');
  assert.equal(classifyByRule(entry('ecc:skill:shell', { requires: { shell: true } })), 'B');
  assert.equal(classifyByRule(entry('ecc:command:writes', { requires: { writes: true } })), 'B');
  assert.equal(classifyByRule(entry('ecc:skill:script', { mechanics: 'script', requires: { shell: true } })), 'E');
  assert.equal(classifyByRule(entry('ecc:agent:shelly', { mechanics: 'agent', requires: { shell: true } })), 'E');
  assert.equal(classifyByRule(entry('ecc:skill:nothing')), 'E');
});

test('the overlay wins over the rule and refuses an unknown class', () => {
  const e = entry('ecc:agent:code-reviewer', { mechanics: 'agent', requires: { shell: true } });
  assert.equal(classifyEntry(e, {}), 'E');
  assert.equal(classifyEntry(e, { classes: { 'ecc:agent:code-reviewer': { class: 'B' } } }), 'B');
  assert.equal(classifyEntry(entry('ecc:skill:x', { executableInScope: { read: true } }), { classes: { 'ecc:skill:x': { class: 'D' } } }), 'D');
  assert.throws(() => classifyEntry(e, { classes: { 'ecc:agent:code-reviewer': { class: 'Z' } } }), /Classe inválida/);
});

test('the index lists only A, B and C, sorted by class then id, with eight-word summaries and counts for everything else', () => {
  const catalog = {
    ecc: { version: '9.9.9', sha: 'abc' },
    entries: [
      entry('ecc:skill:zeta', { requires: { shell: true } }),
      entry('ecc:skill:alpha', { executableInScope: { read: true, review: true, write: true, full: true } }),
      entry('ecc:hook:h', { kind: 'hook', mechanics: 'hook' }),
      entry('ecc:skill:low', { classificationConfidence: 'low' }),
      entry('ecc:skill:mcp', { requires: { mcp: ['exa'] } }),
      entry('ecc:skill:script', { mechanics: 'script', requires: { shell: true } }),
    ],
  };
  const index = buildIndex(catalog, { classes: { 'ecc:skill:ghost': { class: 'A' } } });
  assert.deepEqual(index.listed.map((item) => [item.id, item.class]), [
    ['ecc:skill:alpha', 'A'],
    ['ecc:skill:zeta', 'B'],
    ['ecc:skill:mcp', 'C'],
  ]);
  assert.deepEqual(index.counts, { A: 1, B: 1, C: 1, D: 1, E: 1, low: 1 });
  assert.deepEqual(index.unknownOverrides, ['ecc:skill:ghost']);
  assert.equal(index.listed[0].summary, 'Description of ecc:skill:alpha with more than eight words');
  assert.equal(summarize('  one two.  '), 'one two');
  for (const item of index.listed) assert.ok(LISTED_CLASSES.includes(item.class));
  const text = renderIndexText(index);
  assert.match(text, /^ECC 9\.9\.9 capability index \(6 entries; 3 listed\)/);
  assert.match(text, /1 entries without classification signals, 1 hooks, memory and orchestration entries, 1 mutable-only entries/);
  assert.match(text, /\nA skill:alpha \(R\/Rv\/W\/F\) - Description of/);
  assert.doesNotMatch(text, /skill:low|hook:h|skill:script/);
});

test('the generated module is valid as a template literal: backticks and ${ in summaries are escaped', () => {
  const catalog = { ecc: { version: '1.0.0', sha: 's' }, entries: [entry('ecc:skill:tricky', { description: 'Uses `code` and ${vars} and \\ slashes here now', requires: { shell: true } })] };
  const module = renderIndexModule(buildIndex(catalog, {}), { catalog: 'c.json', classes: 'k.json' });
  assert.match(module, /\\`code\\`/);
  assert.match(module, /\\\$\{vars\}/);
  assert.match(module, /export const ECC_CATALOG_INDEX_CLASSES: Readonly<Record<string, 'A' \| 'B' \| 'C'>> = Object\.freeze\(\{\n  "ecc:skill:tricky": "B",\n\}\);/);
  // Evaluating the literal gives back the rendered text, byte for byte.
  const literal = module.slice(module.indexOf('ECC_CATALOG_INDEX_TEXT = `') + 'ECC_CATALOG_INDEX_TEXT = '.length).trimEnd().replace(/;$/, '');
  assert.equal(new Function(`return ${literal};`)(), renderIndexText(buildIndex(catalog, {})));
});

test('run writes exactly one file, the --out module', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ecc-index-'));
  try {
    const catalog = { ecc: { version: '1.2.3', sha: 'deadbeef' }, entries: [entry('ecc:skill:a', { executableInScope: { read: true } })] };
    writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(catalog));
    writeFileSync(path.join(dir, 'classes.json'), JSON.stringify({ classes: {} }));
    const out = path.join(dir, 'out', 'index.generated.ts');
    const result = run(['--catalog', path.join(dir, 'catalog.json'), '--classes', path.join(dir, 'classes.json'), '--out', out], { warn: () => {} });
    assert.equal(result.outPath, out);
    assert.deepEqual(readdirSync(path.join(dir, 'out')), ['index.generated.ts']);
    assert.deepEqual(readdirSync(dir).sort(), ['catalog.json', 'classes.json', 'out']);
    assert.match(readFileSync(out, 'utf8'), /ECC_CATALOG_INDEX_VERSION = "1\.2\.3"/);
    assert.throws(() => run(['--catalog', path.join(dir, 'catalog.json'), '--out', path.join(dir, 'x.js')]), /deve ser um arquivo \.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('regeneration from the committed catalog and overlay is identical to the committed module, and every overlay id exists', (t) => {
  if (!existsSync(catalogPath) || !existsSync(classesPath) || !existsSync(generatedPath)) return t.skip('catálogo, overlay ou módulo gerado ausente');
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const overlay = JSON.parse(readFileSync(classesPath, 'utf8'));
  const index = buildIndex(catalog, overlay);
  assert.deepEqual(index.unknownOverrides, [], 'overlay cita ids que não existem no catálogo');
  const fresh = renderIndexModule(index, {
    catalog: 'packages/electron/resources/ecc-catalog/ecc-2.2.3.json',
    classes: 'scripts/ecc-architect-classes.json',
  });
  assert.equal(normalizeEol(fresh), normalizeEol(readFileSync(generatedPath, 'utf8')));
  // The listed set is the manifest validator's citable set: never a low-confidence or mutable-only entry.
  for (const item of index.listed) {
    const source = catalog.entries.find((e) => e.id === item.id);
    assert.notEqual(source.classificationConfidence, 'low', item.id);
    assert.notEqual(source.kind, 'hook', item.id);
    assert.notEqual(source.mechanics, 'memory', item.id);
  }
  // Orchestration engines and executing commands never reach the index, whatever the heuristics say.
  for (const id of ['ecc:command:feature-dev', 'ecc:skill:orch-add-feature', 'ecc:skill:plan-canvas', 'ecc:skill:repo-scan', 'ecc:skill:continuous-learning-v2', 'ecc:skill:unified-memory', 'ecc:workflow:orch-review']) {
    assert.ok(!index.listed.some((item) => item.id === id), `${id} listado`);
  }
  // The methodological core is there.
  for (const id of ['ecc:agent:planner', 'ecc:agent:architect', 'ecc:skill:intent-driven-development', 'ecc:skill:architecture-decision-records', 'ecc:skill:tdd-workflow', 'ecc:skill:contract-first', 'ecc:skill:mcp-dependency-review']) {
    assert.equal(index.listed.find((item) => item.id === id)?.class, 'A', id);
  }
  assert.equal(index.listed.find((item) => item.id === 'ecc:agent:code-reviewer')?.class, 'B');
  assert.equal(index.listed.find((item) => item.id === 'ecc:skill:council')?.class, 'C');
  // Sub-agents plus an MCP server: search-first is C, whatever its read flag says.
  assert.equal(index.listed.find((item) => item.id === 'ecc:skill:search-first')?.class, 'C');
  // Every A entry whose heuristics flag an MCP server, network, sub-agents, shell or writes is a written-down human decision in the overlay.
  for (const item of index.listed.filter((i) => i.class === 'A')) {
    const source = catalog.entries.find((e) => e.id === item.id);
    const r = source.requires ?? {};
    const flagged = (Array.isArray(r.mcp) && r.mcp.length > 0) || r.network === true || r.fork === true || r.shell === true || r.writes === true;
    if (flagged) assert.equal(overlay.classes?.[item.id]?.class, 'A', `${item.id} é A por heurística apesar de pedir MCP, rede, subagentes, shell ou escrita: decida no overlay`);
  }
  // Model-selection guidance and hookify helpers never reach the architect.
  for (const id of ['ecc:method:performance', 'ecc:agent:conversation-analyzer']) {
    assert.equal(index.listed.find((item) => item.id === id), undefined, id);
  }
});
