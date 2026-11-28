// 职责: 提供渠道 API Key 名称规范化、校验、搜索过滤与侧边栏草稿状态计算的纯函数工具。
// 关联文件:
//   frontend/src/features/channels/data/schema.ts
//   frontend/src/features/channels/components/channels-action-dialog.tsx
//   frontend/src/features/channels/components/channels-api-key-management-dialog.tsx
//   frontend/src/features/channels/components/channels-disabled-api-keys-dialog.tsx
// 遵循的 Rules:
//   .agents/rules/frontend-general.md
// 注意事项:
//   长度按 Unicode 字符数（code points）校验，与后端 Go utf8.RuneCountInString 保持一致。
//   搜索过滤后仍保持每把密钥在完整去重列表中的 1-based 位置（key{N}）。

import type { APIKeyName, ChannelAPIKeyStateChangesInput, ChannelCredentials, DisabledAPIKey } from '../data/schema';

export const MAX_API_KEY_NAME_LENGTH = 64;

export function countUnicodeChars(value: string): number {
  return Array.from(value).length;
}

export function validateAPIKeyName(raw: string): { valid: boolean; normalized: string; tooLong: boolean } {
  const normalized = raw.trim();
  const tooLong = countUnicodeChars(normalized) > MAX_API_KEY_NAME_LENGTH;
  return {
    valid: !tooLong,
    normalized,
    tooLong,
  };
}

