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

test('edit dialog sends expectedCredentialsVersion for credential drafts and shows inline conflict notice', () => {
  assert.match(dialogSource, /credentialBaselineVersion/);
  assert.match(dialogSource, /credentialConflictNotice/);
  assert.match(dialogSource, /expectedCredentialsVersion:\s*credentialBaselineVersion/);
  assert.match(dialogSource, /isErrorCode\(error,\s*'CHANNEL_UPDATED_CONCURRENTLY'\)/);
});

test('ChannelsDialogs keeps same-channel dialog mounted on details refetch and guards initial detail load failures', async () => {
  const dialogsSource = readFileSync(new URL('./channels-dialogs.tsx', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(dialogsSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2023 },
  });

  const state = [];
  const refs = [];
  const effects = [];
  const effectSlots = [];
  let cursor = 0;
  let refCursor = 0;
  let effectCursor = 0;
  let stateDirty = false;
  let initialized = false;

  const partialRow1 = { id: 'ch-1', name: 'channel-one' };
  const fullRow1 = {
    id: 'ch-1',
    name: 'channel-one',
    updatedAt: '2026-11-28T00:00:00.000Z',
    credentialsVersion: 'ver-1',
    credentials: { apiKeys: ['sk-1'] },
  };
  const refetchedRow1 = {
    id: 'ch-1',
    name: 'channel-one',
    updatedAt: '2026-11-28T00:01:00.000Z',
    credentialsVersion: 'ver-2',
    credentials: { apiKeys: ['sk-2'] },
  };
  const mutatedRow1 = {
    id: 'ch-1',
    name: 'channel-one',
    updatedAt: '2026-11-28T00:02:00.000Z',
    credentialsVersion: 'ver-3',
    credentials: { apiKeys: ['sk-3'] },
  };
  const partialRow2 = { id: 'ch-2', name: 'channel-two' };
  const fullRow2 = {
    id: 'ch-2',
    name: 'channel-two',
    updatedAt: '2026-11-28T00:03:00.000Z',
    credentialsVersion: 'ver-4',
    credentials: { apiKeys: ['sk-4'] },
  };

  let openType = 'edit';
  let contextRow = partialRow1;
  let queryData = undefined;
  let queryIsError = false;
  let queryIsFetching = false;
  let refetchCalls = 0;
  let contextDirty = false;

  const hooks = {
    useState(initial) {
      const slot = cursor++;
      if (!(slot in state)) state[slot] = typeof initial === 'function' ? initial() : initial;
      return [
        state[slot],
        (next) => {
          const prev = state[slot];
          state[slot] = typeof next === 'function' ? next(prev) : next;
          if (!Object.is(prev, state[slot])) stateDirty = true;
        },
      ];
    },
    useRef(initial) {
      const slot = refCursor++;
      if (!(slot in refs)) refs[slot] = { current: initial };
      return refs[slot];
    },
    useEffect(effect, deps) {
      const slot = effectCursor++;
      const prev = effectSlots[slot];
      const changed =
        !prev || !deps || !prev.deps || deps.length !== prev.deps.length || deps.some((d, i) => !Object.is(d, prev.deps[i]));
      if (changed) {
        effects.push(() => {
          prev?.cleanup?.();
          const cleanup = effect();
          effectSlots[slot] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
        });
      }
    },
  };

  const modules = {
    react: hooks,
    'react/jsx-runtime': {
      Fragment: 'Fragment',
      jsx: (type, props) => ({ type, props }),
      jsxs: (type, props) => ({ type, props }),
    },
    'react-i18next': { useTranslation: () => ({ t: (k) => k }) },
    '../context/channels-context': {
      useChannels: () => ({
        open: openType,
        setOpen: (next) => {
          openType = next;
        },
        get currentRow() {
          return contextRow;
        },
        setCurrentRow(next) {
          const prev = contextRow;
          contextRow = typeof next === 'function' ? next(prev) : next;
          if (!Object.is(prev, contextRow)) contextDirty = true;
        },
        selectedChannels: [],
      }),
    },
    '../data/channels': {
      useChannelDetails: () => ({
        data: queryData,
        isError: queryIsError,
        isFetching: queryIsFetching,
        refetch: () => {
          refetchCalls += 1;
          return Promise.resolve();
        },
      }),
    },
    './channels-action-dialog': { ChannelsActionDialog: 'ChannelsActionDialog' },
    './channels-api-key-management-dialog': { ChannelsAPIKeyManagementDialog: 'ChannelsAPIKeyManagementDialog' },
    './channels-status-dialog': { ChannelsStatusDialog: 'ChannelsStatusDialog' },
  };
  const moduleProxy = (name) =>
    modules[name] ?? new Proxy({}, { get: (_, key) => (typeof key === 'string' ? key : undefined) });
  const exports = {};
  new Function('require', 'exports', outputText)(moduleProxy, exports);

  function collect(node) {
    if (Array.isArray(node)) return node.flatMap(collect);
    if (!node || typeof node !== 'object') return [];
    return [node, ...collect(node.props?.children)];
  }

  function findEditDialog(tree) {
    return collect(tree).find((n) => n.type === 'ChannelsActionDialog' && n.props?.open === true && n.props?.currentRow);
  }

  function findKeyManagementDialog(tree) {
    return collect(tree).find((n) => n.type === 'ChannelsAPIKeyManagementDialog' && n.props?.open === true);
  }

  function findRetryDialog(tree) {
    return collect(tree).find((n) => n.type === 'Dialog' && n.props?.open === true);
  }

  function renderCycle() {
    const snapshots = [];
    for (let pass = 0; pass < 6; pass++) {
      cursor = 0;
      refCursor = 0;
      effectCursor = 0;
      stateDirty = false;
      contextDirty = false;
      const tree = exports.ChannelsDialogs();
      snapshots.push({
        tree,
        editDialog: findEditDialog(tree),
        keyDialog: findKeyManagementDialog(tree),
        retryDialog: findRetryDialog(tree),
      });
      const pending = effects.splice(0);
      pending.forEach((fn) => fn());
      if (!initialized) {
        initialized = true;
        continue;
      }
      if (!stateDirty && !contextDirty) break;
    }
    return snapshots;
  }

  // 1a. Initial detail failure on credential dialogs (edit, keyManagement) shows Retry dialog and never mounts with partial row.
  queryIsError = true;
  openType = 'keyManagement';
  const keyErr = renderCycle();
  assert.equal(keyErr[keyErr.length - 1].keyDialog, undefined, 'keyManagement must not mount when initial detail query fails');
  const retryDialog = keyErr[keyErr.length - 1].retryDialog;
  assert.ok(retryDialog, 'retry dialog must render on initial detail load error');
  const retryBtn = collect(retryDialog).find((n) => n.type === 'Button' && n.props?.children === 'channels.dialogs.detailsLoadError.retry');
  assert.ok(retryBtn);
  retryBtn.props.onClick();
  assert.equal(refetchCalls, 1);

  openType = 'edit';
  const editErr = renderCycle();
  assert.equal(editErr[editErr.length - 1].editDialog, undefined, 'edit must not mount when initial detail query fails');
  assert.ok(editErr[editErr.length - 1].retryDialog);

  // Non-credential dialogs (e.g. status) keep fallback behavior when detail load fails.
  openType = 'status';
  const statusFallback = renderCycle();
  const statusDialog = collect(statusFallback[statusFallback.length - 1].tree).find(
    (n) => n.type === 'ChannelsStatusDialog' && n.props?.open === true
  );
  assert.equal(statusDialog?.props.currentRow, partialRow1);
  assert.equal(statusFallback[statusFallback.length - 1].retryDialog, undefined);

  // 1b. Recovery after retry hydrates normally.
  openType = 'edit';
  queryIsError = false;
  const waiting = renderCycle();
  assert.equal(waiting[waiting.length - 1].editDialog, undefined);

  queryData = fullRow1;
  const hydrated = renderCycle();
  assert.equal(hydrated[hydrated.length - 1].editDialog?.props.currentRow, fullRow1);
  assert.equal(hydrated[hydrated.length - 1].retryDialog, undefined);

  // Subsequent background error AFTER hydration keeps the open dialog mounted with its hydrated snapshot.
  queryIsError = true;
  const bgError = renderCycle();
  assert.equal(bgError[bgError.length - 1].editDialog?.props.currentRow, fullRow1);
  assert.equal(bgError[bgError.length - 1].retryDialog, undefined);
  queryIsError = false;

  // 2. Background/conflict refetch returning a new object for ch-1 must NEVER drop the dialog on any pass.
  queryData = refetchedRow1;
  const refetched = renderCycle();
  assert.ok(refetched.every((s) => s.editDialog !== undefined), 'dialog must remain mounted across every render pass on refetch');
  assert.equal(refetched[refetched.length - 1].editDialog?.props.currentRow, refetchedRow1);

  // 3. Local child update (commitMutationResult) must stay mounted and NOT revert to stale detailsQuery.data.
  contextRow = mutatedRow1;
  const localUpdated = renderCycle();
  assert.ok(localUpdated.every((s) => s.editDialog !== undefined), 'dialog must remain mounted across local currentRow update');
  assert.equal(localUpdated[localUpdated.length - 1].editDialog?.props.currentRow, mutatedRow1);
  assert.equal(contextRow, mutatedRow1);

  // 3b. Fast close -> reopen of the same channel within 500ms (table sets summary row while hydratedRowId is still ch-1)
  // must immediately use cached full details and NEVER pass the partial summary row to credential dialogs.
  openType = null;
  renderCycle();
  contextRow = partialRow1;
  openType = 'keyManagement';
  const fastReopenCached = renderCycle();
  assert.ok(
    fastReopenCached.every((s) => s.keyDialog?.props.currentRow !== partialRow1),
    'fast reopen with cached details must never pass partial summary row'
  );
  assert.equal(fastReopenCached[0].keyDialog?.props.currentRow, refetchedRow1);
  assert.equal(fastReopenCached[fastReopenCached.length - 1].keyDialog?.props.currentRow, refetchedRow1);
  assert.equal(contextRow, refetchedRow1);

  // 3c. Fast close -> reopen of the same channel within 500ms when details cache is empty must wait (or show Retry on error)
  // and never leak the partial summary row to credential dialogs.
  openType = null;
  renderCycle();
  contextRow = partialRow1;
  queryData = undefined;
  openType = 'edit';
  const fastReopenLoading = renderCycle();
  assert.ok(
    fastReopenLoading.every((s) => s.editDialog === undefined),
    'fast reopen without cached details must wait for full details'
  );
  queryIsError = true;
  const fastReopenError = renderCycle();
  assert.equal(fastReopenError[fastReopenError.length - 1].editDialog, undefined);
  assert.ok(fastReopenError[fastReopenError.length - 1].retryDialog, 'fast reopen error must show retry dialog');
  queryIsError = false;
  queryData = fullRow1;
  const fastReopenRecovered = renderCycle();
  assert.equal(fastReopenRecovered[fastReopenRecovered.length - 1].editDialog?.props.currentRow, fullRow1);
  assert.equal(contextRow, fullRow1);

  // 4. Switching to ch-2 resets hydration and waits for ch-2 details before mounting.
  contextRow = partialRow2;
  const switching = renderCycle();
  assert.equal(switching[switching.length - 1].editDialog, undefined);

  queryData = fullRow2;
  const switched = renderCycle();
  assert.equal(switched[switched.length - 1].editDialog?.props.currentRow, fullRow2);

  effectSlots.forEach((slot) => slot?.cleanup?.());
});

