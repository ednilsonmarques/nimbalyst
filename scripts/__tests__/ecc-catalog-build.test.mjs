import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildCatalog, collectOverrideWarnings, isInside, parseFrontmatter, renderDigest, renderReadme, run } from '../ecc-catalog-build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(here, '..', 'ecc-catalog-build.mjs');
const overridesPath = path.resolve(here, '..', 'ecc-catalog.overrides.json');

function write(root, rel, content) {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

function makeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ecc-catalog-fixture-'));
  const plugin = path.join(root, 'plugin');
  write(plugin, 'agents/reader.md', '---\nname: reader\ndescription: Reads code only.\ntools: Read, Grep, Glob\nmodel: opus\n---\n\nBody.\n');
  write(plugin, 'agents/builder.md', '---\nname: builder\ndescription: "Builds things, with quotes."\ntools: Read, Write, Bash, Task, mcp__context7__query-docs\nmodel: sonnet\ncolor: blue\n---\n\nBody.\n');
  write(plugin, 'agents/runner.md', '---\nname: runner\ndescription: Runs shell commands.\ntools: Read, Bash\nmodel: sonnet\n---\n\nBody.\n');
  write(plugin, 'commands/run-it.md', '---\ndescription: Runs the checks.\n---\n\n# Run it\n\nAsk the agent to run the checks.\n');
  write(plugin, 'agents/blank.md', '---\nname: blank\ndescription: Agent without a tools line.\nmodel: sonnet\n---\n\nBody.\n');
  write(plugin, 'commands/via-blank.md', '---\ndescription: Hands work to the blank agent.\n---\n\n# Via blank\n');
  write(plugin, 'commands/bash-push.md', '---\ndescription: Publishes the branch.\n---\n\n# Publish\n\n```bash\ngit push origin HEAD\n```\n');
  write(plugin, 'skills/script-skill/SKILL.md', '---\nname: script-skill\ndescription: Ships a helper script.\n---\n\n# Script\n\nRead the guidance.\n');
  write(plugin, 'skills/script-skill/scripts/helper.js', 'console.log(1);\n');
  write(plugin, 'skills/exa-skill/SKILL.md', '---\nname: exa-skill\ndescription: Deep research using exa MCP tools and synthesis.\n---\n\n# Research\n\nThink.\n');
  write(plugin, 'skills/save-skill/SKILL.md', '---\nname: save-skill\ndescription: Plans work.\n---\n\n# Plan\n\nSave the plan to docs/plan.md using the Write tool.\n');
  write(plugin, 'skills/spaced-tools/SKILL.md', '---\nname: spaced-tools\ndescription: Space separated tools.\nallowed-tools: Read Bash(npm test)\n---\n\n# Spaced\n');
  write(plugin, 'skills/pure-skill/SKILL.md', '---\nname: pure-skill\ndescription: A pure instruction skill.\nmetadata:\n  origin: ECC\n  version: "1.2.0"\n---\n\n# Pure\n\nThink carefully.\n');
  write(plugin, 'skills/inline-skill/SKILL.md', '---\nname: inline-skill\ndescription: Uses inline exec.\n---\n\nCurrent status:\n!`git status --short`\n');
  write(plugin, 'skills/fork-skill/SKILL.md', '---\nname: fork-skill\ndescription: Runs in a fork.\ncontext: fork\nagent: reader\n---\n\n# Fork\n');
  write(plugin, 'skills/shell-skill/SKILL.md', '---\nname: shell-skill\ndescription: Needs Bash.\nallowed-tools: Bash, Read\n---\n\n# Shell\n');
  write(plugin, 'skills/shell-skill/scripts/run.sh', 'echo hi\n');
  write(plugin, 'commands/delegate.md', '---\ndescription: Delegates to an agent.\nagent: reader\nsubtask: true\nargument-hint: "[topic]"\n---\n\n# Delegate\n');
  write(plugin, 'workflows/demo.workflow.js', "export const meta = {\n  name: 'demo-flow',\n  description: 'Demo workflow.',\n};\n");
  write(plugin, 'workflows/README.md', '# Workflows\n\n## `demo.workflow.js`\n\nDemo workflow from the README.\n');
  write(plugin, 'rules/common/style.md', '# Style Guide\n\nKeep functions small.\n\n## More\n\nStuff.\n');
  write(plugin, 'hooks/hooks.metadata.json', JSON.stringify({ entries: { PreToolUse: [{ id: 'pre:demo', description: 'Demo hook', fingerprint: 'x' }] } }));
  write(plugin, 'docs/COMMAND-REGISTRY.json', JSON.stringify({ commands: [{ command: 'delegate', description: 'Delegates', type: 'workflow', primaryAgents: ['reader'], allAgents: ['reader', 'builder'], skills: ['pure-skill'], path: 'commands/delegate.md' }, { command: 'run-it', description: 'Runs', type: 'testing', primaryAgents: ['runner'], allAgents: ['runner'], skills: [], path: 'commands/run-it.md' }, { command: 'via-blank', description: 'Via blank', type: 'testing', primaryAgents: ['blank'], allAgents: ['blank'], skills: [], path: 'commands/via-blank.md' }] }));
  write(plugin, 'manifests/install-modules.json', JSON.stringify({ modules: [{ id: 'agents-core', kind: 'agents', paths: ['agents'] }, { id: 'quality', kind: 'skills', paths: ['skills/pure-skill', 'skills/fork-skill'] }] }));
  write(root, 'installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'ecc@ecc': [{ installPath: plugin, version: '9.9.9', gitCommitSha: 'abc1234' }] } }));
  write(root, 'overrides.json', JSON.stringify({ 'ecc:skill:pure-skill': { mechanics: 'memory', requires: { network: true }, note: 'teste' }, 'ecc:skill:nao-existe': { note: 'x' } }));
  return { root, plugin, installed: path.join(root, 'installed_plugins.json'), overrides: path.join(root, 'overrides.json') };
}

const quiet = () => {};
const build = (fx, extra = {}) => buildCatalog({ eccRoot: fx.plugin, installedPlugins: fx.installed, warn: quiet, ...extra });
// Checkouts Windows com core.autocrlf=true entregam o artefato em CRLF.
const normalizeEol = (text) => text.replace(/\r\n/g, '\n');
const sameArtifact = (fresh, committed) => normalizeEol(fresh) === normalizeEol(committed);
const byId = (catalog, id) => catalog.json.entries.find((e) => e.id === id);

test('parser de frontmatter lida com aspas, listas, blocos e falhas', () => {
  const parsed = parseFrontmatter('---\nname: x\ndescription: "a: b"\ntags: [a, "b c"]\nallowed-tools:\n  - Read\n  - Bash\nmetadata:\n  origin: ECC\nlong: >\n  um\n  dois\nlixo sem chave\n---\nCorpo\n');
  assert.equal(parsed.data.name, 'x');
  assert.equal(parsed.data.description, 'a: b');
  assert.deepEqual(parsed.data.tags, ['a', 'b c']);
  assert.deepEqual(parsed.data['allowed-tools'], ['Read', 'Bash']);
  assert.deepEqual(parsed.data.metadata, { origin: 'ECC' });
  assert.equal(parsed.data.long, 'um dois');
  assert.equal(parsed.warnings.length, 1);
  assert.equal(parsed.body.trim(), 'Corpo');
  assert.equal(parseFrontmatter('sem frontmatter').hasFrontmatter, false);
});

test('gera entradas com kinds, ids e metadados esperados', () => {
  const fx = makeFixture();
  try {
    const catalog = build(fx, { overrides: fx.overrides });
    const ids = catalog.json.entries.map((e) => e.id);
    assert.deepEqual(ids, [...ids].sort());
    assert.deepEqual(catalog.json.stats.byKind, { agent: 4, command: 4, hook: 1, method: 1, skill: 8, workflow: 1 });
    assert.equal(catalog.json.ecc.version, '9.9.9');
    assert.equal(catalog.json.ecc.sha, 'abc1234');

    const reader = byId(catalog, 'ecc:agent:reader');
    assert.equal(reader.model, 'opus');
    assert.deepEqual(reader.declaredTools, ['Read', 'Grep', 'Glob']);
    assert.equal(reader.mechanics, 'agent');
    assert.equal(reader.category, 'agents-core');
    assert.deepEqual(reader.related.commands, ['delegate']);

    const pure = byId(catalog, 'ecc:skill:pure-skill');
    assert.equal(pure.frontmatter.origin, 'ECC');
    assert.equal(pure.frontmatter.version, '1.2.0');
    assert.equal(pure.category, 'quality');
    assert.deepEqual(pure.related.commands, ['delegate']);

    const wf = byId(catalog, 'ecc:workflow:demo-flow');
    assert.equal(wf.description, 'Demo workflow from the README.');
    assert.equal(byId(catalog, 'ecc:method:style').description, 'Style Guide — Keep functions small.');
    const hook = byId(catalog, 'ecc:hook:pre:demo');
    assert.equal(hook.mechanics, 'hook');
    assert.equal(hook.event, 'PreToolUse');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('flags requires e executableInScope seguem as heurísticas', () => {
  const fx = makeFixture();
  try {
    const catalog = build(fx);
    const builder = byId(catalog, 'ecc:agent:builder');
    assert.equal(builder.requires.shell, true);
    assert.equal(builder.requires.writes, true);
    assert.equal(builder.requires.fork, true);
    assert.deepEqual(builder.requires.mcp, ['context7']);
    assert.deepEqual(builder.executableInScope, { read: false, review: false, write: false, full: true });
    assert.deepEqual(byId(catalog, 'ecc:agent:reader').executableInScope, { read: true, review: true, write: true, full: true });

    const inline = byId(catalog, 'ecc:skill:inline-skill');
    assert.equal(inline.requires.inlineExec, true);
    assert.equal(inline.executableInScope.read, false);
    assert.equal(inline.executableInScope.write, false);

    const fork = byId(catalog, 'ecc:skill:fork-skill');
    assert.equal(fork.requires.fork, true);
    assert.equal(fork.frontmatter.context, 'fork');
    assert.equal(fork.executableInScope.read, false);

    const shell = byId(catalog, 'ecc:skill:shell-skill');
    assert.equal(shell.requires.shell, true);
    assert.equal(shell.requires.scripts, true);
    assert.equal(shell.mechanics, 'script');
    assert.deepEqual(shell.subdirs, ['scripts']);
    assert.equal(shell.executableInScope.read, false);

    const pure = byId(catalog, 'ecc:skill:pure-skill');
    assert.deepEqual(pure.executableInScope, { read: false, review: false, write: false, full: true }, 'sem sinais = não verificada (fail-closed)');
    assert.equal(pure.mechanics, 'instruction');

    const command = byId(catalog, 'ecc:command:delegate');
    assert.equal(command.requires.fork, true);
    assert.equal(command.frontmatter.subtask, true);
    assert.equal(command.frontmatter.agent, 'reader');
    assert.equal(command.frontmatter.argumentHint, '[topic]');
    assert.deepEqual(command.related.agents, ['builder', 'reader']);

    // Delegação: o command não declara Bash, mas aponta para um agent com Bash.
    const runIt = byId(catalog, 'ecc:command:run-it');
    assert.equal(runIt.requires.fork, true);
    assert.equal(runIt.requires.shell, false);
    assert.deepEqual(runIt.executableInScope, { read: false, review: false, write: true, full: true });
    assert.ok(runIt.evidence.includes('delegates to agent runner (tools: Read, Bash)'));
    // Agent que escreve também derruba write.
    assert.equal(byId(catalog, 'ecc:command:delegate').executableInScope.write, false);
    assert.ok(byId(catalog, 'ecc:command:delegate').evidence.includes('delegates to agent builder (tools: Read, Write, Bash, Task, mcp__context7__query-docs)'));

    const hook = byId(catalog, 'ecc:hook:pre:demo');
    assert.deepEqual(hook.executableInScope, { read: false, review: false, write: false, full: false });
    assert.deepEqual(byId(catalog, 'ecc:method:style').executableInScope, { read: true, review: true, write: true, full: true });
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('overrides são aplicados por último e ids desconhecidos viram aviso', () => {
  const fx = makeFixture();
  try {
    const catalog = build(fx, { overrides: fx.overrides });
    const pure = byId(catalog, 'ecc:skill:pure-skill');
    assert.equal(pure.overridden, true);
    assert.equal(pure.mechanics, 'memory');
    assert.equal(pure.requires.network, true);
    assert.equal(pure.executableInScope.read, false, 'escopos são recalculados após override de requires');
    assert.ok(pure.evidence.some((e) => e.startsWith('override:')));
    assert.equal(byId(catalog, 'ecc:skill:fork-skill').overridden, false);
    assert.ok(catalog.json.parseWarnings.some((w) => w.message.includes('ecc:skill:nao-existe')));
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('saída é determinística e só escreve em --out', () => {
  const fx = makeFixture();
  const out = path.join(fx.root, 'out');
  try {
    const a = JSON.stringify(build(fx, { overrides: fx.overrides }).json);
    const b = JSON.stringify(build(fx, { overrides: fx.overrides }).json);
    assert.equal(a, b);
    assert.doesNotMatch(a, /\d{4}-\d{2}-\d{2}T/, 'sem timestamps no JSON');

    run(['--ecc-root', fx.plugin, '--installed-plugins', fx.installed, '--overrides', fx.overrides, '--out', out, '--date', '2026-01-01']);
    const first = readFileSync(path.join(out, 'ecc-9.9.9.json'), 'utf8');
    run(['--ecc-root', fx.plugin, '--installed-plugins', fx.installed, '--overrides', fx.overrides, '--out', out, '--date', '2026-02-02']);
    assert.equal(readFileSync(path.join(out, 'ecc-9.9.9.json'), 'utf8'), first);
    assert.ok(existsSync(path.join(out, 'ecc-9.9.9.md')));
    assert.ok(existsSync(path.join(out, 'README.md')));
    assert.match(readFileSync(path.join(out, 'ecc-9.9.9.md'), 'utf8'), /Gerado em: 2026-02-02/);

    const digest = renderDigest(build(fx), '2026-01-01');
    assert.match(digest, /## Capacidades executáveis em read/);
    assert.match(digest, /\*\*reader\*\* · agent/);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('o script não importa child_process/vm nem faz import() dinâmico', () => {
  const text = readFileSync(scriptPath, 'utf8');
  assert.doesNotMatch(text, /child_process/);
  assert.doesNotMatch(text, /node:vm|from ['"]vm['"]/);
  assert.doesNotMatch(text, /\bimport\s*\(/);
  assert.doesNotMatch(text, /\brequire\s*\(/);
  assert.doesNotMatch(text, /\beval\s*\(|new\s+Function\s*\(/);
  assert.doesNotMatch(text, /\b(?:fetch|XMLHttpRequest)\s*\(|node:(?:http|https|net)/);
  const imports = [...text.matchAll(/^import\s[^;]*?from\s+'([^']+)';/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['node:fs', 'node:os', 'node:path', 'node:url']);
  assert.doesNotMatch(text, /^import\s+'[^']+';/m, 'sem imports de efeito colateral');
});

test('classificação fail-closed: shell em cerca, scripts, MCP na descrição, escrita em prosa e delegação', () => {
  const fx = makeFixture();
  try {
    const catalog = build(fx);

    const push = byId(catalog, 'ecc:command:bash-push');
    assert.equal(push.requires.shell, true);
    assert.equal(push.executableInScope.read, false);
    assert.ok(push.evidence.some((e) => e.startsWith('body: fenced shell block')));

    const script = byId(catalog, 'ecc:skill:script-skill');
    assert.equal(script.requires.scripts, true);
    assert.equal(script.requires.shell, false);
    assert.equal(script.executableInScope.read, false);
    assert.equal(script.executableInScope.review, false);

    const exa = byId(catalog, 'ecc:skill:exa-skill');
    assert.ok(exa.requires.mcp.length > 0);
    assert.ok(exa.requires.mcp.includes('exa'));
    assert.equal(exa.executableInScope.read, false);
    assert.ok(exa.evidence.some((e) => e.startsWith('description: mcp')));

    const save = byId(catalog, 'ecc:skill:save-skill');
    assert.equal(save.requires.writes, true);
    assert.equal(save.executableInScope.read, false);

    const spaced = byId(catalog, 'ecc:skill:spaced-tools');
    assert.equal(spaced.requires.shell, true);
    assert.deepEqual(spaced.frontmatter.allowedTools, ['Read', 'Bash(npm test)']);

    const viaBlank = byId(catalog, 'ecc:command:via-blank');
    assert.equal(viaBlank.requires.fork, true);
    assert.equal(viaBlank.executableInScope.read, false);
    assert.equal(viaBlank.executableInScope.write, false, 'agent sem tools herda escrita');
    assert.ok(viaBlank.evidence.includes('delegates to agent blank (tools: inherits all)'));
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('evidência vazia vira "nenhum sinal encontrado" com confiança baixa', () => {
  const fx = makeFixture();
  try {
    const catalog = build(fx);
    const pure = byId(catalog, 'ecc:skill:pure-skill');
    assert.deepEqual(pure.evidence, ['no signals found in frontmatter or body']);
    assert.equal(pure.classificationConfidence, 'low');
    assert.deepEqual(pure.executableInScope, { read: false, review: false, write: false, full: true });
    assert.doesNotMatch(renderDigest(catalog, '2026-01-01').split('## Agents')[0], /pure-skill/, 'read lista só confiança alta');
    assert.equal(byId(catalog, 'ecc:command:bash-push').classificationConfidence, 'high');
    assert.equal(byId(catalog, 'ecc:agent:reader').classificationConfidence, 'high');
    assert.match(renderReadme('1.0.0'), /nenhum sinal encontrado/);
    assert.match(renderReadme('1.0.0'), /Commit A/);
    assert.match(renderDigest(catalog, '2026-01-01'), /nenhum sinal encontrado/);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('versão insegura é rejeitada e nada é escrito fora de --out', () => {
  const fx = makeFixture();
  const out = path.join(fx.root, 'out');
  try {
    // Sem versão no registro; package.json do plugin tenta escapar de --out.
    write(fx.root, 'installed-noversion.json', JSON.stringify({ version: 2, plugins: { 'ecc@ecc': [{ installPath: fx.plugin }] } }));
    write(fx.plugin, 'package.json', JSON.stringify({ version: '../../../pwned' }));
    const args = ['--ecc-root', fx.plugin, '--installed-plugins', path.join(fx.root, 'installed-noversion.json'), '--out', out, '--date', '2026-01-01'];
    assert.throws(() => run(args), /Versão do ECC inválida/);
    assert.equal(existsSync(out), false, 'nenhum diretório de saída criado');
    assert.equal(existsSync(path.join(fx.root, 'pwned.json')), false);
    assert.equal(existsSync(path.resolve(fx.root, '..', 'pwned.json')), false);
    assert.throws(() => run([...args.slice(0, -1), '../x']), /inválida/);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('regeneração a partir do cache real é idêntica ao artefato commitado', (t) => {
  const installed = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  if (!existsSync(installed)) return t.skip('installed_plugins.json ausente');
  let record;
  try {
    record = JSON.parse(readFileSync(installed, 'utf8'))?.plugins?.['ecc@ecc']?.[0];
  } catch {
    return t.skip('installed_plugins.json ilegível');
  }
  if (!record?.installPath || !existsSync(record.installPath)) return t.skip('cache do ECC ausente');
  const artifact = path.resolve(here, '..', '..', 'packages', 'electron', 'resources', 'ecc-catalog', `ecc-${record.version}.json`);
  if (!existsSync(artifact)) return t.skip(`artefato ${path.basename(artifact)} não commitado`);
  const fresh = `${JSON.stringify(buildCatalog({ overrides: overridesPath, warn: quiet }).json, null, 2)}\n`;
  assert.ok(sameArtifact(fresh, readFileSync(artifact, 'utf8')));
});

test('comparação do artefato tolera CRLF (checkout Windows com autocrlf)', () => {
  const fx = makeFixture();
  try {
    const fresh = `${JSON.stringify(build(fx, { overrides: fx.overrides }).json, null, 2)}\n`;
    const crlfPath = path.join(fx.root, 'artifact-crlf.json');
    writeFileSync(crlfPath, fresh.replace(/\n/g, '\r\n'), 'utf8');
    const onDisk = readFileSync(crlfPath, 'utf8');
    assert.ok(onDisk.includes('\r\n'), 'referência está em CRLF');
    assert.notEqual(onDisk, fresh, 'comparação crua falharia');
    assert.ok(sameArtifact(fresh, onDisk));
    assert.ok(!sameArtifact(fresh, onDisk.replace('"schemaVersion": 1', '"schemaVersion": 2')));
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('override contraditório gera aviso por função pura, sem alterar o JSON', () => {
  const entry = {
    id: 'ecc:skill:x',
    requires: { shell: true, inlineExec: false, fork: false, mcp: ['exa'], network: false, writes: true, scripts: false },
    executableInScope: { read: false, review: false, write: false, full: true },
  };
  const messages = collectOverrideWarnings(entry, { executableInScope: { read: true, write: true } });
  assert.equal(messages.length, 2);
  assert.match(messages[0], /ecc:skill:x.*read=true.*shell, mcp, writes/);
  assert.match(messages[1], /write=true.*shell, mcp/);
  assert.deepEqual(collectOverrideWarnings(entry, { executableInScope: { read: false } }), []);
  assert.deepEqual(collectOverrideWarnings(entry, { mechanics: 'script' }), []);
  const clean = { id: 'ecc:skill:y', requires: { shell: false, inlineExec: false, fork: false, mcp: [], network: false, writes: false, scripts: false }, executableInScope: { read: true, review: true, write: true, full: true } };
  assert.deepEqual(collectOverrideWarnings(clean, { executableInScope: { read: true } }), []);

  // Na construção, o aviso vai para o callback/stderr e não entra no JSON.
  const fx = makeFixture();
  try {
    const seen = [];
    write(fx.root, 'ov2.json', JSON.stringify({ 'ecc:skill:shell-skill': { executableInScope: { read: true } } }));
    const withWarn = buildCatalog({ eccRoot: fx.plugin, installedPlugins: fx.installed, overrides: path.join(fx.root, 'ov2.json'), warn: (m) => seen.push(m) });
    assert.equal(seen.length, 1);
    assert.match(seen[0], /ecc:skill:shell-skill.*read=true/);
    assert.ok(!JSON.stringify(withWarn.json.parseWarnings).includes('contradiz'));
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('skill com allowed-tools e corpo limpo tem confiança baixa e fica fail-closed', () => {
  const fx = makeFixture();
  try {
    write(fx.plugin, 'skills/preapproved/SKILL.md', '---\nname: preapproved\ndescription: Only pre-approves a tool.\nallowed-tools: Read\n---\n\n# Preapproved\n\nThink carefully.\n');
    const catalog = build(fx);
    const entry = byId(catalog, 'ecc:skill:preapproved');
    assert.equal(entry.classificationConfidence, 'low');
    assert.deepEqual(entry.frontmatter.allowedTools, ['Read']);
    assert.deepEqual(entry.executableInScope, { read: false, review: false, write: false, full: true });
    assert.deepEqual(entry.evidence, ['no signals found in frontmatter or body']);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('isInside resolve symlinks e rejeita caminhos fora da raiz', (t) => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'ecc-catalog-inside-'));
  try {
    const root = path.join(base, 'root');
    const outside = path.join(base, 'outside');
    write(root, 'sub/file.md', 'x');
    write(outside, 'secret.md', 'y');
    assert.equal(isInside(root, path.join(root, 'sub', 'file.md')), true);
    assert.equal(isInside(root, path.join(root, 'nao-existe', 'novo.md')), true);
    assert.equal(isInside(root, root), true);
    assert.equal(isInside(root, path.join(outside, 'secret.md')), false);
    assert.equal(isInside(root, path.join(root, '..', 'outside', 'secret.md')), false);
    assert.equal(isInside(root, path.join(base, 'root-irmao', 'a.md')), false);
    try {
      symlinkSync(outside, path.join(root, 'link'), 'junction');
    } catch {
      return t.skip('symlink/junction indisponível neste ambiente');
    }
    assert.equal(isInside(root, path.join(root, 'link', 'secret.md')), false, 'symlink não escapa da raiz');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
