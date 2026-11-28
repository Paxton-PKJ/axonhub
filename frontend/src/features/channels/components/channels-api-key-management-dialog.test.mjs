import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

// Execute the shipped component with controlled hooks and mutation boundaries. The
// returned JSX tree retains its real event handlers and status/count computations.
const { outputText } = ts.transpileModule(
  readFileSync(new URL('./channels-api-key-management-dialog.tsx', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2023 } }
);

const { outputText: apiKeyNamesJS } = ts.transpileModule(
  readFileSync(new URL('../utils/api-key-names.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }
);
const apiKeyNamesExports = {};
new Function('require', 'exports', apiKeyNamesJS)(() => ({}), apiKeyNamesExports);

function manager(initialRowOverride, options = {}) {
  const ref = 'vertex-sa:synthetic-account';
  const state = [];
  const refs = [];
  let cursor = 0;
  let refCursor = 0;
  let initialized = false;
  let disabledKeys = [];
  const baseRow = initialRowOverride ?? {
    id: 'channel-synthetic',
    type: 'gemini_vertex',
    name: 'synthetic',
    credentials: {
      apiKeys: ['synthetic-key'],
      vertexServiceAccounts: [{ credentialRef: ref, jsonData: '{}', projectID: 'synthetic' }],
    },
  };
  let activeRow = structuredClone(baseRow);
  let serverCredentials = structuredClone(activeRow.credentials ?? {});
  let serverVersion = 0;
  let serverCredentialsVersion =
    'credentialsVersion' in activeRow
      ? activeRow.credentialsVersion
      : activeRow.credentials
        ? `ver-${activeRow.id ?? 'synthetic'}-0`
        : undefined;
  activeRow.credentialsVersion = serverCredentialsVersion;
  let disabledKeysUpdatedAt = 1;
  const updateChannelCalls = [];
  const enableSelectedCalls = [];
  const disableSelectedCalls = [];
  const deleteDisabledCalls = [];
  const effects = [];
  const effectSlots = [];
  let effectCursor = 0;
  let stateDirty = false;
  const mutation = (mutateAsync = async () => {}) => ({ mutateAsync, isPending: false });
  const hooks = {
    useState(initial) {
      const slot = cursor++;
      if (!(slot in state)) state[slot] = typeof initial === 'function' ? initial() : initial;
      return [
        state[slot],
        (next) => {
          const prev = state[slot];
          state[slot] = typeof next === 'function' ? next(prev) : next;
          if (!Object.is(prev, state[slot])) {
            stateDirty = true;
          }
        },
      ];
    },
    useMemo: (compute) => compute(),
    useRef(initial) {
      const slot = refCursor++;
      if (!(slot in refs)) refs[slot] = { current: initial };
      return refs[slot];
    },
    useEffect(effect, deps) {
      const slot = effectCursor++;
      const prev = effectSlots[slot];
      const changed =
        !prev ||
        !deps ||
        !prev.deps ||
        deps.length !== prev.deps.length ||
        deps.some((d, i) => !Object.is(d, prev.deps[i]));
      if (changed) {
        effects.push(() => {
          prev?.cleanup?.();
          const cleanup = effect();
          effectSlots[slot] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
        });
      }
    },
  };
  const data = {
    fetchLatestChannel: async (id) => {
      const defaultFetch = async () => ({
        ...activeRow,
        id,
        ...(serverCredentialsVersion !== undefined ? { credentialsVersion: serverCredentialsVersion } : {}),
        credentials: structuredClone(serverCredentials),
      });
      if (options.onFetchLatestChannel) {
        return options.onFetchLatestChannel(id, defaultFetch);
      }
      return defaultFetch();
    },
    useChannelDisabledAPIKeys: () => ({
      data: disabledKeys,
      isLoading: false,
      dataUpdatedAt: disabledKeysUpdatedAt,
      refetch: async () => ({ data: disabledKeys }),
    }),
    useDisableChannelAPIKey: () =>
      mutation(async ({ key }) => {
        if (!disabledKeys.some((item) => item.key === key)) {
          disabledKeys = [...disabledKeys, { key, errorCode: 0, reason: 'Manually disabled by user', quotaDisabled: false }];
        }
      }),
    useEnableChannelAPIKey: () =>
      mutation(async ({ key }) => {
        disabledKeys = disabledKeys.filter((item) => item.key !== key);
      }),
    useEnableSelectedChannelAPIKeys: () =>
      mutation(async ({ channelID, keys }) => {
        enableSelectedCalls.push({ channelID, keys });
        const set = new Set(keys);
        disabledKeys = disabledKeys.filter((item) => !set.has(item.key));
        return true;
      }),
    useDisableSelectedChannelAPIKeys: () =>
      mutation(async ({ channelID, keys }) => {
        disableSelectedCalls.push({ channelID, keys });
        const existing = new Set(disabledKeys.map((item) => item.key));
        for (const key of keys) {
          if (!existing.has(key)) {
            disabledKeys = [...disabledKeys, { key, errorCode: 0, reason: 'Manually disabled by user', quotaDisabled: false }];
          }
        }
        return true;
      }),
    useTestChannelAPIKey: () =>
      mutation(async ({ key }) =>
        options.onTestKey
          ? options.onTestKey({ key })
          : {
              keyPrefix: `****${key.slice(-4)}`,
              success: true,
              latency: 1,
              disabled: disabledKeys.some((item) => item.key === key),
            }
      ),
    useUpdateChannel: () =>
      mutation(async (payload) => {
        const executeDefault = async () => {
          updateChannelCalls.push(payload);
          if (
            serverCredentialsVersion &&
            payload.expectedCredentialsVersion &&
            payload.expectedCredentialsVersion !== serverCredentialsVersion
          ) {
            throw {
              errors: [
                {
                  message: 'channel was updated concurrently; retry the operation',
                  extensions: { code: 'CHANNEL_UPDATED_CONCURRENTLY' },
                },
              ],
            };
          }
          if (payload.input?.credentials) {
            serverCredentials = { ...serverCredentials, ...structuredClone(payload.input.credentials) };
            const survivingRefs = new Set([
              ...(serverCredentials.apiKeys ?? []),
              ...((serverCredentials.vertexApiKeys ?? []).map((item) => item.apiKey)),
              ...((serverCredentials.vertexServiceAccounts ?? [])
                .map((item) => item.credentialRef)
                .filter(Boolean)),
            ]);
            disabledKeys = disabledKeys.filter((item) => survivingRefs.has(item.key));
          }
          if (serverCredentialsVersion !== undefined) {
            serverVersion += 1;
            serverCredentialsVersion = `ver-${payload.id ?? 'synthetic'}-${serverVersion}`;
          }
          const { credentials: _omitted, ...rowWithoutCredentials } = activeRow;
          return {
            ...rowWithoutCredentials,
            id: payload.id,
            ...(serverCredentialsVersion !== undefined ? { credentialsVersion: serverCredentialsVersion } : {}),
          };
        };
        if (options.onUpdateChannel) {
          return options.onUpdateChannel(payload, executeDefault);
        }
        return executeDefault();
      }),
    useDeleteDisabledChannelAPIKeys: () =>
      mutation(async ({ channelID, keys }) => {
        deleteDisabledCalls.push({ channelID, keys });
        const set = new Set(keys);
        disabledKeys = disabledKeys.filter((item) => !set.has(item.key));
        if (Array.isArray(serverCredentials.apiKeys)) {
          serverCredentials.apiKeys = serverCredentials.apiKeys.filter((key) => !set.has(key));
        }
        if (Array.isArray(serverCredentials.vertexApiKeys)) {
          serverCredentials.vertexApiKeys = serverCredentials.vertexApiKeys.filter((item) => !set.has(item.apiKey));
        }
        if (Array.isArray(serverCredentials.apiKeyNames)) {
          serverCredentials.apiKeyNames = serverCredentials.apiKeyNames.filter((item) => !set.has(item.key));
        }
        if (serverCredentialsVersion !== undefined) {
          serverVersion += 1;
          serverCredentialsVersion = `ver-${channelID ?? 'synthetic'}-${serverVersion}`;
        }
        return { success: true };
      }),
  };
  const modules = {
    react: hooks,
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    'react-i18next': { useTranslation: () => ({ t: (key) => key }) },
    '@/lib/error-parser': {
      isErrorCode: (error, code) => error?.errors?.some((item) => item?.extensions?.code === code) ?? false,
    },
    '../context/channels-context': {
      useChannels: () => ({
        get currentRow() {
          return options.contextRow ?? activeRow;
        },
        setCurrentRow(next) {
          activeRow = typeof next === 'function' ? next(activeRow) : next;
        },
        setOpen() {},
      }),
    },
    '../data/channels': data,
    '../data/vertex-service-account': {
      getVertexServiceAccountIdentity: () => ({ clientEmail: 'synthetic@example.invalid' }),
      maskVertexCredentialRef: () => 'masked',
      toVertexServiceAccountInputs: (accounts) => accounts,
    },
    '../utils/api-key-names': apiKeyNamesExports,
  };
  const exports = {};
  new Function('require', 'exports', outputText)((name) => modules[name] ?? new Proxy({}, { get: (_, key) => key }), exports);
  function render() {
    let tree;
    for (let pass = 0; pass < 3; pass++) {
      cursor = 0;
      refCursor = 0;
      effectCursor = 0;
      stateDirty = false;
      tree = exports.ChannelsAPIKeyManagementDialog({ currentRow: activeRow, open: true, onOpenChange() {} });
      const pending = effects.splice(0);
      pending.forEach((run) => run());
      if (!initialized) {
        initialized = true;
        continue;
      }
      if (!stateDirty) {
        break;
      }
    }
    return tree;
  }
  return {
    render,
    switchChannelRow: (nextRow) => {
      activeRow = structuredClone(nextRow);
      serverCredentials = structuredClone(activeRow.credentials ?? {});
      serverVersion = 0;
      serverCredentialsVersion =
        'credentialsVersion' in activeRow
          ? activeRow.credentialsVersion
          : activeRow.credentials
            ? `ver-${activeRow.id ?? 'synthetic'}-0`
            : undefined;
      activeRow.credentialsVersion = serverCredentialsVersion;
      render();
    },
    getActiveRow: () => structuredClone(activeRow),
    isServerDisabled: (target = ref) => disabledKeys.some((item) => item.key === target),
    setServerDisabledKeys: (keys) => {
      disabledKeys = keys.map((key) => ({ key, errorCode: 0, reason: 'Manually disabled by user', quotaDisabled: false }));
    },
    setServerDisabledRecords: (records) => {
      disabledKeys = records;
    },
    advanceDisabledKeysRefresh: (nextRecords = disabledKeys) => {
      disabledKeys = nextRecords;
      disabledKeysUpdatedAt += 1;
    },
    simulateExternalCredentialRotation: (nextCredentials, nextCredentialsVersion) => {
      serverCredentials = structuredClone(nextCredentials);
      serverCredentialsVersion = nextCredentialsVersion;
    },
    getServerCredentials: () => structuredClone(serverCredentials),
    getServerCredentialsVersion: () => serverCredentialsVersion,
    updateChannelCalls,
    enableSelectedCalls,
    disableSelectedCalls,
    deleteDisabledCalls,
  };
}

function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...nodes(tree.props?.children)];
}