test('ChannelsActionDialog initializes once per open session from latest snapshot and preserves drafts across same-ID refetches', async () => {
  const { outputText } = ts.transpileModule(dialogSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2023 },
  });

  const state = [];
  const refs = [];
  const effects = [];
  const effectSlots = [];
  let cursor = 0;
  let refCursor = 0;
  let effectCursor = 0;
  let stateDirty = false;
  let initialized = false;

  const hooks = {
    memo: (fn) => fn,
    useCallback: (fn) => fn,
    useMemo: (compute) => compute(),
    useState(initial) {
      const slot = cursor++;
      if (!(slot in state)) state[slot] = typeof initial === 'function' ? initial() : initial;
      return [
        state[slot],
        (next) => {
          const prev = state[slot];
          state[slot] = typeof next === 'function' ? next(prev) : next;
          if (!Object.is(prev, state[slot])) stateDirty = true;
        },
      ];
    },
    useRef(initial) {
      const slot = refCursor++;
      if (!(slot in refs)) refs[slot] = { current: initial };
      return refs[slot];
    },
    useEffect(effect, deps) {
      const slot = effectCursor++;
      const prev = effectSlots[slot];
      const changed =
        !prev || !deps || !prev.deps || deps.length !== prev.deps.length || deps.some((d, i) => !Object.is(d, prev.deps[i]));
      if (changed) {
        effects.push(() => {
          prev?.cleanup?.();
          const cleanup = effect();
          effectSlots[slot] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
        });
      }
    },
  };

  let formValues = {};
  const resetCalls = [];
  const updateCalls = [];
  let disabledKeys = [];

  const mockForm = {
    control: {},
    formState: { dirtyFields: {} },
    reset(nextValues = {}) {
      resetCalls.push(structuredClone(nextValues));
      formValues = structuredClone(nextValues);
    },
    watch(path) {
      if (!path) return formValues;
      return path.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), formValues);
    },
    getValues(path) {
      return path ? mockForm.watch(path) : formValues;
    },
    setValue(path, val) {
      const parts = path.split('.');
      let target = formValues;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!target[parts[i]] || typeof target[parts[i]] !== 'object') target[parts[i]] = {};
        target = target[parts[i]];
      }
      target[parts[parts.length - 1]] = val;
    },
    setError() {},
    clearErrors() {},
    resetField() {},
    handleSubmit: (fn) => () => fn(structuredClone(formValues)),
  };

  const modules = {
    react: hooks,
    'react/jsx-runtime': {
      Fragment: 'Fragment',
      jsx: (type, props) => ({ type, props }),
      jsxs: (type, props) => ({ type, props }),
    },
    'react-hook-form': {
      useForm: ({ defaultValues }) => {
        if (Object.keys(formValues).length === 0 && defaultValues) {
          formValues = structuredClone(defaultValues);
        }
        return mockForm;
      },
      useFieldArray: () => ({ fields: [], append() {}, remove() {} }),
    },
    '@hookform/resolvers/zod': { zodResolver: () => async () => ({ values: {}, errors: {} }) },
    '@tanstack/react-virtual': {
      useVirtualizer: () => ({ getTotalSize: () => 0, getVirtualItems: () => [] }),
    },
    'react-i18next': { useTranslation: () => ({ t: (k) => k, i18n: { language: 'en' } }) },
    sonner: { toast: { success() {}, error() {}, warning() {} } },
    '@/lib/error-parser': { isErrorCode: () => false },
    '@/hooks/use-horizontal-scroll': { useHorizontalScroll: () => () => {} },
    '@/hooks/usePermissions': { usePermissions: () => ({ hasSystemScope: () => true, channelPermissions: { canWrite: true } }) },
    '@/features/system/data/system': {
      usePassThroughSettings: () => ({ data: undefined }),
      useProxyPresets: () => ({ data: [] }),
      useQuotaRoutingSettings: () => ({ data: undefined }),
      useRetryPolicy: () => ({ data: undefined }),
      useSaveProxyPreset: () => ({ mutate() {} }),
      useUserAgentPassThroughSettings: () => ({ data: undefined }),
    },
    '../../models/data/model-suggestions': { isSuggestedModel: () => true },
    '../data/channel-model-aliases': {
      filterChannelModelGroups: () => [],
      groupChannelModelEntries: () => [],
    },
    '../data/channels': {
      useCreateChannel: () => ({ isPending: false, mutateAsync: async () => ({}) }),
      useDuplicateChannel: () => ({ isPending: false, mutateAsync: async () => ({}) }),
      useUpdateChannelSettings: () => ({
        isPending: false,
        mutateAsync: async (payload) => {
          updateCalls.push(structuredClone(payload));
          return {};
        },
      }),
      useFetchModels: () => ({ isPending: false, mutateAsync: async () => ({ models: [] }) }),
      useAllChannelNames: () => ({ data: [], isSuccess: true }),
      useAllChannelTags: () => ({ data: [], isLoading: false }),
      useChannelDisabledAPIKeys: () => ({ data: disabledKeys }),
      useSyncChannelModels: () => ({ isPending: false, mutateAsync: async () => ({ supportedModels: [], manualModels: [] }) }),
    },
    '../data/config_channels': {
      CHANNEL_CONFIGS: { openai: { apiFormat: 'openai/chat_completions', defaultModels: ['gpt-4o'], baseURL: 'https://api.openai.com/v1' } },
      OPENAI_CHAT_COMPLETIONS: 'openai/chat_completions',
      OPENAI_RESPONSES: 'openai/responses',
      ANTHROPIC_MESSAGES: 'anthropic/messages',
      GEMINI_CONTENTS: 'gemini/contents',
      getDefaultBaseURL: () => 'https://api.openai.com/v1',
      getDefaultModels: () => ['gpt-4o'],
    },
    '../data/config_providers': {
      PROVIDER_CONFIGS: { openai: { icon: 'icon', channelTypes: ['openai'] } },
      getProviderFromChannelType: () => 'openai',
      getApiFormatsForProvider: () => ['openai/chat_completions'],
      getChannelTypeForApiFormat: () => 'openai',
    },
    '../data/protocol-options': {
      buildCodexResponsesEndpoints: (e) => e,
      getCodexResponsesWebSocketState: () => ({ enabled: false }),
      getCodexResponsesWebSocketURL: () => undefined,
      hasCodexResponsesWebSocketOverrideReplacement: () => false,
      getInitialApiFormatForChannel: () => 'openai/chat_completions',
      getModelProtocolsForApiFormat: () => [],
      toHttpBaseURL: (u) => u,
      translateLegacyCodexModelProtocols: () => undefined,
    },
    '../data/schema': {
      createChannelInputSchema: {},
      updateChannelInputSchema: {},
    },
    '../data/use-channel-model-preview': { useChannelModelPreview: () => ({ groups: [] }) },
    '../hooks/use-oauth-flow': { useOAuthFlow: () => ({ reset() {} }) },
    '../utils/merge': { mergeChannelSettingsForUpdate: (_orig, patch) => patch },
    '../utils/pattern': { isValidModelPattern: () => true, matchesModelPattern: () => true },
    '../utils/api-key-names': helpers,
    './channels-proxy-dialog': { ProxyType: { ENVIRONMENT: 'environment', URL: 'url', DISABLED: 'disabled' } },
    '../data/channel-realtime': {
      getChannelBaseURLInputValue: (_fmt, base) => base || '',
      getModelFetchBaseURL: (_fmt, base) => base || '',
      getRealtimeClientEventsPerSecondInputValue: () => '',
      getRealtimeHandshakeTimeoutInputValue: () => '',
      getRealtimeQuickModels: () => undefined,
      isRealtimeProtocol: () => false,
      isRealtimeQuickModel: () => false,
      realtimeForSelection: () => undefined,
      withoutRealtimeModelProtocols: (p) => p,
    },
  };
  const moduleProxy = (name) =>
    modules[name] ?? new Proxy({}, { get: (_, key) => (typeof key === 'string' ? key : undefined) });
  const exports = {};
  new Function('require', 'exports', outputText)(moduleProxy, exports);

  function collect(node) {
    if (Array.isArray(node)) return node.flatMap(collect);
    if (!node || typeof node !== 'object') return [];
    return [node, ...collect(node.props?.children)];
  }

  let currentProps = {
    open: false,
    onOpenChange() {},
    currentRow: {
      id: 'ch-1',
      type: 'openai',
      name: 'ch-1',
      baseURL: 'https://api.openai.com/v1',
      supportedModels: ['gpt-4o'],
      defaultTestModel: 'gpt-4o',
      autoSyncSupportedModels: false,
      credentialsVersion: 'ver-0',
      credentials: { apiKeys: ['sk-v0-1111', 'sk-v0-2222'], apiKeyNames: [] },
    },
  };

  function renderDialog() {
    let tree;
    for (let pass = 0; pass < 6; pass++) {
      cursor = 0;
      refCursor = 0;
      effectCursor = 0;
      stateDirty = false;
      tree = exports.ChannelsActionDialog(currentProps);
      const pending = effects.splice(0);
      pending.forEach((fn) => fn());
      if (!initialized) {
        initialized = true;
        continue;
      }
      if (!stateDirty) break;
    }
    return tree;
  }

  // Scenario A: Dialog is mounted closed with row_v0, keys rotate on server to row_v1 before opening.
  renderDialog();
  const rowV1 = {
    ...currentProps.currentRow,
    credentialsVersion: 'ver-1',
    credentials: { apiKeys: ['sk-v1-1111', 'sk-v1-2222'], apiKeyNames: [] },
  };
  currentProps = { ...currentProps, currentRow: rowV1 };
  renderDialog();

  // Open dialog now with rowV1: form.reset must load rowV1 keys (not stale row_v0!).
  currentProps = { ...currentProps, open: true };
  let tree = renderDialog();
  assert.equal(resetCalls.length, 1);
  assert.deepEqual(resetCalls[0].credentials.apiKeys, ['sk-v1-1111', 'sk-v1-2222']);
  assert.deepEqual(formValues.credentials.apiKeys, ['sk-v1-1111', 'sk-v1-2222']);

  // Scenario B: Stage a pending disable in the sidebar, then receive a background same-ID refetch (rowV2).
  const disableButtons = collect(tree).filter(
    (n) => n.type === 'Button' && n.props?.['aria-label'] === 'channels.dialogs.fields.apiKey.disable'
  );
  assert.equal(disableButtons.length, 2);
  disableButtons[0].props.onClick(); // stage pendingDisableKeys = {'sk-v1-1111'}
  tree = renderDialog();

  const rowV2 = {
    ...currentProps.currentRow,
    credentialsVersion: 'ver-2',
    credentials: { apiKeys: ['sk-v2-rotated-only'], apiKeyNames: [] },
  };
  currentProps = { ...currentProps, currentRow: rowV2 };
  tree = renderDialog();

  // Background refetch for same ID must NOT re-reset form, must NOT clear pendingDisableKeys, and must keep ver-1 baseline.
  assert.equal(resetCalls.length, 1, 'same-ID background refetch must not wipe open edit form');
  const formEl = collect(tree).find((n) => n.type === 'form');
  assert.ok(formEl);
  await formEl.props.onSubmit();

  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].expectedCredentialsVersion, 'ver-1');
  assert.deepEqual(updateCalls[0].input.credentials.apiKeys, ['sk-v1-1111', 'sk-v1-2222']);
  assert.deepEqual(updateCalls[0].apiKeyStateChanges, { disableKeys: ['sk-v1-1111'] });

  effectSlots.forEach((slot) => slot?.cleanup?.());
});
