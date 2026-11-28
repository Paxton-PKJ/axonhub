import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const { outputText: helperJS } = ts.transpileModule(
  readFileSync(new URL('../utils/api-key-label.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }
);
const helpers = {};
new Function('require', 'exports', helperJS)(() => ({}), helpers);

const columnsSource = readFileSync(new URL('./requests-columns.tsx', import.meta.url), 'utf8');
const detailSource = readFileSync(new URL('./request-detail-content.tsx', import.meta.url), 'utf8');
const requestsQuerySource = readFileSync(new URL('../data/requests.ts', import.meta.url), 'utf8');

test('resolveRequestListAPIKeyLabel and resolveRequestDetailAPIKeyDisplay handle all 7 display scenarios', () => {
  // 1. Key exists with custom name (single-key / third-party / multi-key)
  const named = {
    channelAPIKeyLabel: { name: 'prod-key', index: null, deleted: false },
    channelAPIKeyIndex: 1,
    channelAPIKeySuffix: '1234',
  };
  assert.equal(helpers.resolveRequestListAPIKeyLabel(named), 'prod-key');
  assert.deepEqual(helpers.resolveRequestDetailAPIKeyDisplay(named), {
    label: 'prod-key',
    suffix: '1234',
    visible: true,
  });

  // Named without suffix (e.g. short key or edge case) still shows in detail
  const namedNoSuffix = {
    channelAPIKeyLabel: { name: 'short-key', index: null, deleted: false },
    channelAPIKeyIndex: null,
    channelAPIKeySuffix: null,
  };
  assert.deepEqual(helpers.resolveRequestDetailAPIKeyDisplay(namedNoSuffix), {
    label: 'short-key',
    suffix: null,
    visible: true,
  });

  // 2. Key exists without custom name (multi-credential channel -> live index)
  const unnamedMulti = {
    channelAPIKeyLabel: { name: null, index: 3, deleted: false },
    channelAPIKeyIndex: 1,
    channelAPIKeySuffix: '5678',
  };
  assert.equal(helpers.resolveRequestListAPIKeyLabel(unnamedMulti), 'key3');
  assert.deepEqual(helpers.resolveRequestDetailAPIKeyDisplay(unnamedMulti), {
    label: 'key3',
    suffix: '5678',
    visible: true,
  });

  // 3. Key exists without custom name (single ordinary API key) -> list empty, detail shows suffix only
  const unnamedSingle = {
    channelAPIKeyLabel: { name: null, index: null, deleted: false },
    channelAPIKeyIndex: null,
    channelAPIKeySuffix: '9999',
  };
  assert.equal(helpers.resolveRequestListAPIKeyLabel(unnamedSingle), null);
  assert.deepEqual(helpers.resolveRequestDetailAPIKeyDisplay(unnamedSingle), {
    label: null,
    suffix: '9999',
    visible: true,
  });

  // 4. OAuth channel without custom name -> list empty, detail row hidden
  const oauth = {
    channelAPIKeyLabel: { name: null, index: null, deleted: false },
    channelAPIKeyIndex: null,
    channelAPIKeySuffix: null,
  };
  assert.equal(helpers.resolveRequestListAPIKeyLabel(oauth), null);
  assert.deepEqual(helpers.resolveRequestDetailAPIKeyDisplay(oauth), {
    label: null,
    suffix: null,
    visible: false,
  });

  // 5. Key deleted while channel exists (Method A) -> list null ('-'), detail preserves suffix only
  const deletedKey = {
    channelAPIKeyLabel: { name: null, index: null, deleted: true },
    channelAPIKeyIndex: 2,
    channelAPIKeySuffix: '4321',
  };
  assert.equal(helpers.resolveRequestListAPIKeyLabel(deletedKey), null);
  assert.deepEqual(helpers.resolveRequestDetailAPIKeyDisplay(deletedKey), {
    label: null,
    suffix: '4321',
    visible: true,
  });

  // 6. Legacy execution without fingerprint -> falls back to static channelAPIKeyIndex
  const legacy = {
    channelAPIKeyLabel: null,
    channelAPIKeyIndex: 2,
    channelAPIKeySuffix: '7777',
  };
  assert.equal(helpers.resolveRequestListAPIKeyLabel(legacy), 'key2');
  assert.deepEqual(helpers.resolveRequestDetailAPIKeyDisplay(legacy), {
    label: 'key2',
    suffix: '7777',
    visible: true,
  });

  // 7. Deleted channel or unauthorized reader -> returns null / hidden
  const deletedChannel = {
    channelAPIKeyLabel: null,
    channelAPIKeyIndex: null,
    channelAPIKeySuffix: null,
  };
  assert.equal(helpers.resolveRequestListAPIKeyLabel(deletedChannel), null);
  assert.deepEqual(helpers.resolveRequestDetailAPIKeyDisplay(deletedChannel), {
    label: null,
    suffix: null,
    visible: false,
  });
});

test('request list, detail, and GraphQL queries are wired to channelAPIKeyLabel', () => {
  assert.match(columnsSource, /resolveRequestListAPIKeyLabel/);
  assert.match(detailSource, /resolveRequestDetailAPIKeyDisplay/);
  const matches = requestsQuerySource.match(/channelAPIKeyLabel\s*\{[\s\S]*?name[\s\S]*?index[\s\S]*?deleted[\s\S]*?\}/g) ?? [];
  assert.equal(matches.length, 2, 'both buildRequestsQuery and buildRequestExecutionsQuery must select channelAPIKeyLabel');
});