function textContent(tree) {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (Array.isArray(tree)) return tree.map(textContent).join('');
  if (!tree || typeof tree !== 'object') return '';
  return textContent(tree.props?.children);
}

function accountRow(tree) {
  return nodes(tree).find((node) => node.type === 'TableRow' && node.props.children?.[0]?.props.className === 'font-medium');
}

function apiKeyRows(tree) {
  return nodes(tree).filter((node) => node.type === 'TableRow' && node.props.children?.[0]?.type === 'TableCell' && node.props.children?.[0]?.props?.children?.type === 'Checkbox');
}

async function toggle(view, label) {
  const row = accountRow(view.render());
  const button = nodes(row).find((node) => node.props?.['aria-label'] === `channels.dialogs.keyManagement.${label}`);
  assert.ok(button, `${label} action must be visible`);
  const popover = nodes(row).find((node) => node.type === 'Popover' && nodes(node).includes(button));
  popover.props.onOpenChange(true);
  const confirmation = nodes(accountRow(view.render())).find((node) => node.type === 'Popover' && node.props.open);
  await nodes(confirmation).find((node) => node.type === 'Button' && node.props.children === 'common.buttons.confirm').props.onClick();
}

test('a tested disabled JSON credential becomes enabled after successful recovery', async () => {
  const view = manager();
  const vertexTree = view.render();
  assert.equal(textContent(vertexTree).includes('channels.dialogs.keyManagement.nameColumn'), false);
  assert.equal(
    nodes(vertexTree).some((node) => node.props?.['aria-label'] === 'channels.dialogs.keyManagement.editName'),
    false,
    'Vertex channels must hide key rename actions'
  );

  await toggle(view, 'disable');
  const testButton = nodes(accountRow(view.render())).find(
    (node) => node.props?.['aria-label'] === 'channels.dialogs.keyManagement.test'
  );
  await testButton.props.onClick();
  await toggle(view, 'enable');

  assert.equal(view.isServerDisabled(), false);
  const row = accountRow(view.render());
  assert.ok(nodes(row).some((node) => node.props?.['aria-label'] === 'channels.dialogs.keyManagement.disable'));
  assert.equal(nodes(row).some((node) => node.props?.children === 'channels.dialogs.keyManagement.disabled'), false);
});

