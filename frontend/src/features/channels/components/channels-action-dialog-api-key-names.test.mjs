import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const helpersSource = readFileSync(new URL('../utils/api-key-names.ts', import.meta.url), 'utf8');
const dialogSource = readFileSync(new URL('./channels-action-dialog.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('channels-action-dialog.tsx', dialogSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

const { outputText: helpersJS } = ts.transpileModule(helpersSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
});
const helpers = {};
new Function('require', 'exports', helpersJS)(() => ({}), helpers);

async function loadThirdPartyHelper() {
  const fnNode = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'getThirdPartySubmitCredentials'
  );
  assert.ok(fnNode, 'getThirdPartySubmitCredentials must exist');
  const mod = [
    'const isClaudeCodeOAuthCredential = () => false;',
    `export ${fnNode.getText(ast).replace(/^export\s+/, '')}`,
  ].join('\n');
  const { outputText } = ts.transpileModule(mod, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}

test('computeSidebarDraftSummary and buildAPIKeyStateChanges defer enable/disable/delete atomically until save', () => {
  const keys = ['sk-a-1111', 'sk-b-2222', 'sk-c-3333'];
  const savedKeySet = new Set(keys);
  const serverDisabledMap = new Map([
    ['sk-b-2222', { key: 'sk-b-2222', errorCode: 401, reason: 'unauthorized', quotaDisabled: false }],
  ]);

  // Step 1: enable B in draft, then disable A & C -> still valid because B is draft-enabled (remaining = 1)
  const pendingEnableKeys = new Set(['sk-b-2222']);
  const pendingDisableKeys = new Set(['sk-a-1111']);
  const pendingDeleteKeys = new Set();

  const summary = helpers.computeSidebarDraftSummary({
    rawApiKeys: keys,
    apiKeyNames: [
      { key: 'sk-a-1111', name: 'Alpha' },
      { key: 'sk-c-3333', name: 'Alpha' },
    ],
    search: '',
    savedKeySet,
    serverDisabledMap,
    pendingDeleteKeys,
    pendingEnableKeys,
    pendingDisableKeys,
    selectedKeys: new Set(['sk-c-3333']),
  });

  assert.equal(summary.effectiveEnabledCount, 2); // B enabled, C enabled
  assert.equal(summary.rows[0].isPendingDisable, true);
  assert.equal(summary.rows[0].hasDuplicateName, true);
  assert.equal(summary.rows[1].isPendingEnable, true);
  assert.equal(summary.rows[2].hasDuplicateName, true);
  assert.equal(summary.canBatchDisable, true);

  // If user marks C for pending delete as well, B is still enabled, so effectiveEnabledCount stays 1 and disabling B is blocked
  const afterDeleteSummary = helpers.computeSidebarDraftSummary({
    rawApiKeys: keys,
    apiKeyNames: [],
    search: '',
    savedKeySet,
    serverDisabledMap,
    pendingDeleteKeys: new Set(['sk-c-3333']),
    pendingEnableKeys,
    pendingDisableKeys,
    selectedKeys: new Set(['sk-b-2222']),
  });
  assert.equal(afterDeleteSummary.effectiveEnabledCount, 1);
  assert.equal(afterDeleteSummary.rows[1].disableBlockedByLastEnabled, true);
  assert.equal(afterDeleteSummary.canBatchDisable, false);

  const stateChanges = helpers.buildAPIKeyStateChanges({
    effectiveKeys: afterDeleteSummary.effectiveKeys,
    savedKeySet,
    serverDisabledKeySet: new Set(['sk-b-2222']),
    pendingEnableKeys,
    pendingDisableKeys,
  });
  assert.deepEqual(stateChanges, {
    enableKeys: ['sk-b-2222'],
    disableKeys: ['sk-a-1111'],
  });
});

test('search keeps original key{N} positions and scopes select-all to filtered rows', () => {
  const keys = ['sk-first-1111', 'sk-second-2222', 'sk-third-3333'];
  const summary = helpers.computeSidebarDraftSummary({
    rawApiKeys: keys,
    apiKeyNames: [{ key: 'sk-third-3333', name: 'prod' }],
    search: 'prod',
    savedKeySet: new Set(keys),
    serverDisabledMap: new Map(),
    pendingDeleteKeys: new Set(),
    pendingEnableKeys: new Set(),
    pendingDisableKeys: new Set(),
    selectedKeys: new Set(['sk-third-3333']),
  });

  assert.equal(summary.filteredRows.length, 1);
  assert.equal(summary.filteredRows[0].position, 3);
  assert.equal(summary.filteredRows[0].fallbackName, 'key3');
  assert.equal(summary.filteredRows[0].customName, 'prod');
  assert.equal(summary.allFilteredSelected, true);
});

test('name normalization, Unicode length bounds, stale count, and Add Key validation work cleanly', () => {
  assert.deepEqual(helpers.normalizeAPIKeyNamesForKeys([{ key: 'sk-1', name: '   ' }], ['sk-1']), []);
  assert.equal(
    helpers.countStaleAPIKeyNames(
      [
        { key: 'sk-1', name: 'alive' },
        { key: 'sk-removed-in-textarea', name: 'stale' },
      ],
      ['sk-1']
    ),
    1
  );

  const exact64 = '名'.repeat(64);
  const over65 = '名'.repeat(65);
  assert.equal(helpers.validateAPIKeyName(`  ${exact64}  `).valid, true);
  assert.equal(helpers.validateAPIKeyName(over65).valid, false);
  assert.equal(helpers.validateNewSidebarKey('', 'name', []).error, 'emptyKey');
  assert.equal(helpers.validateNewSidebarKey('sk-1\nsk-2', 'name', []).error, 'multilineKey');
  assert.equal(helpers.validateNewSidebarKey('sk-1', 'name', ['sk-1']).error, 'duplicateKey');
  assert.equal(helpers.validateNewSidebarKey('sk-new', over65, ['sk-1']).error, 'nameTooLong');
});

test('third-party submit preserves apiKeyNames while dialog uses deferred draft submission', async () => {
  const { getThirdPartySubmitCredentials } = await loadThirdPartyHelper();
  const submitted = getThirdPartySubmitCredentials(
    { apiKey: '{"access_token":"x"}', apiKeys: ['sk-tp-1'], apiKeyNames: [{ key: 'sk-tp-1', name: 'tp-name' }] },
    { type: 'codex', authMode: 'third-party' }
  );
  assert.deepEqual(submitted, {
    apiKeys: ['sk-tp-1'],
    apiKeyNames: [{ key: 'sk-tp-1', name: 'tp-name' }],
  });

  // Ensure channels-action-dialog.tsx no longer sends immediate enable/disable mutations from the sidebar.
  assert.doesNotMatch(dialogSource, /useDisableChannelAPIKey|useEnableChannelAPIKey/);
  assert.match(dialogSource, /buildAPIKeyStateChanges/);
  assert.match(dialogSource, /apiKeyStateChanges/);
  assert.match(dialogSource, /staleNamesWarning/);
  assert.match(dialogSource, /saveToApplyHint/);
  assert.match(dialogSource, /normalizeAPIKeyNamesForKeys/);
});

test('draft edits preserve temporarily missing key names until submit normalization', () => {
  const initialNames = [
    { key: 'sk-a-1111', name: 'Alpha' },
    { key: 'sk-b-2222', name: 'Beta' },
  ];
  // User temporarily removes A from textarea, then renames B via setAPIKeyName without pruning:
  const afterDraftEdit = helpers.setAPIKeyName(initialNames, 'sk-b-2222', 'Beta-2');
  assert.equal(helpers.countStaleAPIKeyNames(afterDraftEdit, ['sk-b-2222']), 1);
  // If user puts A back before saving, its draft name is still intact:
  assert.deepEqual(
    helpers.normalizeAPIKeyNamesForKeys(afterDraftEdit, ['sk-a-1111', 'sk-b-2222']),
    [
      { key: 'sk-a-1111', name: 'Alpha' },
      { key: 'sk-b-2222', name: 'Beta-2' },
    ]
  );
  // If A stays removed on submit, final normalization drops A cleanly:
  assert.deepEqual(helpers.normalizeAPIKeyNamesForKeys(afterDraftEdit, ['sk-b-2222']), [
    { key: 'sk-b-2222', name: 'Beta-2' },
  ]);
});

test('all-disabled channels allow deleting extra disabled keys while keeping at least one credential', () => {
  const keys = ['sk-dis-1', 'sk-dis-2'];
  const savedKeySet = new Set(keys);
  const serverDisabledMap = new Map([
    ['sk-dis-1', { key: 'sk-dis-1', errorCode: 401, reason: 'err', quotaDisabled: false }],
    ['sk-dis-2', { key: 'sk-dis-2', errorCode: 401, reason: 'err', quotaDisabled: false }],
  ]);

  const singleSelect = helpers.computeSidebarDraftSummary({
    rawApiKeys: keys,
    apiKeyNames: [],
    search: '',
    savedKeySet,
    serverDisabledMap,
    pendingDeleteKeys: new Set(),
    pendingEnableKeys: new Set(),
    pendingDisableKeys: new Set(),
    selectedKeys: new Set(['sk-dis-1']),
  });
  assert.equal(singleSelect.effectiveEnabledCount, 0);
  assert.equal(singleSelect.rows[0].canDelete, true);
  assert.equal(singleSelect.rows[0].deleteBlockedByLastEnabled, false);
  assert.equal(singleSelect.canBatchDelete, true);
  assert.equal(singleSelect.batchDeleteBlockedByLastEnabled, false);

  const allSelect = helpers.computeSidebarDraftSummary({
    rawApiKeys: keys,
    apiKeyNames: [],
    search: '',
    savedKeySet,
    serverDisabledMap,
    pendingDeleteKeys: new Set(),
    pendingEnableKeys: new Set(),
    pendingDisableKeys: new Set(),
    selectedKeys: new Set(keys),
  });
  assert.equal(allSelect.canBatchDelete, false);
  assert.equal(allSelect.batchDeleteBlockedByLastKey, true);
});

test('Add Key guards against multiline clipboard paste and untouched edit omits apiKeyNames', () => {
  assert.equal(helpers.containsMultilineKey('sk-one\nsk-two'), true);
  assert.equal(helpers.containsMultilineKey('sk-one\r\nsk-two'), true);
  assert.equal(helpers.containsMultilineKey('sk-single'), false);

  assert.match(dialogSource, /containsMultilineKey/);
  assert.match(dialogSource, /onPaste=\{\(e\) =>/);
  assert.match(dialogSource, /addKeyMultilineError/);
  assert.match(dialogSource, /apiKeyNamesDirty/);
  assert.match(dialogSource, /filterActiveDisabledAPIKeys/);
});

test('filterActiveDisabledAPIKeys excludes elapsed temporary disables and retains active records', () => {
  const nowMs = Date.parse('2026-11-28T12:00:00.000Z');
  const records = [
    { key: 'sk-expired', errorCode: 429, expiresAt: '2026-11-28T11:59:59.000Z', quotaDisabled: false },
    { key: 'sk-future', errorCode: 429, expiresAt: '2026-11-28T12:05:00.000Z', quotaDisabled: false },
    { key: 'sk-perm', errorCode: 401, expiresAt: null, quotaDisabled: false },
    { key: 'sk-quota', errorCode: 0, quotaDisabled: true },
  ];

  assert.equal(helpers.isDisabledAPIKeyExpired(records[0], nowMs), true);
  assert.equal(helpers.isDisabledAPIKeyExpired(records[1], nowMs), false);
  assert.equal(helpers.isDisabledAPIKeyExpired(records[2], nowMs), false);
  assert.deepEqual(
    helpers.filterActiveDisabledAPIKeys(records, nowMs).map((r) => r.key),
    ['sk-future', 'sk-perm', 'sk-quota']
  );
  assert.match(dialogSource, /EMPTY_DISABLED_API_KEYS/);
});

test('edit dialog sends expectedUpdatedAt for credential drafts and shows inline conflict notice', () => {
  assert.match(dialogSource, /credentialBaselineUpdatedAt/);
  assert.match(dialogSource, /credentialConflictNotice/);
  assert.match(dialogSource, /expectedUpdatedAt:\s*credentialBaselineUpdatedAt/);
  assert.match(dialogSource, /isErrorCode\(error,\s*'CHANNEL_UPDATED_CONCURRENTLY'\)/);
});




