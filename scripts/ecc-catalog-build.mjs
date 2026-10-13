#!/usr/bin/env node
/**
 * Constrói o catálogo passivo (somente dado) das capacidades do ECC instalado em cache.
 *
 * O catálogo descreve agents, skills, commands, workflows, métodos (rules) e hooks.
 * Nada aqui habilita plugin, registra ferramenta, carrega hook/MCP, executa shell
 * ou altera configuração: o script só LÊ arquivos de texto do ECC (.md/.json/.yaml/.js)
 * e escreve três arquivos em --out.
 *
 * Uso:
 *   node scripts/ecc-catalog-build.mjs [--ecc-root <dir>] [--out <dir>] [--overrides <file>]
 *                                      [--installed-plugins <file>] [--date YYYY-MM-DD]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCHEMA_VERSION = 1;
const DESCRIPTION_MAX = 1536;
const METHOD_DESCRIPTION_MAX = 400;
const EVIDENCE_MAX = 14;
const DIGEST_TARGET_BYTES = 60000;
const READABLE_EXTENSIONS = new Set(['.md', '.json', '.yaml', '.js']);
const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.ts', '.sh', '.py']);
const PLUGIN_KEY = 'ecc@ecc';

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch']);
const FORK_TOOLS = new Set(['Agent', 'Task']);
const DELEGATION_TOOLS = new Set([...SHELL_TOOLS, ...WRITE_TOOLS, ...FORK_TOOLS]);
const MCP_PLACEHOLDERS = new Set(['server', 'servername', 'name', 'x', 'y', 'foo', 'bar', 'example', 'xxx', 'mcp']);

const SHELL_MARKERS = [
  ['Bash', /\bBash\b/g],
  ['npx', /\bnpx\s/g],
  ['node', /\bnode\s+\S/g],
  ['npm', /\bnpm\s+\w/g],
  ['pip', /\bpip3?\s+\w/g],
  ['python', /\bpython3?\b/g],
  ['uvx', /\buvx\s/g],
  ['bun', /\bbun\s+\w/g],
  ['cargo', /\bcargo\s+\w/g],
  ['go run', /\bgo run\b/g],
  ['bash -c', /\bbash\s+-c\b/g],
  ['$(', /\$\(/g],
  ['git', /\bgit\s+\w/g],
  ['gh', /\bgh\s+\w/g],
  ['docker', /\bdocker\s+\w/g],
  ['make', /\bmake\s+\w/g],
  ['gradle', /\bgradlew?\b/g],
  ['pnpm', /\bpnpm\s+\w/g],
  ['yarn', /\byarn\s+\w/g],
  ['pytest', /\bpytest\b/g],
  ['mvn', /\bmvn\s+\w/g],
  ['dotnet', /\bdotnet\s+\w/g],
  ['swift build', /\bswift\s+build\b/g],
  ['xcodebuild', /\bxcodebuild\b/g],
  ['kubectl', /\bkubectl\s+\w/g],
  ['terraform', /\bterraform\s+\w/g],
];

const SHELL_FENCE_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'powershell', 'pwsh', 'console', 'cmd', 'bat']);
const NO_SIGNALS = 'no signals found in frontmatter or body';
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;
const SAFE_DATE = /^\d{4}-\d{2}-\d{2}$/;

const WRITE_PATTERNS = [
  ['write to', /\bwrites?\s+(?:it\s+)?(?:to|into)\b/gi],
  ['create file', /\bcreates?\s+(?:a\s+|the\s+|an\s+)?(?:new\s+)?(?:file|directory|folder)\b/gi],
  ['generates file', /\bgenerates?\s+`[^`\n]*\.[A-Za-z0-9]{1,5}`/gi],
  ['output path', /\b(?:outputs?|saves?|saved)\s+(?:it\s+)?(?:to|in|into)\s+`[^`\n]*[\/.][^`\n]*`/gi],
  ['save to path', /\bsav(?:e|es|ing)\b[^.\n]{0,40}?\b(?:to|into|in|as)\s+[\w.~-]*[\/.][\w./-]*/gi],
  ['Write tool', /\bWrite\s+tool\b/gi],
  ['write the file', /\bwrit(?:e|es|ing)\s+(?:the|a|an|this|that|each)\s+(?:\w+\s+)?files?\b/gi],
  ['create/generate file', /\b(?:creates?|generates?)\s+(?:a|an|the)\s+(?:new\s+)?(?:[\w-]+\s+)?(?:file|directory|folder)\b/gi],
  ['append to', /\bappends?\s+(?:it\s+)?to\b/gi],
  ['modify files', /\b(?:updates?|edits?|modif(?:y|ies)|rewrites?|toggles?|deletes?|removes?)\b[^.\n]{0,60}\bfiles?\b/gi],
  ['update file', /\bupdates?\s+(?:the\s+)?`?[\w./-]+\.(?:md|json|ya?ml|txt|ts|js)\b/gi],
];

// ---------------------------------------------------------------------------
// Leitura segura (somente texto, só dentro de uma raiz, só extensões permitidas)
// ---------------------------------------------------------------------------

// Resolve symlinks: usa o ancestral existente mais profundo e reanexa o resto.
function realPathOrSelf(target) {
  const real = fs.realpathSync.native ?? fs.realpathSync;
  let current = path.resolve(target);
  const rest = [];
  for (;;) {
    try {
      return path.join(real(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

export function isInside(root, target) {
  const rel = path.relative(realPathOrSelf(root), realPathOrSelf(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function createReader(root) {
  const resolvedRoot = path.resolve(root);
  return {
    root: resolvedRoot,
    exists(rel) {
      const full = path.resolve(resolvedRoot, rel);
      return isInside(resolvedRoot, full) && fs.existsSync(full);
    },
    text(rel) {
      const full = path.resolve(resolvedRoot, rel);
      if (!isInside(resolvedRoot, full)) throw new Error(`Caminho fora da raiz: ${rel}`);
      if (!READABLE_EXTENSIONS.has(path.extname(full).toLowerCase())) {
        throw new Error(`Extensão não permitida: ${rel}`);
      }
      return fs.readFileSync(full, 'utf8');
    },
    entries(rel) {
      const full = path.resolve(resolvedRoot, rel);
      if (!isInside(resolvedRoot, full) || !fs.existsSync(full)) return [];
      return fs
        .readdirSync(full, { withFileTypes: true })
        .map((d) => ({ name: d.name, dir: d.isDirectory(), file: d.isFile() }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
  };
}

function readJson(reader, rel, warnings) {
  if (!reader.exists(rel)) return null;
  try {
    return JSON.parse(reader.text(rel).replace(/^\uFEFF/, ''));
  } catch (error) {
    warnings.push({ source: rel, message: `JSON inválido: ${error.message}` });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Parser de frontmatter (subconjunto de YAML)
// ---------------------------------------------------------------------------

function splitCsv(text) {
  const parts = [];
  let current = '';
  let quote = null;
  let depth = 0;
  for (const ch of text) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === '(' || ch === '[') {
      depth += 1;
      current += ch;
    } else if (ch === ')' || ch === ']') {
      depth = Math.max(0, depth - 1);
      current += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

function parseScalar(raw) {
  const value = raw.trim();
  if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) {
    const inner = value.slice(1, -1);
    return value[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner.replace(/''/g, "'");
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~' || value === '') return null;
  return value;
}

function parseInlineList(raw) {
  const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '');
  return splitCsv(inner).map((item) => parseScalar(item));
}

function stripInlineComment(value) {
  // Comentário YAML só conta se precedido por espaço e fora de aspas.
  const trimmed = value.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) return trimmed;
  const idx = trimmed.search(/\s#/);
  return idx === -1 ? trimmed : trimmed.slice(0, idx).trim();
}

const KEY_LINE = /^([A-Za-z0-9_.-]+):(?:[ \t]+(.*))?$/;

export function parseFrontmatter(source) {
  const text = String(source).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const warnings = [];
  const lines = text.split('\n');
  if (lines[0].trim() !== '---') {
    return { data: {}, body: text, warnings: ['sem frontmatter'], hasFrontmatter: false };
  }
  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---' || lines[i].trim() === '...') {
      close = i;
      break;
    }
  }
  if (close === -1) {
    return { data: {}, body: text, warnings: ['frontmatter sem fechamento'], hasFrontmatter: false };
  }
  const fm = lines.slice(1, close);
  const body = lines.slice(close + 1).join('\n');
  const data = {};
  const isBlank = (l) => l.trim() === '' || l.trim().startsWith('#');

  let i = 0;
  while (i < fm.length) {
    const line = fm[i];
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    const match = KEY_LINE.exec(line);
    if (!match) {
      warnings.push(`linha ignorada: ${line.trim().slice(0, 60)}`);
      i += 1;
      continue;
    }
    const key = match[1];
    const rest = stripInlineComment(match[2] ?? '');
    i += 1;

    if (rest === '') {
      // Lista (`- item`), mapa aninhado (`  k: v`) ou valor vazio.
      const block = [];
      while (i < fm.length && (isBlank(fm[i]) || /^\s+\S/.test(fm[i]) || /^-\s/.test(fm[i]))) {
        block.push(fm[i]);
        i += 1;
      }
      const meaningful = block.filter((l) => !isBlank(l));
      if (meaningful.length === 0) {
        data[key] = null;
      } else if (/^\s*-\s/.test(meaningful[0])) {
        data[key] = meaningful
          .filter((l) => /^\s*-\s/.test(l))
          .map((l) => {
            const item = l.replace(/^\s*-\s+/, '');
            return parseScalar(stripInlineComment(item));
          });
      } else {
        const map = {};
        for (const sub of meaningful) {
          const m = KEY_LINE.exec(sub.trim());
          if (!m || /^\s{3,}/.test(sub)) {
            warnings.push(`${key}: linha aninhada ignorada: ${sub.trim().slice(0, 60)}`);
            continue;
          }
          const subRest = stripInlineComment(m[2] ?? '');
          map[m[1]] = subRest.startsWith('[') ? parseInlineList(subRest) : parseScalar(subRest);
        }
        data[key] = map;
      }
      continue;
    }

    if (/^[>|][+-]?$/.test(rest)) {
      const folded = rest[0] === '>';
      const block = [];
      while (i < fm.length && (fm[i].trim() === '' || /^\s+/.test(fm[i]))) {
        block.push(fm[i].trim());
        i += 1;
      }
      data[key] = block.filter((l) => l !== '').join(folded ? ' ' : '\n');
      continue;
    }

    if (rest.startsWith('[')) {
      let joined = rest;
      while (!joined.trimEnd().endsWith(']') && i < fm.length && /^\s+\S/.test(fm[i])) {
        joined += ` ${fm[i].trim()}`;
        i += 1;
      }
      if (!joined.trimEnd().endsWith(']')) warnings.push(`${key}: lista inline sem fechamento`);
      data[key] = parseInlineList(joined);
      continue;
    }

    if (rest[0] === '"' || rest[0] === "'") {
      let joined = rest;
      const quote = rest[0];
      const closed = (s) => s.length > 1 && s.trimEnd().endsWith(quote) && !s.trimEnd().endsWith(`\\${quote}`);
      while (!closed(joined) && i < fm.length && /^\s+\S/.test(fm[i])) {
        joined += ` ${fm[i].trim()}`;
        i += 1;
      }
      if (!closed(joined)) warnings.push(`${key}: string com aspas sem fechamento`);
      data[key] = parseScalar(joined);
      continue;
    }

    // Escalar simples, com continuação indentada.
    let joined = rest;
    while (i < fm.length && /^\s+\S/.test(fm[i])) {
      joined += ` ${fm[i].trim()}`;
      i += 1;
    }
    data[key] = parseScalar(joined);
  }

  return { data, body, warnings, hasFrontmatter: true };
}

// ---------------------------------------------------------------------------
// Utilidades de texto
// ---------------------------------------------------------------------------

function squash(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function truncate(text, max) {
  const clean = squash(text);
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

function asString(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  if (typeof value === 'boolean') return String(value);
  return null;
}

function asBool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return fallback;
}

function splitWhitespace(text) {
  const parts = [];
  let current = '';
  let depth = 0;
  for (const ch of text) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (/\s/.test(ch) && depth === 0) {
      if (current) parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function toolList(value) {
  if (value == null) return null;
  let items;
  if (Array.isArray(value)) {
    items = value.map((v) => String(v).trim());
  } else if (typeof value === 'string') {
    items = splitCsv(value);
    if (items.length === 1 && /\s/.test(items[0])) items = splitWhitespace(items[0]);
  } else {
    return null;
  }
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (item && !seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

const toolBase = (tool) => tool.replace(/\(.*$/, '').trim();

function mcpServersFromText(text) {
  const servers = new Set();
  for (const m of text.matchAll(/mcp__([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*?)__/g)) servers.add(m[1]);
  for (const m of text.matchAll(/mcp__([A-Za-z0-9-]+)(?![A-Za-z0-9_-])/g)) servers.add(m[1]);
  return [...servers].filter((s) => !MCP_PLACEHOLDERS.has(s.toLowerCase()));
}

/** Separa blocos de código cercados e spans inline do restante do corpo. */
function splitCode(body) {
  const fences = [];
  const fenceLangs = [];
  const prose = [];
  const lines = body.split('\n');
  let inFence = false;
  let fenceMark = '';
  let current = [];
  for (const line of lines) {
    const fence = /^\s*(```+|~~~+)/.exec(line);
    if (!inFence && fence) {
      inFence = true;
      fenceMark = fence[1][0];
      current = [];
      const info = line.trim().replace(/^(```+|~~~+)\s*\{?\.?/, '');
      fenceLangs.push(info.split(/[\s{},]/)[0].toLowerCase());
      continue;
    }
    if (inFence && fence && fence[1][0] === fenceMark) {
      inFence = false;
      fences.push(current.join('\n'));
      continue;
    }
    if (inFence) current.push(line);
    else prose.push(line);
  }
  if (inFence) fences.push(current.join('\n'));
  const proseText = prose.join('\n');
  const inline = [...proseText.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  return { fences, fenceLangs, inline, prose: proseText };
}

function firstParagraph(body) {
  const paragraphs = body.split(/\n\s*\n/);
  for (const raw of paragraphs) {
    const text = raw.trim();
    if (text && !text.startsWith('#') && !text.startsWith('```') && !text.startsWith('|') && !text.startsWith('---')) {
      return squash(text.replace(/^[>*\-\s]+/, ''));
    }
  }
  return '';
}