test('inline key name edit saves immediately via updateChannel and bulk import/delete preserve surviving names', async () => {
  const v0 = 'cred-ver-0';
  const view = manager({
    id: 'ch-multi',
    type: 'openai',
    name: 'multi',
    credentialsVersion: v0,
    credentials: {
      apiKeys: ['sk-key-one-1111', 'sk-key-two-2222'],
      apiKeyNames: [{ key: 'sk-key-one-1111', name: 'primary' }],
    },
  }, { contextRow: { id: 'ch-multi', name: 'multi' } });

  const rows = apiKeyRows(view.render());
  assert.equal(rows.length, 2);
  // Row 1 renders custom name, Row 2 renders fallback key2
  assert.ok(nodes(rows[0]).some((node) => node.props?.children === 'primary'));
  assert.ok(nodes(rows[1]).some((node) => node.props?.children === 'key2'));

  // Inline rename row 2 saves via updateChannel (without credentials in response, keeping local rows intact)
  const editButton = nodes(rows[1]).find((node) => node.props?.['aria-label'] === 'channels.dialogs.keyManagement.editName');
  assert.ok(editButton);
  editButton.props.onClick();

  const inputNode = nodes(apiKeyRows(view.render())[1]).find((node) => node.type === 'Input');
  assert.ok(inputNode);
  inputNode.props.onChange({ target: { value: '  secondary  ' } });
  const saveButton = nodes(apiKeyRows(view.render())[1]).find((node) => node.props?.['aria-label'] === 'common.buttons.save');
  await saveButton.props.onClick();

  const v1 = view.getServerCredentialsVersion();
  assert.notEqual(v1, v0);
  assert.deepEqual(view.updateChannelCalls[0], {
    id: 'ch-multi',
    expectedCredentialsVersion: v0,
    input: {
      credentials: {
        apiKeys: ['sk-key-one-1111', 'sk-key-two-2222'],
        apiKeyNames: [
          { key: 'sk-key-one-1111', name: 'primary' },
          { key: 'sk-key-two-2222', name: 'secondary' },
        ],
      },
    },
  });
  assert.equal(apiKeyRows(view.render()).length, 2);

  // Bulk import uses updateChannel and preserves existing names
  const tree = view.render();
  const textarea = nodes(tree).find((node) => node.type === 'Textarea');
  textarea.props.onChange({ target: { value: 'sk-key-three-3333' } });
  const importButton = nodes(view.render()).find(
    (node) => node.type === 'Button' && textContent(node).includes('channels.dialogs.keyManagement.importButton')
  );
  assert.ok(importButton);
  await importButton.props.onClick();

  const v2 = view.getServerCredentialsVersion();
  assert.notEqual(v2, v1);
  assert.deepEqual(view.updateChannelCalls[1], {
    id: 'ch-multi',
    expectedCredentialsVersion: v1,
    input: {
      credentials: {
        apiKeys: ['sk-key-one-1111', 'sk-key-two-2222', 'sk-key-three-3333'],
        apiKeyNames: [
          { key: 'sk-key-one-1111', name: 'primary' },
          { key: 'sk-key-two-2222', name: 'secondary' },
        ],
      },
    },
  });
  assert.equal(apiKeyRows(view.render()).length, 3);

  // Deleting key2 removes its name via updateChannel while keeping key1's name
  const row2 = apiKeyRows(view.render())[1];
  const deleteButtonRow2 = nodes(row2).find(
    (node) => node.props?.['aria-label'] === 'channels.dialogs.keyManagement.delete'
  );
  const deletePopover = nodes(row2).find(
    (node) => node.type === 'Popover' && nodes(node).includes(deleteButtonRow2)
  );
  assert.ok(deletePopover);
  deletePopover.props.onOpenChange(true);
  const confirmDeletePopover = nodes(apiKeyRows(view.render())[1]).find((node) => node.type === 'Popover' && node.props.open);
  await nodes(confirmDeletePopover)
    .find((node) => node.type === 'Button' && node.props.children === 'common.buttons.confirm')
    .props.onClick();

  assert.deepEqual(view.updateChannelCalls[2], {
    id: 'ch-multi',
    expectedCredentialsVersion: v2,
    input: {
      credentials: {
        apiKeys: ['sk-key-one-1111', 'sk-key-three-3333'],
        apiKeyNames: [{ key: 'sk-key-one-1111', name: 'primary' }],
      },
    },
  });
  assert.equal(apiKeyRows(view.render()).length, 2);
});

