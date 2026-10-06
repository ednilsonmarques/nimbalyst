import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkI18n, compareLocaleTrees } from '../check-i18n.mjs';

test('reports missing, orphan, shape and placeholder differences with dotted keys', () => {
  const source = { a: 'A', group: { b: 'B {{count}}', c: 'C' }, flat: 'F' };
  const target = { group: { b: 'B', d: 'D' }, flat: { nested: 'x' }, extra: 'E' };
  assert.deepEqual(compareLocaleTrees(source, target), [
    { type: 'missing', key: 'a' },
    { type: 'placeholders', key: 'group.b' },
    { type: 'missing', key: 'group.c' },
    { type: 'orphan', key: 'group.d' },
    { type: 'shape', key: 'flat' },
    { type: 'orphan', key: 'extra' },
  ]);
});

test('accepts identical structure with translated text', () => {
  assert.deepEqual(compareLocaleTrees({ a: 'Hi {{name}}', b: { c: 'X' } }, { b: { c: 'Y' }, a: 'Oi {{name}}' }), []);
});

test('reports <Trans> tag differences and blank translations', () => {
  const source = { a: 'Run <code>{{cmd}}</code> now', b: 'Line<br/>break', c: 'Text', d: 'Go <strong>{{n}}</strong> & <1 min' };
  const target = { a: 'Rode {{cmd}} agora', b: 'Quebra<br/>de linha', c: '  ', d: '<strong>{{n}}</strong> & <1 min' };
  assert.deepEqual(compareLocaleTrees(source, target), [
    { type: 'tags', key: 'a' },
    { type: 'empty', key: 'c' },
  ]);
});

test('shipped translations match the English source', () => {
  assert.deepEqual(checkI18n(), []);
});
