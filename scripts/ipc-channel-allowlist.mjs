/**
 * Derives the list of IPC channels the renderer side of the app uses
 * (NIB.85 stage d3, LOG-ONLY allowlist, decision U6: never block).
 *
 *   node scripts/ipc-channel-allowlist.mjs           write the checked-in list
 *   node scripts/ipc-channel-allowlist.mjs --check   exit 1 if channels, dynamicPrefixes or listen are stale
 *
 * Sources scanned (tests, fixtures and build output excluded):
 *   packages/electron/src/{preload,renderer,shared}, packages/runtime/src,
 *   packages/extension-sdk/src, packages/extensions/<built-in>/src
 *
 * What is derived:
 *   invoke    channels sent to main: `.invoke(` / `.send(` / `.sendSync(` calls on
 *             ipcRenderer, electronAPI, ipc, api or invoker with a string literal
 *             first argument, or an identifier / IDENT.key that resolves to a
 *             string constant (e.g. MENU_BAR_ISLAND_CHANNELS.setPinned).
 *             Plus every channel main registers by literal name that also appears
 *             as a quoted string in those sources (covers wrappers such as
 *             `callIpc('x', ...)`, constant tables and typed helper objects).
 *   listen    channels main sends to the renderer: `.on(` / `.once(` literals.
 *   dynamicPrefixes
 *             channels whose name is built at run time. Template literals in
 *             invoke/send calls (`git:${action}`) and main-side response /
 *             result channel names (`tracker-body:apply-markdown-result:${id}`)
 *             contribute their static prefix, plus the explicit entries in
 *             EXTRA_DYNAMIC_PREFIXES below.
 *   unresolved
 *             call sites whose channel is computed in a way the script cannot
 *             follow (reported, not allowlisted; the prefixes above cover the
 *             channels they carry).
 *
 * The list is an observation aid. Nothing blocks on it; main only logs an
 * invoked channel that is not in it (see utils/ipcRegistry.ts).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');
export const OUTPUT_FILE = 'packages/electron/src/shared/ipcChannelAllowlist.json';

const SCAN_ROOTS = [
  'packages/electron/src/preload',
  'packages/electron/src/renderer',
  'packages/electron/src/shared',
  'packages/runtime/src',
  'packages/extension-sdk/src',
];
const EXTENSIONS_DIR = 'packages/extensions';
const MAIN_ROOT = 'packages/electron/src/main';

/**
 * Dynamic prefixes the regexes cannot see because the name is assembled in a
 * helper. Keep this short and explain each entry.
 */
const EXTRA_DYNAMIC_PREFIXES = [
  // Window mutation helpers build `${options.resultChannelPrefix ?? 'x'}-${id}`.
  'mutation-result-',
];