test('mixed batch delete validates combined enabled count upfront and submits atomically via updateChannel', async () => {
  // With A (enabled), B (disabled), C (disabled): selecting A and B must block deletion without calling deleteDisabledAPIKeys
  const blockedView = manager({
    id: 'ch-del-blocked',
    type: 'openai',
    name: 'del-blocked',
    credentials: {
      apiKeys: ['sk-a', 'sk-b', 'sk-c'],
    },
  });
  blockedView.setServerDisabledKeys(['sk-b', 'sk-c']);
  const blockedRows = apiKeyRows(blockedView.render());
  nodes(blockedRows[0]).find((node) => node.type === 'Checkbox').props.onCheckedChange(true);
  nodes(blockedRows[1]).find((node) => node.type === 'Checkbox').props.onCheckedChange(true);

  const blockedTree = blockedView.render();
  const deleteSelectedBlocked = nodes(blockedTree).find(
    (node) => node.type === 'Button' && textContent(node).includes('channels.dialogs.keyManagement.deleteSelected')
  );
  assert.ok(deleteSelectedBlocked);
  assert.equal(deleteSelectedBlocked.props.disabled, true);
  assert.equal(blockedView.deleteDisabledCalls.length, 0);
  assert.equal(blockedView.updateChannelCalls.length, 0);

  // With A (enabled), B (disabled), C (disabled), D (enabled): selecting A and B uses a single atomic updateChannel call
  // so deleting B does not mutate state ahead of expectedCredentialsVersion and server-side prunes B's disabled record.
  const v0 = 'cred-ver-mixed-0';
  const validView = manager({
    id: 'ch-del-mixed',
    type: 'openai',
    name: 'del-mixed',
    credentialsVersion: v0,
    credentials: {
      apiKeys: ['sk-a', 'sk-b', 'sk-c', 'sk-d'],
    },
  });
  validView.setServerDisabledKeys(['sk-b', 'sk-c']);
  const validRows = apiKeyRows(validView.render());
  nodes(validRows[0]).find((node) => node.type === 'Checkbox').props.onCheckedChange(true);
  nodes(validRows[1]).find((node) => node.type === 'Checkbox').props.onCheckedChange(true);

  const validTree = validView.render();
  const deleteSelectedBtn = nodes(validTree).find(
    (node) => node.type === 'Button' && textContent(node).includes('channels.dialogs.keyManagement.deleteSelected')
  );
  assert.ok(deleteSelectedBtn);
  assert.equal(deleteSelectedBtn.props.disabled, false);
  const deletePopover = nodes(validTree).find((node) => node.type === 'Popover' && nodes(node).includes(deleteSelectedBtn));
  deletePopover.props.onOpenChange(true);
  const openDeletePopover = nodes(validView.render()).find((node) => node.type === 'Popover' && node.props.open);
  await nodes(openDeletePopover)
    .find((node) => node.type === 'Button' && node.props.children === 'common.buttons.confirm')
    .props.onClick();

  assert.equal(validView.deleteDisabledCalls.length, 0);
  assert.deepEqual(validView.updateChannelCalls, [
    {
      id: 'ch-del-mixed',
      expectedCredentialsVersion: v0,
      input: {
        credentials: {
          apiKeys: ['sk-c', 'sk-d'],
          apiKeyNames: [],
        },
      },
    },
  ]);
  assert.equal(validView.isServerDisabled('sk-b'), false);
  assert.equal(validView.isServerDisabled('sk-c'), true);
  assert.equal(apiKeyRows(validView.render()).length, 2);
});

