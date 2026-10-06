#!/usr/bin/env node

// Checks that every translation mirrors the English source resources in
// packages/runtime/src/i18n/locales:
//   - missing: key exists in `en` but not in the translation
//   - orphan: key exists in the translation but not in `en`
//   - shape: a key is a string in one language and a nested object in the other
//   - placeholders: `{{name}}` interpolations differ from the English string
//   - tags: `<Trans>` component tags (`<strong>`, `</code>`, `<br/>`) differ
//   - empty: the translation is blank while the English string is not
// Namespace files (`<ns>.json`) must exist in every language directory.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LOCALES_DIR = path.join(repoRoot, 'packages/runtime/src/i18n/locales');
export const SOURCE_LANGUAGE = 'en';

const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*(?:,[^}]*)?\}\}/g;
const TAG = /<(\/?)([A-Za-z][\w-]*|\d+)\s*(\/?)>/g;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function placeholders(text) {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1]).sort();
}

function tags(text) {
  return [...text.matchAll(TAG)].map((m) => `${m[1]}${m[2]}${m[3]}`).sort();
}

/** Compare one namespace of a translation against the English source. */
export function compareLocaleTrees(source, target, prefix = '') {
  const issues = [];
  for (const key of Object.keys(source)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    if (!(key in target)) {
      issues.push({ type: 'missing', key: keyPath });
      continue;
    }
    const s = source[key];
    const t = target[key];
    if (isPlainObject(s) !== isPlainObject(t)) {
      issues.push({ type: 'shape', key: keyPath });
    } else if (isPlainObject(s)) {
      issues.push(...compareLocaleTrees(s, t, keyPath));
    } else if (typeof s === 'string' && typeof t === 'string') {
      if (placeholders(s).join(',') !== placeholders(t).join(',')) {
        issues.push({ type: 'placeholders', key: keyPath });
      }
      if (tags(s).join(',') !== tags(t).join(',')) {
        issues.push({ type: 'tags', key: keyPath });
      }
      if (s.trim() !== '' && t.trim() === '') {
        issues.push({ type: 'empty', key: keyPath });
      }
    }
  }
  for (const key of Object.keys(target)) {
    if (!(key in source)) {
      issues.push({ type: 'orphan', key: prefix ? `${prefix}.${key}` : key });
    }
  }
  return issues;
}

function listNamespaces(dir) {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -'.json'.length))
    .sort();
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Returns a flat list of `{ language, namespace, type, key }` issues. */
export function checkI18n(localesDir = LOCALES_DIR) {
  const languages = readdirSync(localesDir).filter((entry) =>
    statSync(path.join(localesDir, entry)).isDirectory(),
  );
  if (!languages.includes(SOURCE_LANGUAGE)) {
    throw new Error(`Source language directory "${SOURCE_LANGUAGE}" not found in ${localesDir}`);
  }
  const sourceNamespaces = listNamespaces(path.join(localesDir, SOURCE_LANGUAGE));
  const issues = [];

  for (const language of languages.filter((l) => l !== SOURCE_LANGUAGE).sort()) {
    const dir = path.join(localesDir, language);
    const namespaces = listNamespaces(dir);
    for (const namespace of sourceNamespaces) {
      if (!namespaces.includes(namespace)) {
        issues.push({ language, namespace, type: 'missing-namespace', key: '*' });
        continue;
      }
      const source = readJson(path.join(localesDir, SOURCE_LANGUAGE, `${namespace}.json`));
      const target = readJson(path.join(dir, `${namespace}.json`));
      for (const issue of compareLocaleTrees(source, target)) {
        issues.push({ language, namespace, ...issue });
      }
    }
    for (const namespace of namespaces) {
      if (!sourceNamespaces.includes(namespace)) {
        issues.push({ language, namespace, type: 'orphan-namespace', key: '*' });
      }
    }
  }
  return issues;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const issues = checkI18n();
  if (issues.length === 0) {
    console.log('[check-i18n] All translations match the English source.');
  } else {
    for (const { language, namespace, type, key } of issues) {
      console.error(`[check-i18n] ${language}/${namespace}.json: ${type} ${key}`);
    }
    console.error(`[check-i18n] ${issues.length} issue(s) found.`);
    process.exit(1);
  }
}