const SKIP_DIR = new Set(['node_modules', 'dist', 'out', 'out2', '__tests__', '__mocks__', 'fixtures', '.vite', 'coverage']);
const SKIP_FILE = /(\.d\.ts|\.test\.[tj]sx?|\.spec\.[tj]sx?)$/;
const SOURCE_FILE = /\.(ts|tsx|js|mjs|cjs)$/;

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIR.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (SOURCE_FILE.test(entry.name) && !SKIP_FILE.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function sourceFiles(repoRoot) {
  const files = [];
  for (const root of SCAN_ROOTS) walk(path.join(repoRoot, root), files);
  const extDir = path.join(repoRoot, EXTENSIONS_DIR);
  if (fs.existsSync(extDir)) {
    for (const entry of fs.readdirSync(extDir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(extDir, entry.name, 'src'), files);
    }
  }
  return files.sort();
}

const CHANNEL_LITERAL = /^[A-Za-z][\w.-]*(?::[\w.:-]+)*$/;

// receiver . method ( first-argument
const CALL = /(?:^|[^\w$])(ipcRenderer|electronAPI|ipc|api|invoker)\s*\??\.\s*(invoke|send|sendSync|on|once)\s*\(\s*/g;

/** Symbol table of string constants and `{ key: 'value' }` constant objects. */
function collectConstants(files) {
  const strings = new Map();
  const objects = new Map();
  const constString = /\b(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*(['"])([^'"\n]*)\2/g;
  const constObject = /\b(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*\{([^}]*)\}/g;
  const pair = /(?:^|[,{\s])([A-Za-z_$][\w$]*)\s*:\s*(['"])([^'"\n]*)\2/g;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(constString)) strings.set(m[1], m[3]);
    for (const m of text.matchAll(constObject)) {
      const map = new Map();
      for (const p of m[2].matchAll(pair)) map.set(p[1], p[3]);
      if (map.size > 0) objects.set(m[1], map);
    }
  }
  return { strings, objects };
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function readFirstArgument(text, start) {
  const rest = text.slice(start, start + 400);
  const lit = /^(['"])([^'"\n]*)\1/.exec(rest);
  if (lit) return { kind: 'literal', value: lit[2] };
  const tpl = /^`([^`\n]*)`/.exec(rest);
  if (tpl) return { kind: 'template', value: tpl[1] };
  const ident = /^([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?/.exec(rest);
  if (ident) return { kind: 'identifier', name: ident[1], key: ident[2] ?? null, raw: ident[0] };
  return { kind: 'other', raw: rest.slice(0, 40) };
}

export function deriveAllowlist(repoRoot = REPO_ROOT) {
  const files = sourceFiles(repoRoot);
  const constants = collectConstants(files);
  const invoke = new Set();
  const listen = new Set();
  const prefixes = new Set(EXTRA_DYNAMIC_PREFIXES);
  const unresolved = [];
  const quoted = new Set();
  const quotedString = /(['"])([A-Za-z][\w.-]*(?::[\w.:-]+)*)\1/g;

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const q of text.matchAll(quotedString)) quoted.add(q[2]);
    const rel = path.relative(repoRoot, file).split(path.sep).join('/');
    for (const m of text.matchAll(CALL)) {
      const method = m[2];
      const target = method === 'on' || method === 'once' ? listen : invoke;
      const arg = readFirstArgument(text, m.index + m[0].length);
      if (arg.kind === 'literal') {
        if (CHANNEL_LITERAL.test(arg.value)) target.add(arg.value);
        continue;
      }
      if (arg.kind === 'template') {
        const cut = arg.value.indexOf('${');
        if (cut === -1) {
          if (CHANNEL_LITERAL.test(arg.value)) target.add(arg.value);
        } else if (cut > 0 && target === invoke) {
          prefixes.add(arg.value.slice(0, cut));
        } else if (cut === 0 && target === invoke) {
          unresolved.push(`${rel}:${lineOf(text, m.index)} ${method}(\`${arg.value.slice(0, 40)}\`)`);
        }
        continue;
      }
      if (arg.kind === 'identifier') {
        const resolved = arg.key
          ? constants.objects.get(arg.name)?.get(arg.key)
          : constants.strings.get(arg.name);
        if (resolved && CHANNEL_LITERAL.test(resolved)) {
          target.add(resolved);
        } else if (target === invoke) {
          unresolved.push(`${rel}:${lineOf(text, m.index)} ${method}(${arg.raw})`);
        }
        continue;
      }
      if (target === invoke) unresolved.push(`${rel}:${lineOf(text, m.index)} ${method}(${arg.raw})`);
    }
  }

  // Main-side names for response / result channels that the renderer is told to reply on.
  const mainFiles = walk(path.join(repoRoot, MAIN_ROOT));
  const reply = /\b[A-Za-z]*(?:response|result|Response|Result)[A-Za-z]*Channel\s*=\s*`([^`\n]*)`/g;
  const optionDefault = /\$\{[^}]*\?\?\s*(['"])([^'"\n]*)\1\s*\}/;
  for (const file of mainFiles) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(reply)) {
      let body = m[1];
      const dflt = optionDefault.exec(body);
      if (dflt && body.startsWith('${')) body = dflt[2] + body.slice(dflt[0].length);
      const cut = body.indexOf('${');
      const prefix = cut === -1 ? body : body.slice(0, cut);
      if (prefix.length >= 4) prefixes.add(prefix);
    }
  }

  // Statically registered handlers in main, for the registered-vs-listed report.
  const registered = new Set();
  const reg = /\b(?:safeHandle|safeOn|safeOnce|ipcMain\.handle|ipcMain\.on|ipcMain\.once)\s*\(\s*(['"])([^'"\n]*)\1/g;
  for (const file of mainFiles) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(reg)) registered.add(m[2]);
  }

  const callSiteCount = invoke.size;
  for (const c of registered) if (quoted.has(c)) invoke.add(c);

  const sortedPrefixes = [...prefixes].sort();
  // A literal already covered by a dynamic prefix adds nothing; keep the file small.
  const channels = [...invoke].sort();
  const listenChannels = [...listen].sort();
  const isListed = (c) => invoke.has(c) || sortedPrefixes.some((p) => c.startsWith(p));
  const registeredList = [...registered].sort();

  return {
    format: 1,
    description:
      'IPC channels the renderer, runtime and built-in extensions send to main. LOG-ONLY: main logs a channel that is not here; nothing is blocked. Regenerate with `node scripts/ipc-channel-allowlist.mjs`.',
    channels,
    dynamicPrefixes: sortedPrefixes,
    listen: listenChannels,
    stats: {
      invokeChannels: channels.length,
      fromCallSites: callSiteCount,
      fromRegisteredNameReferences: channels.length - callSiteCount,
      dynamicPrefixes: sortedPrefixes.length,
      listenChannels: listenChannels.length,
      unresolvedCallSites: unresolved.length,
      registeredLiteralHandlersInMain: registeredList.length,
      registeredAndListed: registeredList.filter(isListed).length,
      registeredNotListed: registeredList.filter((c) => !isListed(c)).length,
    },
    unresolved: unresolved.sort(),
    registeredNotListed: registeredList.filter((c) => !isListed(c)),
  };
}

/**
 * The part of the list that is compared by `--check` and by the test: the
 * channels themselves. `stats`, `registeredNotListed` and the `unresolved`
 * file:line entries move with unrelated edits and are informational only.
 */
export function comparableList(result) {
  return {
    channels: [...result.channels],
    dynamicPrefixes: [...result.dynamicPrefixes],
    listen: [...result.listen],
  };
}

/** Serialized exactly as written to disk (stable, LF). */
export function serialize(result) {
  return JSON.stringify(result, null, 2) + '\n';
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const target = path.join(REPO_ROOT, OUTPUT_FILE);
  const next = serialize(deriveAllowlist());
  if (process.argv.includes('--check')) {
    let current = null;
    try {
      current = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch {
      current = null;
    }
    if (!current || JSON.stringify(comparableList(current)) !== JSON.stringify(comparableList(JSON.parse(next)))) {
      console.error(`${OUTPUT_FILE} is stale (channels, dynamicPrefixes or listen differ). Run: node scripts/ipc-channel-allowlist.mjs`);
      process.exit(1);
    }
    console.log(`${OUTPUT_FILE} is up to date`);
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, next);
    const s = JSON.parse(next).stats;
    console.log(`wrote ${OUTPUT_FILE}`, s);
  }
}