test('pure disabled-key delete calls deleteDisabledAPIKeys, syncs baseline credentialsVersion, and allows subsequent rename', async () => {
  const v0 = 'cred-ver-dis-0';
  const view = manager({
    id: 'ch-del-disabled-only',
    type: 'openai',
    name: 'del-disabled-only',
    credentialsVersion: v0,
    credentials: {
      apiKeys: ['sk-alive-1111', 'sk-dead-2222'],
    },
  });
  view.setServerDisabledKeys(['sk-dead-2222']);

  const rows0 = apiKeyRows(view.render());
  const deleteBtn = nodes(rows0[1]).find((node) => node.props?.['aria-label'] === 'channels.dialogs.keyManagement.delete');
  const deletePopover = nodes(rows0[1]).find((node) => node.type === 'Popover' && nodes(node).includes(deleteBtn));
  deletePopover.props.onOpenChange(true);
  await nodes(nodes(apiKeyRows(view.render())[1]).find((node) => node.type === 'Popover' && node.props.open))
    .find((node) => node.type === 'Button' && node.props.children === 'common.buttons.confirm')
    .props.onClick();

  const v1 = view.getServerCredentialsVersion();
  assert.notEqual(v1, v0);
  assert.deepEqual(view.deleteDisabledCalls, [{ channelID: 'ch-del-disabled-only', keys: ['sk-dead-2222'] }]);
  assert.equal(apiKeyRows(view.render()).length, 1);

  // Subsequent rename uses synced v1 instead of stale v0
  nodes(apiKeyRows(view.render())[0])
    .find((node) => node.props?.['aria-label'] === 'channels.dialogs.keyManagement.editName')
    .props.onClick();
  nodes(apiKeyRows(view.render())[0])
    .find((node) => node.type === 'Input')
    .props.onChange({ target: { value: 'primary-key' } });
  await nodes(apiKeyRows(view.render())[0])
    .find((node) => node.props?.['aria-label'] === 'common.buttons.save')
    .props.onClick();

  assert.deepEqual(view.updateChannelCalls, [
    {
      id: 'ch-del-disabled-only',
      expectedCredentialsVersion: v1,
      input: {
        credentials: {
          apiKeys: ['sk-alive-1111'],
          apiKeyNames: [{ key: 'sk-alive-1111', name: 'primary-key' }],
        },
      },
    },
  ]);
  assert.equal(apiKeyRows(view.render()).length, 1);
});

test('batch enable and batch disable act immediately and enforce keeping at least one enabled key', async () => {
  const view = manager({
    id: 'ch-batch',
    type: 'openai',
    name: 'batch',
    credentials: {
      apiKeys: ['sk-a-1111', 'sk-b-2222', 'sk-c-3333'],
    },
  });
  view.setServerDisabledKeys(['sk-c-3333']);

  // Select all 3 keys -> cannot batch disable all enabled keys while c is disabled
  const selectAllCheckbox = nodes(view.render()).find((node) => node.type === 'Checkbox' && node.props?.['aria-label'] === 'common.columns.selectAll');
  selectAllCheckbox.props.onCheckedChange(true);

  const treeBlocked = view.render();
  const disableSelectedBtnBlocked = nodes(treeBlocked).find(
    (node) => node.type === 'Button' && textContent(node).includes('channels.dialogs.keyManagement.disableSelected')
  );
  assert.ok(disableSelectedBtnBlocked);
  assert.equal(disableSelectedBtnBlocked.props.disabled, true, 'must block disabling every remaining enabled key');

  // Batch enable c immediately
  const enableSelectedBtn = nodes(treeBlocked).find(
    (node) => node.type === 'Button' && textContent(node).includes('channels.dialogs.keyManagement.enableSelected')
  );
  assert.ok(enableSelectedBtn);
  assert.equal(enableSelectedBtn.props.disabled, false);
  const enablePopover = nodes(treeBlocked).find((node) => node.type === 'Popover' && nodes(node).includes(enableSelectedBtn));
  enablePopover.props.onOpenChange(true);
  const openEnablePopover = nodes(view.render()).find((node) => node.type === 'Popover' && node.props.open);
  await nodes(openEnablePopover)
    .find((node) => node.type === 'Button' && node.props.children === 'common.buttons.confirm')
    .props.onClick();

  assert.deepEqual(view.enableSelectedCalls, [{ channelID: 'ch-batch', keys: ['sk-c-3333'] }]);
  assert.equal(view.isServerDisabled('sk-c-3333'), false);

  // Now select sk-a-1111 and sk-b-2222 (leaving sk-c-3333 enabled) and batch disable them immediately
  const rows = apiKeyRows(view.render());
  nodes(rows[0]).find((node) => node.type === 'Checkbox').props.onCheckedChange(true);
  nodes(rows[1]).find((node) => node.type === 'Checkbox').props.onCheckedChange(true);

  const treeCanDisable = view.render();
  const disableSelectedBtn = nodes(treeCanDisable).find(
    (node) => node.type === 'Button' && textContent(node).includes('channels.dialogs.keyManagement.disableSelected')
  );
  assert.ok(disableSelectedBtn);
  assert.equal(disableSelectedBtn.props.disabled, false);
  const disablePopover = nodes(treeCanDisable).find((node) => node.type === 'Popover' && nodes(node).includes(disableSelectedBtn));
  disablePopover.props.onOpenChange(true);
  const openDisablePopover = nodes(view.render()).find((node) => node.type === 'Popover' && node.props.open);
  await nodes(openDisablePopover)
    .find((node) => node.type === 'Button' && node.props.children === 'common.buttons.confirm')
    .props.onClick();

  assert.deepEqual(view.disableSelectedCalls, [{ channelID: 'ch-batch', keys: ['sk-a-1111', 'sk-b-2222'] }]);
  assert.equal(view.isServerDisabled('sk-a-1111'), true);
  assert.equal(view.isServerDisabled('sk-b-2222'), true);
  assert.equal(view.isServerDisabled('sk-c-3333'), false);
});