function firstHeading(body) {
  const m = /^#{1,6}\s+(.+)$/m.exec(body);
  return m ? squash(m[1]) : '';
}

// ---------------------------------------------------------------------------
// Heurísticas
// ---------------------------------------------------------------------------

function emptyRequires() {
  return { shell: false, inlineExec: false, fork: false, mcp: [], network: false, writes: false, scripts: false };
}

function computeScopes(requires) {
  const noMcp = requires.mcp.length === 0;
  const common = !requires.shell && !requires.fork && !requires.inlineExec && noMcp && !requires.network;
  const read = common && !requires.writes && !requires.scripts;
  return { read, review: read, write: common, full: true };
}

function scanBody(body, mcpNames, evidence) {
  const code = splitCode(body);
  const codeText = [...code.fences, ...code.inline].join('\n');
  const found = {
    shellMarkers: 0,
    inlineExec: false,
    fork: false,
    shellFences: 0,
    mcp: new Set(),
    network: false,
    writes: false,
  };

  const shellFenceCount = code.fenceLangs.filter((l) => SHELL_FENCE_LANGS.has(l)).length;
  if (shellFenceCount > 0) {
    found.shellFences = shellFenceCount;
    evidence.push(`body: fenced shell block x${shellFenceCount}`);
  }

  for (const [label, pattern] of SHELL_MARKERS) {
    const count = [...codeText.matchAll(pattern)].length;
    if (count > 0) {
      found.shellMarkers += count;
      evidence.push(`body: ${label} x${count}`);
    }
  }

  if (/(^|\s)!`[^`\n]+`/.test(body)) {
    found.inlineExec = true;
    evidence.push('body: !`cmd` inline exec');
  }

  if (/\bsubagent_type\b/.test(body) || /\b(?:Task|Agent)\(/.test(codeText)) {
    found.fork = true;
    evidence.push('body: subagent dispatch');
  }

  for (const server of mcpServersFromText(body)) found.mcp.add(server);
  for (const name of mcpNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const inInline = code.inline.some((span) => span.trim() === name);
    const asJsonKey = new RegExp(`"${escaped}"\\s*:`).test(code.fences.join('\n'));
    const asMcpWord = new RegExp(`(^|[^A-Za-z0-9_-])${escaped}\\s+MCP\\b`).test(body);
    if (inInline || asJsonKey || asMcpWord) found.mcp.add(name);
  }
  if (found.mcp.size > 0) evidence.push(`body: mcp ${[...found.mcp].sort().join(',')}`);

  if (/\b(?:WebFetch|WebSearch)\b/.test(body)) {
    found.network = true;
    evidence.push('body: WebFetch/WebSearch');
  } else if (/\b(?:curl|wget)\s/.test(codeText)) {
    found.network = true;
    evidence.push('body: curl/wget');
  } else {
    const remote = code.fences
      .join('\n')
      .match(/https?:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|example\.|\[)[^\s'")`]+/);
    if (remote) {
      found.network = true;
      evidence.push('body: URL remota em bloco de código');
    }
  }

  for (const [label, pattern] of WRITE_PATTERNS) {
    const count = [...body.matchAll(pattern)].length;
    if (count > 0) {
      found.writes = true;
      evidence.push(`body: ${label} x${count}`);
    }
  }

  return found;
}