export function maskAPIKey(key: string): string {
  if (key.length <= 8) {
    return `****${key.slice(-4)}`;
  }
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

export function getDeduplicatedValidKeys(rawKeys?: (string | null | undefined)[] | null): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of rawKeys ?? []) {
    const trimmed = (raw ?? '').trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

export function getAPIKeyNameMap(entries?: APIKeyName[] | null): Map<string, string> {
  const result = new Map<string, string>();
  for (const entry of entries ?? []) {
    if (!entry?.key) {
      continue;
    }
    const name = entry.name.trim();
    if (!name) {
      result.delete(entry.key);
    } else {
      result.set(entry.key, name);
    }
  }
  return result;
}

export function setAPIKeyName(entries: APIKeyName[] | undefined | null, key: string, rawName: string): APIKeyName[] {
  const trimmedKey = key.trim();
  const trimmedName = rawName.trim();
  const filtered = (entries ?? []).filter((entry) => entry.key !== trimmedKey);
  if (!trimmedKey || !trimmedName) {
    return filtered;
  }
  return [...filtered, { key: trimmedKey, name: trimmedName }];
}

export function normalizeAPIKeyNamesForKeys(
  entries: APIKeyName[] | undefined | null,
  validKeys: string[]
): APIKeyName[] {
  const validSet = new Set(validKeys);
  const nameMap = getAPIKeyNameMap(entries);
  const normalized: APIKeyName[] = [];
  for (const key of validKeys) {
    if (!validSet.has(key)) {
      continue;
    }
    const name = nameMap.get(key);
    if (name) {
      normalized.push({ key, name });
    }
  }
  return normalized;
}

export function countStaleAPIKeyNames(entries: APIKeyName[] | undefined | null, validKeys: string[]): number {
  const validSet = new Set(validKeys);
  const nameMap = getAPIKeyNameMap(entries);
  let count = 0;
  for (const key of nameMap.keys()) {
    if (!validSet.has(key)) {
      count += 1;
    }
  }
  return count;
}

export function findDuplicateAPIKeyNames(entries: APIKeyName[] | undefined | null, validKeys: string[]): Set<string> {
  const nameMap = getAPIKeyNameMap(entries);
  const counts = new Map<string, number>();
  for (const key of validKeys) {
    const name = nameMap.get(key);
    if (!name) {
      continue;
    }
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const duplicates = new Set<string>();
  for (const [name, count] of counts.entries()) {
    if (count > 1) {
      duplicates.add(name);
    }
  }
  return duplicates;
}

export type AddSidebarKeyError = 'emptyKey' | 'multilineKey' | 'duplicateKey' | 'nameTooLong';

export function containsMultilineKey(raw: string): boolean {
  return /[\r\n]/.test(raw);
}

export function validateNewSidebarKey(
  rawKey: string,
  rawName: string,
  existingKeys: string[]
): { error?: AddSidebarKeyError; trimmedKey: string; trimmedName: string } {
  const trimmedKey = rawKey.trim();
  const nameCheck = validateAPIKeyName(rawName);
  if (!trimmedKey) {
    return { error: 'emptyKey', trimmedKey, trimmedName: nameCheck.normalized };
  }
  if (containsMultilineKey(trimmedKey)) {
    return { error: 'multilineKey', trimmedKey, trimmedName: nameCheck.normalized };
  }
  if (new Set(existingKeys).has(trimmedKey)) {
    return { error: 'duplicateKey', trimmedKey, trimmedName: nameCheck.normalized };
  }
  if (!nameCheck.valid) {
    return { error: 'nameTooLong', trimmedKey, trimmedName: nameCheck.normalized };
  }
  return { trimmedKey, trimmedName: nameCheck.normalized };
}

export function getDisabledKeyPosition(key: string, credentials?: ChannelCredentials | null): number | null {
  if (!key || !credentials) {
    return null;
  }
  const refs: string[] = [
    ...(credentials.apiKeys ?? []),
    ...(credentials.vertexApiKeys ?? []).map((binding) => binding.apiKey),
    ...(credentials.vertexServiceAccounts ?? []).map((account) => account.credentialRef ?? '').filter(Boolean),
  ];
  const index = refs.indexOf(key);
  return index >= 0 ? index + 1 : null;
}

export interface SidebarKeyRowState {
  key: string;
  position: number;
  fallbackName: string;
  customName: string;
  hasDuplicateName: boolean;
  isSaved: boolean;
  isServerDisabled: boolean;
  disabledRecord?: DisabledAPIKey;
  isPendingDelete: boolean;
  isPendingEnable: boolean;
  isPendingDisable: boolean;
  isEffectiveEnabled: boolean;
  isEffectiveDisabled: boolean;
  canEnable: boolean;
  canDisable: boolean;
  disableBlockedByLastEnabled: boolean;
  canDelete: boolean;
  deleteBlockedByLastKey: boolean;
  deleteBlockedByLastEnabled: boolean;
}

export interface SidebarDraftSummary {
  validKeys: string[];
  rows: SidebarKeyRowState[];
  filteredRows: SidebarKeyRowState[];
  effectiveKeys: string[];
  effectiveEnabledCount: number;
  selectedInValidKeys: string[];
  allFilteredSelected: boolean;
  someFilteredSelected: boolean;
  batchEnableKeys: string[];
  batchDisableKeys: string[];
  batchDeleteKeys: string[];
  canBatchDisable: boolean;
  canBatchDelete: boolean;
  batchDeleteBlockedByLastKey: boolean;
  batchDeleteBlockedByLastEnabled: boolean;
}

export function computeSidebarDraftSummary(params: {
  rawApiKeys?: (string | null | undefined)[] | null;
  apiKeyNames?: APIKeyName[] | null;
  search: string;
  savedKeySet: ReadonlySet<string>;
  serverDisabledMap: ReadonlyMap<string, DisabledAPIKey>;
  pendingDeleteKeys: ReadonlySet<string>;
  pendingEnableKeys: ReadonlySet<string>;
  pendingDisableKeys: ReadonlySet<string>;
  selectedKeys: ReadonlySet<string>;
}): SidebarDraftSummary {
  const validKeys = getDeduplicatedValidKeys(params.rawApiKeys);
  const nameMap = getAPIKeyNameMap(params.apiKeyNames);
  const duplicateNames = findDuplicateAPIKeyNames(params.apiKeyNames, validKeys);

  const preliminary = validKeys.map((key, index) => {
    const position = index + 1;
    const customName = nameMap.get(key) ?? '';
    const isSaved = params.savedKeySet.has(key);
    const disabledRecord = isSaved ? params.serverDisabledMap.get(key) : undefined;
    const isServerDisabled = Boolean(disabledRecord);
    const isPendingDelete = params.pendingDeleteKeys.has(key);
    const isPendingEnable = isSaved && !isPendingDelete && isServerDisabled && params.pendingEnableKeys.has(key);
    const isPendingDisable = isSaved && !isPendingDelete && !isServerDisabled && params.pendingDisableKeys.has(key);
    const isEffectiveEnabled = !isPendingDelete && (!isSaved || (!isServerDisabled && !isPendingDisable) || isPendingEnable);
    const isEffectiveDisabled = isSaved && !isPendingDelete && ((isServerDisabled && !isPendingEnable) || isPendingDisable);

    return {
      key,
      position,
      fallbackName: `key${position}`,
      customName,
      hasDuplicateName: Boolean(customName && duplicateNames.has(customName)),
      isSaved,
      isServerDisabled,
      disabledRecord,
      isPendingDelete,
      isPendingEnable,
      isPendingDisable,
      isEffectiveEnabled,
      isEffectiveDisabled,
    };
  });

  const effectiveKeys = preliminary.filter((row) => !row.isPendingDelete).map((row) => row.key);
  const effectiveEnabledCount = preliminary.filter((row) => row.isEffectiveEnabled).length;

  const rows: SidebarKeyRowState[] = preliminary.map((row) => {
    const canEnable = row.isSaved && !row.isPendingDelete && row.isEffectiveDisabled;
    const canDisable = row.isSaved && !row.isPendingDelete && row.isEffectiveEnabled && effectiveEnabledCount > 1;
    const disableBlockedByLastEnabled = row.isSaved && !row.isPendingDelete && row.isEffectiveEnabled && effectiveEnabledCount <= 1;
    const deleteBlockedByLastKey = !row.isPendingDelete && effectiveKeys.length <= 1;
    const deleteBlockedByLastEnabled =
      !row.isPendingDelete && effectiveKeys.length > 1 && row.isEffectiveEnabled && effectiveEnabledCount <= 1;
    const canDelete = !row.isPendingDelete && !deleteBlockedByLastKey && !deleteBlockedByLastEnabled;

    return {
      ...row,
      canEnable,
      canDisable,
      disableBlockedByLastEnabled,
      canDelete,
      deleteBlockedByLastKey,
      deleteBlockedByLastEnabled,
    };
  });

  const searchLower = params.search.trim().toLowerCase();
  const filteredRows = !searchLower
    ? rows
    : rows.filter(
        (row) =>
          row.customName.toLowerCase().includes(searchLower) ||
          row.fallbackName.toLowerCase().includes(searchLower) ||
          row.key.toLowerCase().includes(searchLower) ||
          row.key.slice(-4).toLowerCase().includes(searchLower)
      );

  const selectedInValidKeys = rows.filter((row) => params.selectedKeys.has(row.key)).map((row) => row.key);
  const selectedFilteredCount = filteredRows.filter((row) => params.selectedKeys.has(row.key)).length;
  const allFilteredSelected = filteredRows.length > 0 && selectedFilteredCount === filteredRows.length;
  const someFilteredSelected = selectedFilteredCount > 0 && selectedFilteredCount < filteredRows.length;

  const selectedRows = rows.filter((row) => params.selectedKeys.has(row.key));
  const batchEnableKeys = selectedRows.filter((row) => row.canEnable).map((row) => row.key);
  const batchDisableKeys = selectedRows
    .filter((row) => row.isSaved && !row.isPendingDelete && row.isEffectiveEnabled)
    .map((row) => row.key);
  const batchDeleteRows = selectedRows.filter((row) => !row.isPendingDelete);
  const batchDeleteKeys = batchDeleteRows.map((row) => row.key);

  const canBatchDisable = batchDisableKeys.length > 0 && effectiveEnabledCount - batchDisableKeys.length >= 1;
  const batchDeleteBlockedByLastKey = batchDeleteKeys.length > 0 && effectiveKeys.length - batchDeleteKeys.length < 1;
  const deletedEnabledCount = batchDeleteRows.filter((row) => row.isEffectiveEnabled).length;
  const batchDeleteBlockedByLastEnabled =
    batchDeleteKeys.length > 0 &&
    !batchDeleteBlockedByLastKey &&
    deletedEnabledCount > 0 &&
    effectiveEnabledCount - deletedEnabledCount < 1;
  const canBatchDelete = batchDeleteKeys.length > 0 && !batchDeleteBlockedByLastKey && !batchDeleteBlockedByLastEnabled;

  return {
    validKeys,
    rows,
    filteredRows,
    effectiveKeys,
    effectiveEnabledCount,
    selectedInValidKeys,
    allFilteredSelected,
    someFilteredSelected,
    batchEnableKeys,
    batchDisableKeys,
    batchDeleteKeys,
    canBatchDisable,
    canBatchDelete,
    batchDeleteBlockedByLastKey,
    batchDeleteBlockedByLastEnabled,
  };
}

export function buildAPIKeyStateChanges(params: {
  effectiveKeys: string[];
  savedKeySet: ReadonlySet<string>;
  serverDisabledKeySet: ReadonlySet<string>;
  pendingEnableKeys: ReadonlySet<string>;
  pendingDisableKeys: ReadonlySet<string>;
}): ChannelAPIKeyStateChangesInput | undefined {
  const effectiveSet = new Set(params.effectiveKeys);
  const enableKeys: string[] = [];
  const disableKeys: string[] = [];

  for (const key of params.effectiveKeys) {
    if (!params.savedKeySet.has(key) || !effectiveSet.has(key)) {
      continue;
    }
    const isServerDisabled = params.serverDisabledKeySet.has(key);
    if (isServerDisabled && params.pendingEnableKeys.has(key)) {
      enableKeys.push(key);
    } else if (!isServerDisabled && params.pendingDisableKeys.has(key)) {
      disableKeys.push(key);
    }
  }

  if (enableKeys.length === 0 && disableKeys.length === 0) {
    return undefined;
  }

  return {
    ...(enableKeys.length > 0 ? { enableKeys } : {}),
    ...(disableKeys.length > 0 ? { disableKeys } : {}),
  };
}

export function isDisabledAPIKeyExpired(record: Pick<DisabledAPIKey, 'expiresAt'>, nowMs = Date.now()): boolean {
  if (!record?.expiresAt) {
    return false;
  }
  const expiresAtMs = Date.parse(record.expiresAt);
  if (Number.isNaN(expiresAtMs)) {
    return false;
  }
  return nowMs > expiresAtMs;
}

export function filterActiveDisabledAPIKeys(records?: DisabledAPIKey[] | null, nowMs = Date.now()): DisabledAPIKey[] {
  return (records ?? []).filter((record) => !isDisabledAPIKeyExpired(record, nowMs));
}

export const EMPTY_DISABLED_API_KEYS: DisabledAPIKey[] = [];

export function isOAuthChannelCredentials(credentials?: ChannelCredentials | null): boolean {
  if (!credentials) {
    return false;
  }
  if (credentials.isOAuth) {
    return true;
  }
  if (credentials.oauth?.accessToken && credentials.oauth.accessToken.trim() !== '') {
    return true;
  }
  const apiKey = (credentials.apiKey ?? '').trim();
  return apiKey.startsWith('{') && apiKey.includes('access_token');
}

export function channelSupportsAPIKeyNames(channelType?: string | null, credentials?: ChannelCredentials | null): boolean {
  return channelType !== 'antigravity' && channelType !== 'gemini_vertex' && !isOAuthChannelCredentials(credentials);
}