test('expired disable record is treated as enabled and allows disabling another key', () => {
  const view = manager({
    id: 'ch-expired',
    type: 'openai',
    name: 'exp',
    credentials: {
      apiKeys: ['sk-active', 'sk-expired'],
    },
  });
  view.setServerDisabledRecords([
    {
      key: 'sk-expired',
      errorCode: 429,
      reason: 'temporary limit',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      quotaDisabled: false,
    },
  ]);

  const rows = apiKeyRows(view.render());
  const disableBtnActive = nodes(rows[0]).find((node) => node.props?.['aria-label'] === 'channels.dialogs.keyManagement.disable');
  assert.ok(disableBtnActive);
  assert.equal(disableBtnActive.props.disabled, false);

  nodes(rows[0]).find((node) => node.type === 'Checkbox').props.onCheckedChange(true);
  const disableSelectedBtn = nodes(view.render()).find(
    (node) => node.type === 'Button' && textContent(node).includes('channels.dialogs.keyManagement.disableSelected')
  );
  assert.ok(disableSelectedBtn);
  assert.equal(disableSelectedBtn.props.disabled, false);
});

test('a key flagged disabled in testResults is treated as disabled before query refetch', async () => {
  const view = manager(
    {
      id: 'ch-test-auto-disable',
      type: 'openai',
      name: 'test-auto-disable',
      credentials: {
        apiKeys: ['sk-key-one-1111', 'sk-key-two-2222'],
      },
    },
    {
      onTestKey: async ({ key }) => ({
        keyPrefix: `****${key.slice(-4)}`,
        success: false,
        latency: 0.2,
        error: 'unauthorized',
        disabled: key === 'sk-key-one-1111',
      }),
    }
  );

  const initialRows = apiKeyRows(view.render());
  const testBtn = nodes(initialRows[0]).find((node) => node.props?.['aria-label'] === 'channels.dialogs.keyManagement.test');
  await testBtn.props.onClick();

  const updatedRows = apiKeyRows(view.render());
  assert.ok(nodes(updatedRows[0]).some((node) => node.props?.children === 'channels.dialogs.keyManagement.disabled'));
  assert.ok(nodes(updatedRows[0]).some((node) => node.props?.['aria-label'] === 'channels.dialogs.keyManagement.enable'));
  const disableSecondBtn = nodes(updatedRows[1]).find(
    (node) => node.props?.['aria-label'] === 'channels.dialogs.keyManagement.disable'
  );
  assert.ok(disableSecondBtn);
  assert.equal(disableSecondBtn.props.disabled, true);

  // Once the query refetch completes and reports no disabled records, server state wins.
  view.advanceDisabledKeysRefresh([]);
  const refreshedRows = apiKeyRows(view.render());
  assert.equal(
    nodes(refreshedRows[0]).some((node) => node.props?.children === 'channels.dialogs.keyManagement.disabled'),
    false
  );
  assert.ok(nodes(refreshedRows[0]).some((node) => node.props?.['aria-label'] === 'channels.dialogs.keyManagement.disable'));
});