function scanDescription(description, mcpNames, evidence) {
  const found = { mcp: new Set(), network: false };
  const text = description ?? '';
  if (!text) return found;
  for (const server of mcpServersFromText(text)) found.mcp.add(server);
  if (/\bMCP\b/i.test(text)) {
    for (const name of mcpNames) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(^|[^A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, 'i').test(text)) found.mcp.add(name);
    }
    const stop = new Set(['the', 'an', 'a', 'any', 'of', 'via', 'and', 'or', 'for', 'using', 'with', 'local', 'remote', 'custom', 'each', 'this', 'that', 'your', 'no', 'new', 'its', 'by', 'to', 'in', 'on', 'as', 'other']);
    for (const m of text.matchAll(/([A-Za-z0-9][A-Za-z0-9.-]*)\s+MCP\b/g)) {
      const word = m[1].toLowerCase();
      if (!stop.has(word)) found.mcp.add(word);
    }
    if (found.mcp.size === 0 && /\bMCP\s+(?:tools?|servers?)\b/i.test(text)) found.mcp.add('unspecified');
  }
  if (found.mcp.size > 0) evidence.push(`description: mcp ${[...found.mcp].sort().join(',')}`);
  if (/\bWebFetch\b|\bWebSearch\b|\bfetch(?:es|ing)?\s+(?:a\s+|the\s+)?URLs?\b|\bweb\s+search\b|\bsearch(?:es|ing)?\s+the\s+web\b/i.test(text)) {
    found.network = true;
    evidence.push('description: network (web fetch/search)');
  }
  return found;
}

function scanSkillDir(reader, skillDir) {
  const entries = reader.entries(skillDir);
  const subdirs = entries.filter((e) => e.dir).map((e) => e.name);
  let scripts = false;
  const walk = (rel, depth) => {
    for (const entry of reader.entries(rel)) {
      if (entry.dir && depth < 4) walk(`${rel}/${entry.name}`, depth + 1);
      else if (entry.file && SCRIPT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) scripts = true;
    }
  };
  for (const sub of subdirs) walk(`${skillDir}/${sub}`, 1);
  return { subdirs, scripts };
}