test('stale rename rejects overwrite of concurrently rotated key, preserves draft, and succeeds after resubmit', async () => {
  const initialVersion = 'cred-ver-initial';
  const rotatedVersion = 'cred-ver-rotated';
  const view = manager({
    id: 'ch-conflict',
    type: 'openai',
    name: 'conflict-ch',
    credentialsVersion: initialVersion,
    credentials: {
      apiKeys: ['sk-key-one-1111', 'sk-key-two-2222'],
    },
  });

  // Admin starts editing row 1 while server concurrently rotates sk-key-two-2222 -> sk-key-three-3333.
  const rows0 = apiKeyRows(view.render());
  nodes(rows0[0]).find((node) => node.props?.['aria-label'] === 'channels.dialogs.keyManagement.editName').props.onClick();
  nodes(apiKeyRows(view.render())[0]).find((node) => node.type === 'Input').props.onChange({
    target: { value: '  prod-primary  ' },
  });

  view.simulateExternalCredentialRotation({ apiKeys: ['sk-key-one-1111', 'sk-key-three-3333'] }, rotatedVersion);

  // Submitting fails with CHANNEL_UPDATED_CONCURRENTLY -> rotated key survives, draft stays open with refreshed rows.
  await nodes(apiKeyRows(view.render())[0]).find((node) => node.props?.['aria-label'] === 'common.buttons.save').props.onClick();

  assert.equal(view.updateChannelCalls[0].expectedCredentialsVersion, initialVersion);
  assert.deepEqual(view.getServerCredentials().apiKeys, ['sk-key-one-1111', 'sk-key-three-3333']);

  const afterConflictTree = view.render();
  assert.ok(textContent(afterConflictTree).includes('channels.dialogs.keyManagement.concurrentUpdateConflict'));
  const conflictRows = apiKeyRows(afterConflictTree);
  assert.equal(conflictRows.length, 2);
  const retainedInput = nodes(conflictRows[0]).find((node) => node.type === 'Input');
  assert.ok(retainedInput);
  assert.equal(retainedInput.props.value, '  prod-primary  ');

  // Re-submitting commits against rotatedVersion and keeps sk-key-three-3333.
  await nodes(conflictRows[0]).find((node) => node.props?.['aria-label'] === 'common.buttons.save').props.onClick();

  assert.equal(view.updateChannelCalls[1].expectedCredentialsVersion, rotatedVersion);
  assert.deepEqual(view.updateChannelCalls[1].input.credentials, {
    apiKeys: ['sk-key-one-1111', 'sk-key-three-3333'],
    apiKeyNames: [{ key: 'sk-key-one-1111', name: 'prod-primary' }],
  });
});

test('repeated blur and save share a single rename while the mutation is pending', async () => {
  let attempts = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const view = manager({
    id: 'ch-blur',
    type: 'openai',
    name: 'blur',
    credentials: { apiKeys: ['sk-edit-1111'] },
  }, {
    onUpdateChannel: async (_input, save) => {
      attempts++;
      await pending;
      return save();
    },
  });
  const row = () => nodes(apiKeyRows(view.render())[0]);
  row().find((n) => n.props?.['aria-label'] === 'channels.dialogs.keyManagement.editName').props.onClick();
  row().find((n) => n.type === 'Input').props.onChange({ target: { value: 'renamed' } });
  const editing = row();
  const input = editing.find((n) => n.type === 'Input');
  const button = editing.find((n) => n.props?.['aria-label'] === 'common.buttons.save');
  input.props.onBlur();
  input.props.onBlur();
  const clicked = button.props.onClick();
  release();
  await clicked;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 1);
  assert.equal(view.getServerCredentials().apiKeyNames[0].name, 'renamed');
});

test('consecutive renames in same dialog chain credentialsVersion from previous save', async () => {
  const v0 = 'cred-ver-seq-0';
  const view = manager({
    id: 'ch-consecutive',
    type: 'openai',
    name: 'consecutive-ch',
    credentialsVersion: v0,
    credentials: {
      apiKeys: ['sk-first-1111', 'sk-second-2222'],
    },
  });

  const rows0 = apiKeyRows(view.render());
  nodes(rows0[0]).find((node) => node.props?.['aria-label'] === 'channels.dialogs.keyManagement.editName').props.onClick();
  nodes(apiKeyRows(view.render())[0]).find((node) => node.type === 'Input').props.onChange({
    target: { value: 'first-label' },
  });
  await nodes(apiKeyRows(view.render())[0]).find((node) => node.props?.['aria-label'] === 'common.buttons.save').props.onClick();

  const v1 = view.getServerCredentialsVersion();
  assert.notEqual(v1, v0);
  assert.equal(view.updateChannelCalls[0].expectedCredentialsVersion, v0);

  const rows1 = apiKeyRows(view.render());
  nodes(rows1[1]).find((node) => node.props?.['aria-label'] === 'channels.dialogs.keyManagement.editName').props.onClick();
  nodes(apiKeyRows(view.render())[1]).find((node) => node.type === 'Input').props.onChange({
    target: { value: 'second-label' },
  });
  await nodes(apiKeyRows(view.render())[1]).find((node) => node.props?.['aria-label'] === 'common.buttons.save').props.onClick();

  assert.equal(view.updateChannelCalls[1].expectedCredentialsVersion, v1);
  assert.deepEqual(view.getServerCredentials().apiKeyNames, [
    { key: 'sk-first-1111', name: 'first-label' },
    { key: 'sk-second-2222', name: 'second-label' },
  ]);
});

test('missing credentials on currentRow disables and blocks bulk import to prevent wiping keys', async () => {
  const view = manager({
    id: 'ch-partial-missing-creds',
    type: 'openai',
    name: 'partial-no-creds',
    credentialsVersion: undefined,
    credentials: undefined,
  });

  const tree0 = view.render();
  const textarea = nodes(tree0).find((node) => node.type === 'Textarea');
  assert.equal(textarea.props.disabled, true);
  textarea.props.onChange({ target: { value: 'sk-new-only-key' } });

  const importButton = nodes(view.render()).find(
    (node) => node.type === 'Button' && textContent(node).includes('channels.dialogs.keyManagement.importButton')
  );
  assert.ok(importButton);
  assert.equal(importButton.props.disabled, true);
  await importButton.props.onClick();

  assert.equal(view.updateChannelCalls.length, 0);
});

test('late async mutation or baseline sync from previous channel never overwrites newly opened channel', async () => {
  let resolveSlowUpdate;
  let resolveSlowFetch;
  const view = manager(
    {
      id: 'ch-A',
      type: 'openai',
      name: 'channel-A',
      updatedAt: '2026-11-28T00:00:00.000Z',
      credentials: {
        apiKeys: ['sk-a1-1111', 'sk-a2-2222'],
      },
    },
    {
      onUpdateChannel: (_payload, executeDefault) =>
        new Promise((resolve) => {
          resolveSlowUpdate = () => resolve(executeDefault());
        }),
      onFetchLatestChannel: (_id, defaultFetch) =>
        new Promise((resolve) => {
          resolveSlowFetch = () => resolve(defaultFetch());
        }),
    }
  );

  // Start saving rename on ch-A while response stays pending.
  nodes(apiKeyRows(view.render())[0])
    .find((node) => node.props?.['aria-label'] === 'channels.dialogs.keyManagement.editName')
    .props.onClick();
  nodes(apiKeyRows(view.render())[0])
    .find((node) => node.type === 'Input')
    .props.onChange({ target: { value: 'stale-A-name' } });
  const pendingRename = nodes(apiKeyRows(view.render())[0])
    .find((node) => node.props?.['aria-label'] === 'common.buttons.save')
    .props.onClick();

  // Switch open dialog to ch-B before ch-A's mutation finishes.
  view.switchChannelRow({
    id: 'ch-B',
    type: 'openai',
    name: 'channel-B',
    updatedAt: '2026-11-28T01:00:00.000Z',
    credentials: {
      apiKeys: ['sk-b1-1111', 'sk-b2-2222'],
      apiKeyNames: [{ key: 'sk-b1-1111', name: 'b-primary' }],
    },
  });

  resolveSlowUpdate();
  await pendingRename;

  assert.equal(view.getActiveRow().id, 'ch-B');
  assert.deepEqual(view.getActiveRow().credentials.apiKeys, ['sk-b1-1111', 'sk-b2-2222']);
  assert.deepEqual(view.getActiveRow().credentials.apiKeyNames, [{ key: 'sk-b1-1111', name: 'b-primary' }]);
  const bRows = apiKeyRows(view.render());
  assert.equal(bRows.length, 2);
  assert.ok(nodes(bRows[0]).some((node) => node.props?.children === 'b-primary'));

  // Even on the same channel, a slower baseline sync started before a newer commit cannot overwrite it.
  let fetchResolved = false;
  let allowImmediateUpdate = false;
  let resolveBaselineFetch;
  const sameView = manager(
    {
      id: 'ch-same',
      type: 'openai',
      name: 'same-channel',
      updatedAt: '2026-11-28T02:00:00.000Z',
      credentials: {
        apiKeys: ['sk-s1-1111', 'sk-s2-2222'],
      },
    },
    {
      onFetchLatestChannel: (id) =>
        new Promise((resolve) => {
          resolveBaselineFetch = () => {
            fetchResolved = true;
            resolve({
              id,
              type: 'openai',
              name: 'same-channel',
              updatedAt: '2026-11-28T02:01:00.000Z',
              credentials: {
                apiKeys: ['sk-s1-1111', 'sk-s2-2222'],
                apiKeyNames: [],
              },
            });
          };
        }),
      onUpdateChannel: (_payload, executeDefault) => {
        if (!allowImmediateUpdate) {
          allowImmediateUpdate = true;
        }
        return executeDefault();
      },
    }
  );

  // Trigger disable (starts background syncBaselineAfterStateMutation without awaiting).
  const firstKeyRow = apiKeyRows(sameView.render())[0];
  const disableBtn = nodes(firstKeyRow).find(
    (node) => node.props?.['aria-label'] === 'channels.dialogs.keyManagement.disable'
  );
  const disablePopover = nodes(firstKeyRow).find(
    (node) => node.type === 'Popover' && nodes(node).includes(disableBtn)
  );
  disablePopover.props.onOpenChange(true);
  await nodes(nodes(apiKeyRows(sameView.render())[0]).find((node) => node.type === 'Popover' && node.props.open))
    .find((node) => node.type === 'Button' && node.props.children === 'common.buttons.confirm')
    .props.onClick();

  // Complete a newer rename before the background fetch resolves.
  nodes(apiKeyRows(sameView.render())[0])
    .find((node) => node.props?.['aria-label'] === 'channels.dialogs.keyManagement.editName')
    .props.onClick();
  nodes(apiKeyRows(sameView.render())[0])
    .find((node) => node.type === 'Input')
    .props.onChange({ target: { value: 'newer-label' } });
  await nodes(apiKeyRows(sameView.render())[0])
    .find((node) => node.props?.['aria-label'] === 'common.buttons.save')
    .props.onClick();

  resolveBaselineFetch();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fetchResolved, true);
  assert.ok(nodes(apiKeyRows(sameView.render())[0]).some((node) => node.props?.children === 'newer-label'));
  assert.equal(sameView.getActiveRow().credentials.apiKeyNames[0].name, 'newer-label');
  void resolveSlowFetch;
});