function classifyPrompt({ kind, name, source, frontmatter, body, mcpNames, dirInfo, bodyEvidence = true }) {
  const evidence = [];
  const requires = emptyRequires();

  const declared = toolList(frontmatter.tools);
  const allowed = toolList(frontmatter['allowed-tools']) ?? [];
  const toolNames = [...(declared ?? []), ...allowed].map(toolBase);
  const toolSet = new Set(toolNames);

  if (kind === 'agent' && declared == null) {
    requires.shell = true;
    requires.writes = true;
    evidence.push('frontmatter: tools omitted (inherits all)');
  }
  for (const tool of toolSet) {
    if (SHELL_TOOLS.has(tool)) {
      requires.shell = true;
      evidence.push(`frontmatter: tool ${tool}`);
    }
    if (WRITE_TOOLS.has(tool)) {
      requires.writes = true;
      evidence.push(`frontmatter: tool ${tool}`);
    }
    if (NETWORK_TOOLS.has(tool)) {
      requires.network = true;
      evidence.push(`frontmatter: tool ${tool}`);
    }
    if (FORK_TOOLS.has(tool)) {
      requires.fork = true;
      evidence.push(`frontmatter: tool ${tool}`);
    }
  }
  const mcp = new Set();
  for (const tool of toolNames) for (const s of mcpServersFromText(tool)) mcp.add(s);

  const context = asString(frontmatter.context);
  const agent = asString(frontmatter.agent);
  const subtask = asBool(frontmatter.subtask, false);
  if (kind !== 'agent') {
    if (context === 'fork') {
      requires.fork = true;
      evidence.push('frontmatter: context fork');
    }
    if (agent) {
      requires.fork = true;
      evidence.push(`frontmatter: agent ${agent}`);
    }
    if (subtask) {
      requires.fork = true;
      evidence.push('frontmatter: subtask true');
    }
  }

  const fromDescription = scanDescription(asString(frontmatter.description), mcpNames, evidence);
  for (const s of fromDescription.mcp) mcp.add(s);
  if (fromDescription.network) requires.network = true;

  let strongShell = false;
  if (kind !== 'agent' && bodyEvidence) {
    const found = scanBody(body, mcpNames, evidence);
    if (found.shellMarkers > 0 || found.shellFences > 0) requires.shell = true;
    strongShell = found.shellMarkers >= 3;
    requires.inlineExec = found.inlineExec;
    if (found.fork) requires.fork = true;
    for (const s of found.mcp) mcp.add(s);
    if (found.network) requires.network = true;
    if (found.writes) requires.writes = true;
  }
  requires.mcp = [...mcp].sort();

  if (dirInfo) {
    requires.scripts = dirInfo.scripts;
    if (dirInfo.scripts) evidence.push('dir: subpasta com script (.js/.mjs/.ts/.sh/.py)');
  }

  let mechanics = 'instruction';
  if (kind === 'agent') mechanics = 'agent';
  else if (/memory|continuous-learning/.test(name)) mechanics = 'memory';
  else if (requires.scripts || strongShell) mechanics = 'script';
  else if (requires.mcp.length > 0) mechanics = 'mcp';

  const origin = asString(frontmatter.origin) ?? asString(frontmatter.metadata?.origin);
  const version = asString(frontmatter.version) ?? asString(frontmatter.metadata?.version);

  return {
    model: asString(frontmatter.model),
    declaredTools: declared,
    frontmatter: {
      allowedTools: allowed,
      context,
      agent,
      subtask,
      disableModelInvocation: asBool(frontmatter['disable-model-invocation'], false),
      userInvocable: asBool(frontmatter['user-invocable'], true),
      argumentHint: asString(frontmatter['argument-hint']),
      origin,
      version,
    },
    requires,
    mechanics,
    evidence,
    source,
  };
}

// ---------------------------------------------------------------------------
// Construção do catálogo
// ---------------------------------------------------------------------------

function parseCommandAgentMap(text) {
  const rows = new Map();
  for (const line of text.split('\n')) {
    const m = /^\|\s*`\/([A-Za-z0-9:_-]+)`\s*\|([^|]*)\|([^|]*)\|?/.exec(line);
    if (!m) continue;
    const agents = [];
    for (const piece of m[2].split(/[,/]|\band\b/)) {
      const cleaned = piece.replace(/[`*]/g, '').replace(/^ecc:/, '').trim();
      if (/^[a-z0-9][a-z0-9-]*$/.test(cleaned)) agents.push(cleaned);
    }
    const skills = [];
    for (const s of `${m[2]} ${m[3]}`.matchAll(/skills?:\s*`?([a-z0-9][a-z0-9-]*)`?/g)) skills.push(s[1]);
    rows.set(m[1], { agents, skills });
  }
  return rows;
}

function modulesForPath(modules, source) {
  let best = null;
  for (const mod of modules) {
    for (const p of mod.paths ?? []) {
      const norm = p.replace(/\/+$/, '');
      if (source === norm || source.startsWith(`${norm}/`)) {
        if (!best || norm.length > best.length || (norm.length === best.length && mod.id < best.id)) {
          best = { id: mod.id, length: norm.length };
        }
      }
    }
  }
  return best ? best.id : null;
}

function resolveEccInstall(options, warnings) {
  const home = os.homedir();
  const installedFile =
    options.installedPlugins ?? path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  let record = null;
  let installed = null;
  if (fs.existsSync(installedFile)) {
    try {
      installed = JSON.parse(fs.readFileSync(installedFile, 'utf8').replace(/^\uFEFF/, ''));
    } catch (error) {
      warnings.push({ source: 'installed_plugins.json', message: `JSON inválido: ${error.message}` });
    }
  }
  const records = installed?.plugins?.[PLUGIN_KEY];
  const list = Array.isArray(records) ? records : [];
  let root = options.eccRoot ? path.resolve(options.eccRoot) : null;
  if (root) {
    record = list.find((r) => r.installPath && path.resolve(r.installPath) === root) ?? null;
  } else {
    record = list[0] ?? null;
    if (record?.installPath) root = path.resolve(record.installPath);
  }
  if (!root) {
    throw new Error(
      `Não foi possível resolver a raiz do ECC: informe --ecc-root ou instale ${PLUGIN_KEY} (${installedFile}).`,
    );
  }
  return { root, version: record?.version ?? null, sha: record?.gitCommitSha ?? null };
}

function displayRoot(root) {
  const home = path.resolve(os.homedir());
  const norm = path.resolve(root);
  if (isInside(home, norm) && norm !== home) {
    return `~/${path.relative(home, norm).split(path.sep).join('/')}`;
  }
  return `<ecc-root>/${path.basename(norm)}`;
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

const SCOPE_CONFLICTS = {
  read: ['shell', 'inlineExec', 'fork', 'mcp', 'network', 'writes', 'scripts'],
  review: ['shell', 'inlineExec', 'fork', 'mcp', 'network', 'writes', 'scripts'],
  write: ['shell', 'inlineExec', 'fork', 'mcp', 'network'],
};

/**
 * Função pura: avisos para um override que concede read/review/write = true
 * contradizendo a heurística (escopo já false) ou os `requires` da entrada.
 * `entry` deve estar no estado anterior à aplicação dos escopos explícitos.
 */
export function collectOverrideWarnings(entry, override) {
  const granted = override?.executableInScope;
  if (!granted || typeof granted !== 'object') return [];
  const messages = [];
  for (const key of ['read', 'review', 'write']) {
    if (granted[key] !== true) continue;
    const reasons = [];
    for (const flag of SCOPE_CONFLICTS[key]) {
      const value = entry.requires?.[flag];
      if (flag === 'mcp' ? Array.isArray(value) && value.length > 0 : value === true) reasons.push(flag);
    }
    if (entry.executableInScope?.[key] === false && reasons.length === 0) reasons.push('heurística negou o escopo');
    if (reasons.length > 0) {
      messages.push(`override ${entry.id}: executableInScope.${key}=true contradiz a classificação (${reasons.join(', ')})`);
    }
  }
  return messages;
}

export function buildCatalog(options = {}) {
  const warn = options.warn ?? ((message) => process.stderr.write(`${message}\n`));
  const warnings = [];
  const install = resolveEccInstall(options, warnings);
  const reader = createReader(install.root);
  if (!fs.existsSync(reader.root)) throw new Error(`Raiz do ECC inexistente: ${reader.root}`);

  let version = install.version;
  if (!version && reader.exists('package.json')) {
    version = readJson(reader, 'package.json', warnings)?.version ?? null;
  }
  version = version ?? 'unknown';
  // A versão compõe nomes de arquivo em --out: nunca aceitar separadores ou "..".
  if (typeof version !== 'string' || !SAFE_VERSION.test(version)) {
    throw new Error(`Versão do ECC inválida para compor nome de arquivo: ${JSON.stringify(version)}`);
  }
  let sha = install.sha ?? null;
  if (sha !== null && !/^[0-9a-f]{7,64}$/i.test(String(sha))) {
    warnings.push({ source: 'installed_plugins.json', message: 'gitCommitSha com formato inesperado; ignorado' });
    sha = null;
  }
  const eccInfo = { version, sha };

  const registry = readJson(reader, 'docs/COMMAND-REGISTRY.json', warnings);
  const modulesDoc = readJson(reader, 'manifests/install-modules.json', warnings);
  const modules = Array.isArray(modulesDoc?.modules) ? modulesDoc.modules : [];
  const mcpDoc = readJson(reader, 'mcp-configs/mcp-servers.json', warnings);
  const mcpNames = Object.keys(mcpDoc?.mcpServers ?? {}).sort();
  const hooksMeta = readJson(reader, 'hooks/hooks.metadata.json', warnings);
  const agentMap = reader.exists('docs/COMMAND-AGENT-MAP.md')
    ? parseCommandAgentMap(reader.text('docs/COMMAND-AGENT-MAP.md'))
    : new Map();
  const registryByCommand = new Map();
  for (const c of Array.isArray(registry?.commands) ? registry.commands : []) {
    if (c && typeof c.command === 'string') registryByCommand.set(c.command, c);
  }

  const entries = [];
  const ids = new Set();
  const pending = []; // { entry, relations }

  const push = (entry, relations = {}) => {
    if (ids.has(entry.id)) {
      warnings.push({ source: entry.source, message: `id duplicado ignorado: ${entry.id}` });
      return;
    }
    ids.add(entry.id);
    entries.push(entry);
    pending.push({ entry, relations });
  };

  const makeEntry = ({ kind, name, description, source, analysis, category, subdirs = null, event = null }) => ({
    id: `ecc:${kind}:${name}`,
    kind,
    name,
    description: truncate(description, DESCRIPTION_MAX),
    source,
    ecc: { ...eccInfo },
    model: analysis.model,
    declaredTools: analysis.declaredTools,
    frontmatter: analysis.frontmatter,
    requires: analysis.requires,
    mechanics: analysis.mechanics,
    executableInScope: computeScopes(analysis.requires),
    category,
    related: { commands: [], agents: [], skills: [] },
    evidence: analysis.evidence,
    classificationConfidence: 'high',
    overridden: false,
    subdirs,
    event,
  });

  const noFrontmatterAnalysis = (extra = {}) => ({
    model: null,
    declaredTools: null,
    frontmatter: {
      allowedTools: [],
      context: null,
      agent: null,
      subtask: false,
      disableModelInvocation: false,
      userInvocable: true,
      argumentHint: null,
      origin: null,
      version: null,
    },
    requires: emptyRequires(),
    mechanics: 'instruction',
    evidence: [],
    ...extra,
  });

  const warnFm = (source, list) => {
    for (const w of list) warnings.push({ source, message: w });
  };

  // 1. agents ----------------------------------------------------------------
  for (const file of reader.entries('agents')) {
    if (!file.file || !file.name.endsWith('.md') || file.name.toLowerCase() === 'readme.md') continue;
    const source = `agents/${file.name}`;
    const base = file.name.replace(/\.md$/, '');
    const fm = parseFrontmatter(reader.text(source));
    warnFm(source, fm.warnings);
    const fmName = asString(fm.data.name);
    if (fmName && fmName !== base) warnings.push({ source, message: `name "${fmName}" difere do arquivo "${base}"` });
    const name = fmName && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(fmName) ? fmName : base;
    const analysis = classifyPrompt({
      kind: 'agent',
      name,
      source,
      frontmatter: fm.data,
      body: fm.body,
      mcpNames,
    });
    const description = asString(fm.data.description) ?? firstParagraph(fm.body);
    if (!asString(fm.data.description)) warnings.push({ source, message: 'description ausente' });
    push(makeEntry({ kind: 'agent', name, description, source, analysis, category: modulesForPath(modules, source) }));
  }

  // 2. skills ----------------------------------------------------------------
  for (const dir of reader.entries('skills')) {
    if (!dir.dir) continue;
    const source = `skills/${dir.name}/SKILL.md`;
    if (!reader.exists(source)) continue;
    const fm = parseFrontmatter(reader.text(source));
    warnFm(source, fm.warnings);
    const fmName = asString(fm.data.name);
    let name = dir.name;
    if (fmName && fmName !== dir.name) {
      warnings.push({ source, message: `name "${fmName}" difere do diretório "${dir.name}"; usando o diretório` });
    }
    const dirInfo = scanSkillDir(reader, `skills/${dir.name}`);
    const analysis = classifyPrompt({
      kind: 'skill',
      name,
      source,
      frontmatter: fm.data,
      body: fm.body,
      mcpNames,
      dirInfo,
    });
    const description = asString(fm.data.description) ?? firstParagraph(fm.body);
    if (!asString(fm.data.description)) warnings.push({ source, message: 'description ausente' });
    const relations = {};
    if (analysis.frontmatter.agent) relations.agents = [analysis.frontmatter.agent];
    push(
      makeEntry({
        kind: 'skill',
        name,
        description,
        source,
        analysis,
        category: modulesForPath(modules, source),
        subdirs: dirInfo.subdirs,
      }),
      relations,
    );
  }

  // 3. commands --------------------------------------------------------------
  for (const file of reader.entries('commands')) {
    if (!file.file || !file.name.endsWith('.md') || file.name.toLowerCase() === 'readme.md') continue;
    const source = `commands/${file.name}`;
    const name = file.name.replace(/\.md$/, '');
    const fm = parseFrontmatter(reader.text(source));
    warnFm(source, fm.warnings);
    const analysis = classifyPrompt({
      kind: 'command',
      name,
      source,
      frontmatter: fm.data,
      body: fm.body,
      mcpNames,
    });
    const reg = registryByCommand.get(name);
    const description = asString(fm.data.description) ?? reg?.description ?? firstParagraph(fm.body);
    if (!asString(fm.data.description)) warnings.push({ source, message: 'description ausente' });
    if (reg?.type) analysis.evidence.push(`registry: type ${reg.type}`);
    const relations = { agents: [], skills: [] };
    if (reg) {
      relations.agents.push(...(reg.primaryAgents ?? []), ...(reg.allAgents ?? []));
      relations.skills.push(...(reg.skills ?? []));
    }
    const mapped = agentMap.get(name);
    if (mapped) {
      relations.agents.push(...mapped.agents);
      relations.skills.push(...mapped.skills);
    }
    if (analysis.frontmatter.agent) relations.agents.push(analysis.frontmatter.agent);
    push(makeEntry({ kind: 'command', name, description, source, analysis, category: modulesForPath(modules, source) }), relations);
  }

  // 4. workflows ---------------------------------------------------------------
  const workflowReadme = reader.exists('workflows/README.md') ? reader.text('workflows/README.md').replace(/\r\n?/g, '\n') : '';
  for (const file of reader.entries('workflows')) {
    if (!file.file || !file.name.endsWith('.workflow.js')) continue;
    const source = `workflows/${file.name}`;
    const text = reader.text(source);
    const fileBase = file.name.replace(/\.workflow\.js$/, '');
    const metaName = /export\s+const\s+meta\s*=\s*\{[\s\S]*?\bname\s*:\s*['"`]([^'"`]+)['"`]/.exec(text);
    const name = metaName ? metaName[1] : fileBase;
    let description = '';
    const headingIdx = workflowReadme.indexOf(file.name);
    if (headingIdx !== -1) {
      const after = workflowReadme.slice(workflowReadme.indexOf('\n', headingIdx) + 1);
      description = firstParagraph(after);
    }
    if (!description) {
      const metaDesc = /\bdescription\s*:\s*\n?\s*(['"`])([\s\S]*?)\1\s*,/.exec(text);
      description = metaDesc ? metaDesc[2] : '';
    }
    if (!description) warnings.push({ source, message: 'descrição de workflow não encontrada' });
    const analysis = noFrontmatterAnalysis({ mechanics: 'script' });
    analysis.requires.fork = true;
    analysis.requires.scripts = true;
    analysis.evidence.push('file: .workflow.js orquestra subagentes');
    push(makeEntry({ kind: 'workflow', name, description, source, analysis, category: modulesForPath(modules, source) }));
  }

  // 5. methods (rules/common) --------------------------------------------------
  for (const file of reader.entries('rules/common')) {
    if (!file.file || !file.name.endsWith('.md') || file.name.toLowerCase() === 'readme.md') continue;
    const source = `rules/common/${file.name}`;
    const name = file.name.replace(/\.md$/, '');
    const text = reader.text(source).replace(/\r\n?/g, '\n');
    const fm = parseFrontmatter(text);
    const body = fm.hasFrontmatter ? fm.body : text;
    const analysis = classifyPrompt({ kind: 'method', name, source, frontmatter: {}, body, mcpNames });
    analysis.mechanics = 'instruction';
    const title = firstHeading(body);
    const paragraph = firstParagraph(body.replace(/^#{1,6}\s+.+$/m, ''));
    const description = truncate([title, paragraph].filter(Boolean).join(' — '), METHOD_DESCRIPTION_MAX);
    const entry = makeEntry({ kind: 'method', name, description, source, analysis, category: modulesForPath(modules, source) });
    entry.executableInScope = { read: true, review: true, write: true, full: true };
    push(entry);
  }

  // 6. hooks (inventário) ------------------------------------------------------
  const hookSource = 'hooks/hooks.metadata.json';
  const hookEvents = hooksMeta?.entries && typeof hooksMeta.entries === 'object' ? hooksMeta.entries : {};
  for (const event of Object.keys(hookEvents).sort()) {
    const items = Array.isArray(hookEvents[event]) ? hookEvents[event] : [];
    for (const item of items) {
      if (!item || typeof item.id !== 'string') {
        warnings.push({ source: hookSource, message: `hook sem id no evento ${event}` });
        continue;
      }
      const analysis = noFrontmatterAnalysis({ mechanics: 'hook' });
      analysis.requires.shell = true;
      analysis.requires.scripts = true;
      analysis.evidence.push(`hook: evento ${event}`);
      const entry = makeEntry({
        kind: 'hook',
        name: item.id,
        description: asString(item.description) ?? '',
        source: hookSource,
        analysis,
        category: modulesForPath(modules, 'hooks/hooks.metadata.json'),
        event,
      });
      entry.executableInScope = { read: false, review: false, write: false, full: false };
      push(entry);
    }
  }

  // Relações cruzadas ---------------------------------------------------------
  const byKindName = (kind) => new Set(entries.filter((e) => e.kind === kind).map((e) => e.name));
  const agentNames = byKindName('agent');
  const skillNames = byKindName('skill');
  const commandNames = byKindName('command');
  const rel = {
    commands: new Map(),
    agents: new Map(),
    skills: new Map(),
  };
  const link = (kind, name) => {
    const bucket = rel[kind];
    if (!bucket.has(name)) bucket.set(name, { commands: new Set(), agents: new Set(), skills: new Set() });
    return bucket.get(name);
  };
  for (const { entry, relations } of pending) {
    if (entry.kind === 'command') {
      for (const a of relations.agents ?? []) {
        if (agentNames.has(a)) {
          entry.related.agents.push(a);
          link('agents', a).commands.add(entry.name);
        }
      }
      for (const s of relations.skills ?? []) {
        if (skillNames.has(s)) {
          entry.related.skills.push(s);
          link('skills', s).commands.add(entry.name);
        }
      }
    } else if (entry.kind === 'skill') {
      for (const a of relations.agents ?? []) {
        if (agentNames.has(a)) {
          entry.related.agents.push(a);
          link('agents', a).skills.add(entry.name);
        }
      }
    }
  }
  for (const entry of entries) {
    if (entry.kind === 'agent' || entry.kind === 'skill') {
      const bucket = rel[`${entry.kind}s`].get(entry.name);
      if (bucket) {
        entry.related.commands.push(...bucket.commands);
        if (entry.kind === 'agent') entry.related.skills.push(...bucket.skills);
      }
    }
    if (entry.kind === 'skill' && commandNames.has(entry.name) && !entry.related.commands.includes(entry.name)) {
      entry.related.commands.push(entry.name);
    }
    for (const key of ['commands', 'agents', 'skills']) {
      entry.related[key] = [...new Set(entry.related[key])].sort(cmp);
    }
  }

  // Delegação a agents --------------------------------------------------------
  // Skill/command que aponta para um agent com ferramentas de execução herda fork.
  const agentByName = new Map(entries.filter((e) => e.kind === 'agent').map((e) => [e.name, e]));
  const delegation = new Map(); // id -> { hadOwnFork, writes }
  const scopesFor = (entry) => {
    const d = delegation.get(entry.id);
    const req = d && !d.hadOwnFork ? { ...entry.requires, fork: false } : entry.requires;
    const scopes = computeScopes(req);
    if (d) {
      scopes.read = false;
      scopes.review = false;
      if (d.writes) scopes.write = false;
    }
    return scopes;
  };
  for (const entry of entries) {
    if (entry.kind !== 'skill' && entry.kind !== 'command') continue;
    const names = new Set(entry.related.agents);
    if (entry.frontmatter.agent) names.add(entry.frontmatter.agent);
    let delegates = false;
    let writes = false;
    for (const name of [...names].sort(cmp)) {
      const agent = agentByName.get(name);
      if (!agent) continue;
      const inheritsAll = agent.declaredTools == null;
      const tools = agent.declaredTools ?? [];
      const bases = tools.map(toolBase);
      if (!inheritsAll && !bases.some((t) => DELEGATION_TOOLS.has(t))) continue;
      delegates = true;
      if (inheritsAll || bases.some((t) => WRITE_TOOLS.has(t))) writes = true;
      entry.evidence.push(`delegates to agent ${name} (tools: ${inheritsAll ? 'inherits all' : tools.join(', ')})`);
    }
    if (delegates) {
      delegation.set(entry.id, { hadOwnFork: entry.requires.fork, writes });
      entry.requires.fork = true;
      entry.executableInScope = scopesFor(entry);
    }
  }

  // Overrides -----------------------------------------------------------------
  const overridesPath = options.overrides;
  let overrides = {};
  if (overridesPath && fs.existsSync(overridesPath)) {
    try {
      const doc = JSON.parse(fs.readFileSync(overridesPath, 'utf8').replace(/^\uFEFF/, ''));
      overrides = doc.overrides && typeof doc.overrides === 'object' ? doc.overrides : doc;
    } catch (error) {
      warnings.push({ source: 'overrides', message: `JSON inválido: ${error.message}` });
    }
  }
  const byId = new Map(entries.map((e) => [e.id, e]));
  for (const id of Object.keys(overrides).sort()) {
    if (id.startsWith('_')) continue;
    const entry = byId.get(id);
    if (!entry) {
      warnings.push({ source: 'overrides', message: `override sem entrada correspondente: ${id}` });
      continue;
    }
    const o = overrides[id] ?? {};
    if (o.requires && typeof o.requires === 'object') {
      for (const key of ['shell', 'inlineExec', 'fork', 'network', 'writes', 'scripts']) {
        if (typeof o.requires[key] === 'boolean') entry.requires[key] = o.requires[key];
      }
      if (typeof o.requires.fork === 'boolean' && delegation.has(id)) delegation.get(id).hadOwnFork = o.requires.fork;
      if (Array.isArray(o.requires.mcp)) entry.requires.mcp = [...new Set(o.requires.mcp.map(String))].sort();
      if (entry.kind !== 'hook' && entry.kind !== 'method') entry.executableInScope = scopesFor(entry);
    }
    if (typeof o.mechanics === 'string') entry.mechanics = o.mechanics;
    for (const message of collectOverrideWarnings(entry, o)) warn(`ecc-catalog-build: aviso: ${message}`);
    if (o.executableInScope && typeof o.executableInScope === 'object') {
      for (const key of ['read', 'review', 'write', 'full']) {
        if (typeof o.executableInScope[key] === 'boolean') entry.executableInScope[key] = o.executableInScope[key];
      }
    }
    entry.overridden = true;
    entry.evidence.push(`override: ${o.note ? squash(o.note) : 'aplicado'}`);
  }

  // Confiança: evidência vazia significa "nenhum sinal encontrado", não "verificado seguro".
  for (const entry of entries) {
    if (entry.kind !== 'skill' && entry.kind !== 'command') continue;
    const real = entry.evidence.filter((e) => e !== NO_SIGNALS && !e.startsWith('registry:'));
    // `allowed-tools` é pré-aprovação, não restrição: não conta como sinal negativo.
    const declaresTools = entry.declaredTools != null;
    if (real.length === 0) {
      entry.evidence = [NO_SIGNALS, ...entry.evidence.filter((e) => e.startsWith('registry:'))];
      entry.classificationConfidence = declaresTools ? 'high' : 'low';
      // Sem nenhum sinal a entrada é "não verificada", não "segura": fail-closed.
      if (entry.classificationConfidence === 'low') {
        entry.executableInScope = { read: false, review: false, write: false, full: true };
      }
    } else {
      entry.evidence = entry.evidence.filter((e) => e !== NO_SIGNALS);
      entry.classificationConfidence = 'high';
    }
  }

  for (const entry of entries) {
    if (entry.evidence.length > EVIDENCE_MAX) {
      const extra = entry.evidence.length - EVIDENCE_MAX;
      const overrideLine = entry.evidence.find((e) => e.startsWith('override:'));
      entry.evidence = entry.evidence.slice(0, EVIDENCE_MAX - 1).filter((e) => !e.startsWith('override:'));
      entry.evidence.push(`(+${extra} evidências omitidas)`);
      if (overrideLine) entry.evidence.push(overrideLine);
    }
  }

  entries.sort((a, b) => cmp(a.id, b.id));
  warnings.sort((a, b) => cmp(a.source, b.source) || cmp(a.message, b.message));

  const byKind = {};
  const byMechanics = {};
  const scopes = { read: 0, review: 0, write: 0, full: 0 };
  for (const e of entries) {
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    byMechanics[e.mechanics] = (byMechanics[e.mechanics] ?? 0) + 1;
    for (const k of Object.keys(scopes)) if (e.executableInScope[k]) scopes[k] += 1;
  }
  const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => cmp(a, b)));

  const json = {
    schemaVersion: SCHEMA_VERSION,
    ecc: { version, sha, root: displayRoot(install.root) },
    stats: {
      total: entries.length,
      byKind: sortObj(byKind),
      byMechanics: sortObj(byMechanics),
      executableInScope: scopes,
      parseWarnings: warnings.length,
    },
    parseWarnings: warnings,
    entries,
  };
  return { json, version, sha };
}

// ---------------------------------------------------------------------------
// Digest e README
// ---------------------------------------------------------------------------

const KIND_ORDER = ['agent', 'skill', 'command', 'workflow', 'method', 'hook'];
const KIND_TITLES = {
  agent: 'Agents',
  skill: 'Skills',
  command: 'Commands',
  workflow: 'Workflows',
  method: 'Métodos (rules/common)',
  hook: 'Hooks (inventário — fora de escopo)',
};

function scopeLabel(scope) {
  const parts = [];
  if (scope.read) parts.push('R');
  if (scope.review) parts.push('Rv');
  if (scope.write) parts.push('W');
  if (scope.full) parts.push('F');
  return parts.length ? parts.join('/') : '—';
}

function requiresLabel(requires) {
  const parts = [];
  if (requires.shell) parts.push('shell');
  if (requires.inlineExec) parts.push('inlineExec');
  if (requires.fork) parts.push('fork');
  if (requires.mcp.length) parts.push(`mcp:${requires.mcp.join('+')}`);
  if (requires.network) parts.push('network');
  if (requires.writes) parts.push('writes');
  if (requires.scripts) parts.push('scripts');
  return parts.length ? parts.join(', ') : '—';
}

export function renderDigest(catalog, date) {
  const { json } = catalog;
  const build = (descMax) => {
    const out = [];
    out.push(`# Catálogo passivo do ECC ${json.ecc.version}`);
    out.push('');
    out.push(`- Versão: ${json.ecc.version}`);
    out.push(`- SHA: ${json.ecc.sha ?? 'desconhecido'}`);
    out.push(`- Gerado em: ${date}`);
    out.push(`- Entradas: ${json.stats.total} (${Object.entries(json.stats.byKind).map(([k, v]) => `${k} ${v}`).join(', ')})`);
    out.push(`- Mecânicas: ${Object.entries(json.stats.byMechanics).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    const s = json.stats.executableInScope;
    out.push(`- Escopos executáveis: read ${s.read}, review ${s.review}, write ${s.write}, full ${s.full}`);
    out.push(`- Avisos de parse: ${json.stats.parseWarnings}`);
    out.push('');
    out.push('> Somente dado. Nada neste catálogo habilita plugin, ferramenta, hook ou MCP. Escopos: R=read, Rv=review, W=write, F=full. A lista de read traz só entradas de confiança alta (nomes sem prefixo são skills); entradas sem nenhum sinal (`classificationConfidence: "low"`) ficam fora de read/review/write.');
    out.push('');

    out.push('> Aviso: `executableInScope` é heurístico. Evidência vazia significa "nenhum sinal encontrado", não "verificado seguro". A negação real é feita pelo runtime (Commit A); este catálogo nunca é usado para liberar nada.');
    out.push('');
    out.push('- skillToolDeniedInReadReview: true');
    out.push('> Em skills, read/review significa "o conteúdo cabe num escopo read quando injetado como texto (brief ou system prompt)", nunca "invocável pela ferramenta Skill": uma skill pode declarar `hooks:` que executam shell fora da ferramenta Bash, e o runtime nega `Skill` em sessões read/review.');
    out.push('');
    out.push('## Capacidades executáveis em read (instrução pura)');
    out.push('');
    const readable = json.entries.filter((e) => e.executableInScope.read && e.kind !== 'hook');
    const byCategory = new Map();
    for (const e of readable) {
      const key = e.category ?? '(sem categoria)';
      if (!byCategory.has(key)) byCategory.set(key, []);
      byCategory.get(key).push(e);
    }
    for (const category of [...byCategory.keys()].sort(cmp)) {
      const items = byCategory.get(category);
      out.push(`- **${category}** (${items.length}): ${items.map((e) => `${e.kind === 'skill' ? e.name : `${e.kind}:${e.name}`}`).join(', ')}`);
    }
    out.push('');

    for (const kind of KIND_ORDER) {
      const items = json.entries.filter((e) => e.kind === kind);
      if (items.length === 0) continue;
      out.push(`## ${KIND_TITLES[kind]} (${items.length})`);
      out.push('');
      for (const e of items) {
        out.push(
          `- **${e.name}** · ${e.mechanics} · ${scopeLabel(e.executableInScope)}${requiresLabel(e.requires) === '—' ? '' : ` · requer: ${requiresLabel(e.requires)}`} · ${truncate(e.description, descMax)}`,
        );
      }
      out.push('');
    }
    return `${out.join('\n')}\n`;
  };

  let descMax = 160;
  let text = build(descMax);
  while (Buffer.byteLength(text, 'utf8') > DIGEST_TARGET_BYTES && descMax > 50) {
    descMax -= 10;
    text = build(descMax);
  }
  return text;
}

export function renderReadme(version) {
  return `# Catálogo passivo do ECC

Inventário estruturado e versionado, **somente dado**, das capacidades do ECC (Everything Claude Code): agents, skills, commands, workflows, métodos (rules) e hooks. Nada no app lê estes arquivos em tempo de execução; o único consumidor é \`scripts/ecc-architect-index-build.mjs\`, que, em tempo de geração, deriva do JSON e de \`scripts/ecc-architect-classes.json\` o índice \`packages/runtime/src/ai/ecc/eccCatalogIndex.generated.ts\` lido pelo papel \`architect\` do Team Mode (classes A/B/C; hooks, memória, orquestração e entradas sem sinal nunca entram).

- \`ecc-${version}.json\`: catálogo canônico (entradas ordenadas, sem timestamps).
- \`ecc-${version}.md\`: digest legível para humanos e para prompts (a data de geração fica só aqui).

Regerar: \`node scripts/ecc-catalog-build.mjs\` (opções: \`--ecc-root\`, \`--out\`, \`--overrides\`).
A raiz padrão é resolvida por \`~/.claude/plugins/installed_plugins.json\` (plugin \`ecc@ecc\`); correções manuais ficam em \`scripts/ecc-catalog.overrides.json\`.

Garantias: o construtor só lê \`.md/.json/.yaml/.js\` como texto, sem importar, executar ou avaliar código do ECC, sem rede e sem escrever fora de \`--out\`.
O catálogo não habilita plugin, não registra ferramenta, não carrega hook nem MCP e não altera configuração.
Os campos \`requires\` e \`executableInScope\` são **heurísticos**, derivados do texto. \`evidence\` vazia (\`no signals found in frontmatter or body\`, com \`classificationConfidence: "low"\`) significa "nenhum sinal encontrado", **não** "verificado seguro": essas entradas ficam fail-closed (\`read\`, \`review\` e \`write\` false; \`full\` permanece) e a seção de read do digest lista só confiança alta. A negação real de ferramentas é feita pelo runtime (Commit A); o catálogo nunca é usado para liberar nada.

Para \`kind: skill\`, \`executableInScope.read/review\` significa que o conteúdo da skill cabe num escopo read quando injetado como texto (brief ou system prompt), nunca que a skill pode ser invocada pela ferramenta \`Skill\` nessas sessões: uma skill pode declarar \`hooks:\` no frontmatter e esse hook executa comando de shell fora da ferramenta Bash, por isso o runtime do Nimbalyst NEGA a ferramenta \`Skill\` em sessões read/review (\`skillToolDeniedInReadReview: true\`).

Para \`kind: agent\`, \`executableInScope\` diz que as ferramentas declaradas do agent cabem naquele escopo; o agent em si não é invocável em read/review, porque Agent/Task são negados pelo runtime.
`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Valor ausente para ${arg}`);
      return argv[i];
    };
    if (arg === '--ecc-root') out.eccRoot = take();
    else if (arg === '--out') out.out = take();
    else if (arg === '--overrides') out.overrides = take();
    else if (arg === '--installed-plugins') out.installedPlugins = take();
    else if (arg === '--date') out.date = take();
    else throw new Error(`Argumento desconhecido: ${arg}`);
  }
  return out;
}

export function run(argv) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..');
  const args = parseArgs(argv);
  const outDir = path.resolve(args.out ?? path.join(repoRoot, 'packages', 'electron', 'resources', 'ecc-catalog'));
  const overrides = path.resolve(args.overrides ?? path.join(here, 'ecc-catalog.overrides.json'));
  const catalog = buildCatalog({
    eccRoot: args.eccRoot,
    overrides,
    installedPlugins: args.installedPlugins,
  });
  const date = args.date ?? new Date().toISOString().slice(0, 10);
  if (!SAFE_DATE.test(date)) throw new Error(`--date inválida: ${JSON.stringify(date)}`);
  if (!SAFE_VERSION.test(catalog.version)) throw new Error(`Versão inválida: ${JSON.stringify(catalog.version)}`);
  const base = `ecc-${catalog.version}`;
  const targets = [`${base}.json`, `${base}.md`, 'README.md'].map((name) => path.resolve(outDir, name));
  for (const target of targets) {
    if (path.dirname(target) !== outDir) throw new Error(`Destino fora de --out: ${target}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(targets[0], `${JSON.stringify(catalog.json, null, 2)}\n`, 'utf8');
  fs.writeFileSync(targets[1], renderDigest(catalog, date), 'utf8');
  fs.writeFileSync(targets[2], renderReadme(catalog.version), 'utf8');
  return { outDir, base, stats: catalog.json.stats };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = run(process.argv.slice(2));
    const s = result.stats;
    console.log(`Catálogo ECC gerado em ${result.outDir} (${result.base})`);
    console.log(`entradas=${s.total} por kind=${JSON.stringify(s.byKind)}`);
    console.log(`mecânicas=${JSON.stringify(s.byMechanics)} escopos=${JSON.stringify(s.executableInScope)} avisos=${s.parseWarnings}`);
  } catch (error) {
    console.error(`ecc-catalog-build: ${error.message}`);
    process.exitCode = 1;
  }
}
