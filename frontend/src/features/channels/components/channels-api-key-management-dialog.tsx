'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  IconAlertTriangle,
  IconBan,
  IconCheck,
  IconCircleCheck,
  IconCopy,
  IconKey,
  IconLoader2,
  IconPencil,
  IconPlayerPlay,
  IconTrash,
  IconUpload,
  IconX,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { copyTextToClipboard } from '@/lib/clipboard';
import { isErrorCode } from '@/lib/error-parser';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useChannels } from '../context/channels-context';
import {
  fetchLatestChannel,
  useChannelDisabledAPIKeys,
  useDeleteDisabledChannelAPIKeys,
  useDisableChannelAPIKey,
  useDisableSelectedChannelAPIKeys,
  useEnableChannelAPIKey,
  useEnableSelectedChannelAPIKeys,
  useTestChannelAPIKey,
  useUpdateChannel,
} from '../data/channels';
import { APIKeyName, Channel, ChannelCredentials, TestAPIKeyResult } from '../data/schema';
import { getVertexServiceAccountIdentity, maskVertexCredentialRef, toVertexServiceAccountInputs } from '../data/vertex-service-account';
import {
  MAX_API_KEY_NAME_LENGTH,
  EMPTY_DISABLED_API_KEYS,
  channelSupportsAPIKeyNames,
  filterActiveDisabledAPIKeys,
  findDuplicateAPIKeyNames,
  getAPIKeyNameMap,
  normalizeAPIKeyNamesForKeys,
  setAPIKeyName,
  validateAPIKeyName,
} from '../utils/api-key-names';

interface ChannelsAPIKeyManagementDialogProps {
  currentRow: Channel;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function maskAPIKey(key: string) {
  if (key.length <= 8) {
    return '****';
  }
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

/**
 * 统一密钥管理弹窗：
 * - 始终可从行操作菜单进入（无论 1 个还是多个 key）
 * - 批量导入（多行文本，一行一个）
 * - 单个/批量：测试、复制、禁用/启用、删除
 * - 密钥状态（正常 / 已禁用 / 测试中 / 测试结果）实时动态更新
 */
export function ChannelsAPIKeyManagementDialog({ currentRow, open, onOpenChange }: ChannelsAPIKeyManagementDialogProps) {
  const { t } = useTranslation();
  const { setCurrentRow, setOpen } = useChannels();
  const [bulkImportText, setBulkImportText] = useState('');
  const [baselineCredentialsVersion, setBaselineCredentialsVersion] = useState<string | undefined>(undefined);
  const [conflictNotice, setConflictNotice] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestAPIKeyResult>>({});
  const [pendingTestDisabled, setPendingTestDisabled] = useState<Record<string, number>>({});
  const [confirmDisableKey, setConfirmDisableKey] = useState<string | null>(null);
  const [confirmKeepDisabledKey, setConfirmKeepDisabledKey] = useState<string | null>(null);
  const [confirmEnableKey, setConfirmEnableKey] = useState<string | null>(null);
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);
  const [confirmDeleteSelected, setConfirmDeleteSelected] = useState(false);
  const [confirmEnableSelected, setConfirmEnableSelected] = useState(false);
  const [confirmDisableSelected, setConfirmDisableSelected] = useState(false);
  // 本弹窗独立的 key 列表与名称列表：基于 currentRow 快照初始化，导入/删除/改名后本地更新，
  // 避免依赖不会随 query 刷新而更新的 currentRow 快照。
  const [localKeys, setLocalKeys] = useState<string[]>([]);
  // Vertex 密钥是项目绑定的三元组：列表里展示 apiKey，但每次提交都必须把绑定原样带回，
  // 否则后端整体替换 credentials 时会丢掉 projectID/region。
  const [vertexBindings, setVertexBindings] = useState<NonNullable<ChannelCredentials['vertexApiKeys']>>([]);
  const [localNames, setLocalNames] = useState<APIKeyName[]>([]);
  const [editingNameKey, setEditingNameKey] = useState<string | null>(null);
  const [editingNameValue, setEditingNameValue] = useState('');
  const [editingNameError, setEditingNameError] = useState<string | null>(null);
  const skipNameBlurRef = useRef(false);
  // Service account rows keep their server-issued credentialRef: it is the identity the
  // disable/enable/test mutations and the disabled-key list use, and it never leaks the
  // JSON body. Removal rewrites the list without the removed row.
  const [serviceAccounts, setServiceAccounts] = useState<NonNullable<ChannelCredentials['vertexServiceAccounts']>>([]);
  const [confirmDeleteServiceAccount, setConfirmDeleteServiceAccount] = useState<string | null>(null);
  const abortRef = useRef(false);
  const activeSessionRef = useRef(0);
  const activeChannelIdRef = useRef<string | undefined>(open ? currentRow?.id : undefined);
  const snapshotVersionRef = useRef(0);
  activeChannelIdRef.current = open ? currentRow?.id : undefined;

  const isCurrentSession = (sessionId: number, channelId: string) =>
    activeSessionRef.current === sessionId && activeChannelIdRef.current === channelId;

  const testSingleKey = useTestChannelAPIKey();
  const disableAPIKey = useDisableChannelAPIKey();
  const enableAPIKey = useEnableChannelAPIKey();
  const enableSelectedAPIKeys = useEnableSelectedChannelAPIKeys();
  const disableSelectedAPIKeys = useDisableSelectedChannelAPIKeys();
  const updateChannel = useUpdateChannel();
  const deleteDisabledAPIKeys = useDeleteDisabledChannelAPIKeys();

  const validKeys = useMemo(() => localKeys.filter((key) => key.trim().length > 0), [localKeys]);
  const nameMap = useMemo(() => getAPIKeyNameMap(localNames), [localNames]);
  const duplicateNames = useMemo(() => findDuplicateAPIKeyNames(localNames, validKeys), [localNames, validKeys]);
  // 服务端实时禁用的 key 集合（所有 disable/enable mutation 都会 invalidate 此 query）
  const {
    data: disabledKeys = EMPTY_DISABLED_API_KEYS,
    isLoading: disabledLoading,
    dataUpdatedAt: disabledKeysUpdatedAt = 0,
    refetch: refetchDisabledKeys,
  } = useChannelDisabledAPIKeys(currentRow?.id || '', {
    enabled: open && !!currentRow?.id,
  });

  const activeDisabledKeys = useMemo(
    () => filterActiveDisabledAPIKeys(disabledKeys),
    [disabledKeys]
  );
  const disabledKeySet = useMemo(() => new Set(activeDisabledKeys.map((item) => item.key)), [activeDisabledKeys]);
  const effectivelyDisabledSet = useMemo(() => {
    const set = new Set(disabledKeySet);
    for (const [key, recordedAt] of Object.entries(pendingTestDisabled)) {
      if (recordedAt === disabledKeysUpdatedAt) {
        set.add(key);
      }
    }
    return set;
  }, [disabledKeySet, pendingTestDisabled, disabledKeysUpdatedAt]);

  // 当前可用的 key 数量（未被禁用的），与编辑弹窗的 mustKeepOneEnabled 保护一致
  const enabledKeysCount = useMemo(
    () => validKeys.filter((key) => !effectivelyDisabledSet.has(key)).length,
    [validKeys, effectivelyDisabledSet]
  );
  const selectedEnabledKeys = useMemo(
    () => validKeys.filter((key) => selectedKeys.has(key) && !effectivelyDisabledSet.has(key)),
    [validKeys, selectedKeys, effectivelyDisabledSet]
  );
  const selectedDisabledKeys = useMemo(
    () => validKeys.filter((key) => selectedKeys.has(key) && effectivelyDisabledSet.has(key)),
    [validKeys, selectedKeys, effectivelyDisabledSet]
  );
  const isVertexChannel = currentRow?.type === 'gemini_vertex';
  const hasLoadedCredentials = Boolean(currentRow.credentials && baselineCredentialsVersion);
  const canEditKeyNames = channelSupportsAPIKeyNames(currentRow?.type, currentRow?.credentials);
  const enabledServiceAccountCount = serviceAccounts.filter(
    (account) => !!account.credentialRef && !effectivelyDisabledSet.has(account.credentialRef)
  ).length;
  // Disabling is blocked when it would leave the channel with no enabled credential of
  // either type, which is the same rule the backend applies to the combined refs.
  const enabledCredentialCount = enabledKeysCount + enabledServiceAccountCount;
  const canBatchEnable = selectedDisabledKeys.length > 0;
  const batchDisableBlockedByLastEnabled =
    selectedEnabledKeys.length > 0 && enabledCredentialCount - selectedEnabledKeys.length < 1;
  const canBatchDisable = selectedEnabledKeys.length > 0 && !batchDisableBlockedByLastEnabled;
  const batchDeleteBlockedByLastKey =
    selectedKeys.size > 0 && validKeys.length + serviceAccounts.length - selectedKeys.size < 1;
  const batchDeleteBlockedByLastEnabled =
    selectedEnabledKeys.length > 0 && enabledCredentialCount - selectedEnabledKeys.length < 1;
  const isLastKey = validKeys.length + serviceAccounts.length <= 1;

  const isPending =
    testingKey !== null ||
    disableAPIKey.isPending ||
    enableAPIKey.isPending ||
    enableSelectedAPIKeys.isPending ||
    disableSelectedAPIKeys.isPending ||
    updateChannel.isPending ||
    deleteDisabledAPIKeys.isPending;

  useEffect(() => {
    activeSessionRef.current += 1;
    snapshotVersionRef.current += 1;
    if (open) {
      activeChannelIdRef.current = currentRow?.id;
      setBulkImportText('');
      // Vertex 渠道的三元组密钥存在 vertexApiKeys,平铺密钥存在 apiKeys;
      // 普通渠道只用平铺 apiKeys。初始化时两个来源都读,避免批量导入时
      // 只读绑定 key 导致平铺 key 从列表消失。
      const flatKeys = currentRow?.credentials?.apiKeys ?? [];
      const boundKeys = (currentRow?.credentials?.vertexApiKeys ?? []).map((binding) => binding.apiKey);
      const initialKeys = [...flatKeys, ...boundKeys];
      setLocalKeys(initialKeys);
      setVertexBindings(currentRow?.credentials?.vertexApiKeys ?? []);
      setLocalNames(currentRow?.credentials?.apiKeyNames ?? []);
      setBaselineCredentialsVersion(currentRow?.credentialsVersion ?? undefined);
      setConflictNotice(null);
      setEditingNameKey(null);
      setEditingNameValue('');
      setEditingNameError(null);
      setServiceAccounts(currentRow?.credentials?.vertexServiceAccounts ?? []);
      setConfirmDeleteServiceAccount(null);
      setSelectedKeys(new Set());
      setTestingKey(null);
      setTestResults({});
      setPendingTestDisabled({});
      setConfirmDisableKey(null);
      setConfirmKeepDisabledKey(null);
      setConfirmEnableKey(null);
      setConfirmDeleteKey(null);
      setConfirmDeleteSelected(false);
      setConfirmEnableSelected(false);
      setConfirmDisableSelected(false);
      abortRef.current = false;
    } else {
      abortRef.current = true;
      activeChannelIdRef.current = undefined;
    }
    // 仅在弹窗打开或切换渠道时初始化一次 localKeys；
    // 依赖 currentRow.credentials.apiKeys 会导致导入/删除后的本地更新被覆盖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentRow?.id]);

  // Vertex 密钥只能作为三元组提交：平铺进 apiKeys 会变成没有项目绑定的密钥，
  // 所以列表里的 Vertex 密钥要从 apiKeys 里排除，绑定则按存活的 key 过滤后原样带回。
  const buildCredentials = (keys: string[], accounts = serviceAccounts, names = localNames) => {
    if (!isVertexChannel) {
      return {
        apiKeys: keys,
        ...(canEditKeyNames ? { apiKeyNames: normalizeAPIKeyNamesForKeys(names, keys) } : {}),
      };
    }
    const boundKeys = new Set(vertexBindings.map((binding) => binding.apiKey));
    const keptKeys = new Set(keys);
    return {
      apiKeys: keys.filter((key) => !boundKeys.has(key)),
      vertexApiKeys: vertexBindings.filter((binding) => keptKeys.has(binding.apiKey)),
      // Both Vertex lists are replaced wholesale on save, so the untouched list has to
      // be echoed back; credentialRef stays server-owned and is never submitted.
      vertexServiceAccounts: toVertexServiceAccountInputs(accounts),
    };
  };

  type SessionGuard = {
    sessionId: number;
    channelId: string;
    startedVersion?: number;
  };

  const captureSessionGuard = (): SessionGuard => ({
    sessionId: activeSessionRef.current,
    channelId: currentRow.id,
    startedVersion: snapshotVersionRef.current,
  });

  const applyChannelSnapshot = (snapshot: Channel, guard?: SessionGuard) => {
    if (guard) {
      if (!isCurrentSession(guard.sessionId, guard.channelId) || snapshot.id !== guard.channelId) {
        return validKeys;
      }
      if (guard.startedVersion !== undefined && snapshotVersionRef.current > guard.startedVersion) {
        return validKeys;
      }
    }
    if (!snapshot.credentials) {
      return validKeys;
    }
    snapshotVersionRef.current += 1;
    const flatKeys = snapshot.credentials.apiKeys ?? [];
    const boundKeys = (snapshot.credentials.vertexApiKeys ?? []).map((binding) => binding.apiKey);
    const nextKeys = [...flatKeys, ...boundKeys];
    setLocalKeys(nextKeys);
    setVertexBindings(snapshot.credentials.vertexApiKeys ?? []);
    setLocalNames(snapshot.credentials.apiKeyNames ?? []);
    setServiceAccounts(snapshot.credentials.vertexServiceAccounts ?? []);
    setBaselineCredentialsVersion(snapshot.credentialsVersion ?? undefined);
    setSelectedKeys((prev) => {
      if (prev.size === 0) {
        return prev;
      }
      const allowed = new Set(nextKeys);
      const next = new Set<string>();
      prev.forEach((k) => {
        if (allowed.has(k)) {
          next.add(k);
        }
      });
      return next;
    });
    setCurrentRow?.((prev) => (prev && prev.id === snapshot.id ? snapshot : prev));
    return nextKeys;
  };

  const commitMutationResult = (
    updated: Channel | undefined,
    committed: {
      keys?: string[];
      names?: APIKeyName[];
      bindings?: NonNullable<ChannelCredentials['vertexApiKeys']>;
      accounts?: NonNullable<ChannelCredentials['vertexServiceAccounts']>;
    },
    guard: SessionGuard
  ) => {
    if (!isCurrentSession(guard.sessionId, guard.channelId)) {
      return;
    }
    setConflictNotice(null);
    if (updated?.credentials) {
      applyChannelSnapshot(updated, { sessionId: guard.sessionId, channelId: guard.channelId });
      return;
    }

    snapshotVersionRef.current += 1;
    const nextKeys = committed.keys ?? localKeys;
    const nextNames = committed.names ?? localNames;
    const nextBindings = committed.bindings ?? vertexBindings;
    const nextAccounts = committed.accounts ?? serviceAccounts;

    if (committed.keys !== undefined) {
      setLocalKeys(committed.keys);
      setSelectedKeys((prev) => {
        if (prev.size === 0) {
          return prev;
        }
        const allowed = new Set(committed.keys);
        const next = new Set<string>();
        prev.forEach((k) => {
          if (allowed.has(k)) {
            next.add(k);
          }
        });
        return next;
      });
    }
    if (committed.names !== undefined) {
      setLocalNames(committed.names);
    }
    if (committed.bindings !== undefined) {
      setVertexBindings(committed.bindings);
    }
    if (committed.accounts !== undefined) {
      setServiceAccounts(committed.accounts);
    }
    if (updated?.credentialsVersion) {
      setBaselineCredentialsVersion(updated.credentialsVersion);
    }
    setCurrentRow?.((prev) => {
      if (!prev || prev.id !== guard.channelId) {
        return prev;
      }
      const nextCredentials = isVertexChannel
        ? {
            ...(prev.credentials ?? {}),
            apiKeys: nextKeys.filter((key) => !nextBindings.some((binding) => binding.apiKey === key)),
            vertexApiKeys: nextBindings,
            vertexServiceAccounts: nextAccounts,
          }
        : {
            ...(prev.credentials ?? {}),
            apiKeys: nextKeys,
            ...(canEditKeyNames ? { apiKeyNames: nextNames } : {}),
          };
      return {
        ...prev,
        ...(updated ?? {}),
        credentials: nextCredentials,
      };
    });
  };

  const syncBaselineAfterStateMutation = async (guard?: SessionGuard): Promise<boolean> => {
    const activeGuard = guard ?? captureSessionGuard();
    if (typeof fetchLatestChannel !== 'function' || !baselineCredentialsVersion) {
      return false;
    }
    const startedVersion = snapshotVersionRef.current;
    try {
      const latest = await fetchLatestChannel(activeGuard.channelId);
      if (!isCurrentSession(activeGuard.sessionId, activeGuard.channelId) || snapshotVersionRef.current !== startedVersion) {
        return false;
      }
      applyChannelSnapshot(latest, {
        sessionId: activeGuard.sessionId,
        channelId: activeGuard.channelId,
        startedVersion,
      });
      return Boolean(latest?.credentials);
    } catch {
      return false;
    }
  };

  const refreshAfterConflict = async (options?: { editingKey?: string | null; guard?: SessionGuard }) => {
    const activeGuard = options?.guard ?? captureSessionGuard();
    if (!isCurrentSession(activeGuard.sessionId, activeGuard.channelId)) {
      return;
    }
    void refetchDisabledKeys?.();
    let refreshedKeys = validKeys;
    const startedVersion = snapshotVersionRef.current;
    if (typeof fetchLatestChannel === 'function') {
      try {
        const latest = await fetchLatestChannel(activeGuard.channelId);
        if (!isCurrentSession(activeGuard.sessionId, activeGuard.channelId)) {
          return;
        }
        refreshedKeys = applyChannelSnapshot(latest, {
          sessionId: activeGuard.sessionId,
          channelId: activeGuard.channelId,
          startedVersion,
        });
      } catch {
        // Keep current keys when reload fails.
      }
    }
    if (!isCurrentSession(activeGuard.sessionId, activeGuard.channelId)) {
      return;
    }

    const targetKey = options?.editingKey;
    if (targetKey) {
      if (refreshedKeys.includes(targetKey)) {
        const msg = t('channels.dialogs.keyManagement.concurrentUpdateConflict');
        setEditingNameError(msg);
        setConflictNotice(msg);
      } else {
        cancelEditingKeyName();
        setConflictNotice(t('channels.dialogs.keyManagement.concurrentUpdateConflictKeyRemoved'));
      }
      return;
    }

    setConflictNotice(t('channels.dialogs.keyManagement.concurrentUpdateConflict'));
  };

  const handleClose = () => {
    abortRef.current = true;
    activeSessionRef.current += 1;
    activeChannelIdRef.current = undefined;
    setOpen(null);
    onOpenChange(false);
    setBulkImportText('');
    setBaselineCredentialsVersion(undefined);
    setConflictNotice(null);
    setEditingNameKey(null);
    setEditingNameValue('');
    setEditingNameError(null);
    setSelectedKeys(new Set());
    setTestingKey(null);
    setTestResults({});
    setPendingTestDisabled({});
    setConfirmDisableKey(null);
    setConfirmKeepDisabledKey(null);
    setConfirmEnableKey(null);
    setConfirmDeleteKey(null);
    setConfirmDeleteSelected(false);
    setConfirmEnableSelected(false);
    setConfirmDisableSelected(false);
  };

  /** 批量导入：多行文本，一行一个 key，去重、去空白，追加到渠道密钥列表 */
  const handleBulkImport = async () => {
    if (!hasLoadedCredentials || isVertexChannel) {
      return;
    }

    const newKeys = bulkImportText
      .split('\n')
      .map((k) => k.trim())
      .filter((k) => k.length > 0);
    if (newKeys.length === 0) {
      return;
    }

    const existing = new Set(validKeys);
    // 先对输入自身去重（同一 key 粘贴多行时只保留一个）
    const deduped = [...new Set(newKeys)].filter((k) => !existing.has(k));
    if (deduped.length === 0) {
      setBulkImportText('');
      return;
    }

    const guard = captureSessionGuard();
    const nextKeys = [...validKeys, ...deduped];
    const nextNames = normalizeAPIKeyNamesForKeys(localNames, nextKeys);
    try {
      const updated = await updateChannel.mutateAsync({
        id: guard.channelId,
        input: {
          credentials: buildCredentials(nextKeys, serviceAccounts, nextNames),
        },
        ...(baselineCredentialsVersion ? { expectedCredentialsVersion: baselineCredentialsVersion } : {}),
      });
      if (!isCurrentSession(guard.sessionId, guard.channelId)) {
        return;
      }
      commitMutationResult(updated, { keys: nextKeys, names: nextNames }, guard);
      setBulkImportText('');
    } catch (error) {
      if (isErrorCode?.(error, 'CHANNEL_UPDATED_CONCURRENTLY')) {
        await refreshAfterConflict({ guard });
      }
    }
  };

  /** 删除 key（纯禁用 key 走 deleteDisabledAPIKeys；包含活动 key 时通过单次 updateChannel 原子提交并由服务端清理关联禁用记录） */
  const deleteKeys = async (keysToDelete: string[], guard = captureSessionGuard()) => {
    if (!hasLoadedCredentials || keysToDelete.length === 0) {
      return;
    }

    const deleteSet = new Set(keysToDelete);
    const remainingKeys = validKeys.filter((key) => !deleteSet.has(key));
    if (remainingKeys.length + serviceAccounts.length < 1) {
      toast.error(t('channels.dialogs.fields.apiKey.mustKeepOne'));
      return;
    }

    const deletedEnabledCount = keysToDelete.filter((key) => !effectivelyDisabledSet.has(key)).length;
    if (deletedEnabledCount > 0 && enabledCredentialCount - deletedEnabledCount < 1) {
      toast.error(t('channels.dialogs.fields.apiKey.mustKeepOneEnabled'));
      return;
    }

    const disabled = keysToDelete.filter((key) => effectivelyDisabledSet.has(key));
    const active = keysToDelete.filter((key) => !effectivelyDisabledSet.has(key));
    const nextNames = normalizeAPIKeyNamesForKeys(localNames, remainingKeys);
    const nextBindings = vertexBindings.filter((binding) => !deleteSet.has(binding.apiKey));

    if (active.length === 0) {
      await deleteDisabledAPIKeys.mutateAsync({ channelID: guard.channelId, keys: disabled });
      if (!isCurrentSession(guard.sessionId, guard.channelId)) {
        return;
      }
      const synced = await syncBaselineAfterStateMutation(guard);
      if (!isCurrentSession(guard.sessionId, guard.channelId)) {
        return;
      }
      if (!synced && snapshotVersionRef.current === guard.startedVersion) {
        snapshotVersionRef.current += 1;
        setLocalKeys(remainingKeys);
        setLocalNames(nextNames);
        setVertexBindings(nextBindings);
      }
      return;
    }

    const updated = await updateChannel.mutateAsync({
      id: guard.channelId,
      input: { credentials: buildCredentials(remainingKeys, serviceAccounts, nextNames) },
      ...(baselineCredentialsVersion ? { expectedCredentialsVersion: baselineCredentialsVersion } : {}),
    });
    commitMutationResult(updated, { keys: remainingKeys, names: nextNames, bindings: nextBindings }, guard);
  };

  const handleDeleteSingle = async (key: string) => {
    const guard = captureSessionGuard();
    try {
      await deleteKeys([key], guard);
      if (isCurrentSession(guard.sessionId, guard.channelId)) {
        setConfirmDeleteKey(null);
      }
    } catch (error) {
      if (isErrorCode?.(error, 'CHANNEL_UPDATED_CONCURRENTLY')) {
        if (isCurrentSession(guard.sessionId, guard.channelId)) {
          setConfirmDeleteKey(null);
        }
        await refreshAfterConflict({ guard });
      }
    }
  };

  const handleDeleteSelected = async () => {
    if (selectedKeys.size === 0 || batchDeleteBlockedByLastKey || batchDeleteBlockedByLastEnabled) {
      return;
    }
    const guard = captureSessionGuard();
    try {
      await deleteKeys(Array.from(selectedKeys), guard);
      if (isCurrentSession(guard.sessionId, guard.channelId)) {
        setConfirmDeleteSelected(false);
        setSelectedKeys(new Set());
      }
    } catch (error) {
      if (isErrorCode?.(error, 'CHANNEL_UPDATED_CONCURRENTLY')) {
        if (isCurrentSession(guard.sessionId, guard.channelId)) {
          setConfirmDeleteSelected(false);
        }
        await refreshAfterConflict({ guard });
      }
    }
  };

  const updatePendingTestDisabled = (key: string, disabled: boolean) => {
    setPendingTestDisabled((prev) => {
      if (disabled) {
        return { ...prev, [key]: disabledKeysUpdatedAt };
      }
      if (!(key in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const handleTestSingle = async (key: string) => {
    if (testingKey) {
      return;
    }
    setTestingKey(key);
    try {
      const result = await testSingleKey.mutateAsync({
        channelID: currentRow.id,
        key,
        modelID: currentRow.defaultTestModel || undefined,
      });
      if (!abortRef.current) {
        setTestResults((prev) => ({ ...prev, [key]: result }));
        updatePendingTestDisabled(key, result.disabled);
      }
    } catch {
      if (!abortRef.current) {
        setTestResults((prev) => ({
          ...prev,
          [key]: { keyPrefix: maskAPIKey(key), success: false, latency: 0, error: t('channels.dialogs.testAPIKeys.requestFailed'), disabled: false },
        }));
        updatePendingTestDisabled(key, false);
      }
    } finally {
      if (!abortRef.current) {
        setTestingKey(null);
      }
    }
  };

  const handleTestSelected = async () => {
    const keysToTest = validKeys.filter((key) => selectedKeys.has(key));
    if (keysToTest.length === 0 || testingKey) {
      return;
    }

    abortRef.current = false;
    for (const key of keysToTest) {
      if (abortRef.current) {
        break;
      }
      setTestingKey(key);
      try {
        const result = await testSingleKey.mutateAsync({
          channelID: currentRow.id,
          key,
          modelID: currentRow.defaultTestModel || undefined,
        });
        if (!abortRef.current) {
          setTestResults((prev) => ({ ...prev, [key]: result }));
          updatePendingTestDisabled(key, result.disabled);
        }
      } catch {
        if (!abortRef.current) {
          setTestResults((prev) => ({
            ...prev,
            [key]: { keyPrefix: maskAPIKey(key), success: false, latency: 0, error: t('channels.dialogs.testAPIKeys.requestFailed'), disabled: false },
          }));
          updatePendingTestDisabled(key, false);
        }
      }
      if (!abortRef.current) {
        setTestingKey(null);
      }
    }
    setTestingKey(null);
  };

  const handleToggleDisable = async (key: string) => {
    const guard = captureSessionGuard();
    try {
      await disableAPIKey.mutateAsync({ channelID: guard.channelId, key });
      if (!isCurrentSession(guard.sessionId, guard.channelId)) {
        return;
      }
      void syncBaselineAfterStateMutation(guard);
      setConfirmDisableKey(null);
      setConfirmKeepDisabledKey(null);
    } catch {
      // handled by hooks
    }
  };

  const handleToggleEnable = async (key: string) => {
    const guard = captureSessionGuard();
    try {
      await enableAPIKey.mutateAsync({ channelID: guard.channelId, key });
      if (!isCurrentSession(guard.sessionId, guard.channelId)) {
        return;
      }
      setTestResults((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      updatePendingTestDisabled(key, false);
      void syncBaselineAfterStateMutation(guard);
      setConfirmEnableKey(null);
    } catch {
      // handled by hooks
    }
  };

  const handleEnableSelected = async () => {
    if (!canBatchEnable) {
      return;
    }
    const guard = captureSessionGuard();
    const keysToEnable = [...selectedDisabledKeys];
    try {
      await enableSelectedAPIKeys.mutateAsync({ channelID: guard.channelId, keys: keysToEnable });
      if (!isCurrentSession(guard.sessionId, guard.channelId)) {
        return;
      }
      setTestResults((prev) => {
        const next = { ...prev };
        keysToEnable.forEach((key) => {
          delete next[key];
        });
        return next;
      });
      setPendingTestDisabled((prev) => {
        const next = { ...prev };
        keysToEnable.forEach((key) => {
          delete next[key];
        });
        return next;
      });
      void syncBaselineAfterStateMutation(guard);
      setConfirmEnableSelected(false);
      setSelectedKeys(new Set());
    } catch {
      // handled by hooks
    }
  };

  const handleDisableSelected = async () => {
    if (!canBatchDisable) {
      return;
    }
    const guard = captureSessionGuard();
    try {
      await disableSelectedAPIKeys.mutateAsync({ channelID: guard.channelId, keys: selectedEnabledKeys });
      if (!isCurrentSession(guard.sessionId, guard.channelId)) {
        return;
      }
      void syncBaselineAfterStateMutation(guard);
      setConfirmDisableSelected(false);
      setSelectedKeys(new Set());
    } catch (error) {
      if (isErrorCode?.(error, 'CHANNEL_UPDATED_CONCURRENTLY')) {
        if (isCurrentSession(guard.sessionId, guard.channelId)) {
          setConfirmDisableSelected(false);
        }
        await refreshAfterConflict({ guard });
      }
    }
  };

  const cancelEditingKeyName = () => {
    setEditingNameKey(null);
    setEditingNameValue('');
    setEditingNameError(null);
  };

  const startEditingKeyName = (key: string) => {
    skipNameBlurRef.current = false;
    setEditingNameKey(key);
    setEditingNameValue(nameMap.get(key) ?? '');
    setEditingNameError(null);
  };

  const handleSaveKeyName = async (key: string) => {
    if (!hasLoadedCredentials || !canEditKeyNames) {
      cancelEditingKeyName();
      return;
    }
    const check = validateAPIKeyName(editingNameValue);
    if (check.tooLong) {
      setEditingNameError(t('channels.dialogs.fields.apiKey.nameTooLong', { max: MAX_API_KEY_NAME_LENGTH }));
      return;
    }
    const existingName = nameMap.get(key) ?? '';
    if (check.normalized === existingName && !conflictNotice) {
      cancelEditingKeyName();
      return;
    }

    const guard = captureSessionGuard();
    const nextNames = normalizeAPIKeyNamesForKeys(setAPIKeyName(localNames, key, check.normalized), validKeys);
    try {
      const updated = await updateChannel.mutateAsync({
        id: guard.channelId,
        input: {
          credentials: buildCredentials(validKeys, serviceAccounts, nextNames),
        },
        ...(baselineCredentialsVersion ? { expectedCredentialsVersion: baselineCredentialsVersion } : {}),
      });
      if (!isCurrentSession(guard.sessionId, guard.channelId)) {
        return;
      }
      commitMutationResult(updated, { names: nextNames }, guard);
      cancelEditingKeyName();
    } catch (error) {
      if (isErrorCode?.(error, 'CHANNEL_UPDATED_CONCURRENTLY')) {
        await refreshAfterConflict({ editingKey: key, guard });
      }
    }
  };

  /** Removes one service account row; disabled records for its ref are pruned server-side. */
  const handleDeleteServiceAccount = async (credentialRef: string) => {
    if (!hasLoadedCredentials) {
      return;
    }
    const guard = captureSessionGuard();
    const remaining = serviceAccounts.filter((account) => account.credentialRef !== credentialRef);
    try {
      const updated = await updateChannel.mutateAsync({
        id: guard.channelId,
        input: { credentials: buildCredentials(validKeys, remaining) },
        ...(baselineCredentialsVersion ? { expectedCredentialsVersion: baselineCredentialsVersion } : {}),
      });
      if (!isCurrentSession(guard.sessionId, guard.channelId)) {
        return;
      }
      commitMutationResult(updated, { accounts: remaining }, guard);
      setConfirmDeleteServiceAccount(null);
    } catch (error) {
      if (isErrorCode?.(error, 'CHANNEL_UPDATED_CONCURRENTLY')) {
        if (isCurrentSession(guard.sessionId, guard.channelId)) {
          setConfirmDeleteServiceAccount(null);
        }
        await refreshAfterConflict({ guard });
      }
    }
  };

  const handleSelectAll = () => {
    if (selectedKeys.size === validKeys.length) {
      setSelectedKeys(new Set());
    } else {
      setSelectedKeys(new Set(validKeys));
    }
  };

  const isAllSelected = validKeys.length > 0 && selectedKeys.size === validKeys.length;
  const isSomeSelected = selectedKeys.size > 0 && selectedKeys.size < validKeys.length;

  const getKeyResult = (key: string): TestAPIKeyResult | undefined => testResults[key];
  const isKeyDisabled = (key: string) => effectivelyDisabledSet.has(key);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='flex max-h-[90vh] flex-col overflow-hidden sm:max-w-4xl'>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2'>
            <IconKey className='h-5 w-5' />
            {t('channels.dialogs.keyManagement.title')}
          </DialogTitle>
          <DialogDescription>{t('channels.dialogs.keyManagement.description', { name: currentRow.name })}</DialogDescription>
        </DialogHeader>

        <div className='min-h-0 flex-1 space-y-4 overflow-y-auto'>
          {conflictNotice && (
            <div className='border-destructive/50 bg-destructive/10 text-destructive flex items-start gap-2 rounded-md border px-3 py-2 text-xs'>
              <IconAlertTriangle className='mt-0.5 h-4 w-4 shrink-0' />
              <span>{conflictNotice}</span>
            </div>
          )}
          {/* 批量导入区 */}
          <div className='rounded-md border bg-muted/40 p-3'>
            <div className='flex flex-wrap items-center justify-between gap-2'>
              <div className='flex items-center gap-2 text-sm font-medium'>
                <IconUpload className='h-4 w-4' />
                {t('channels.dialogs.keyManagement.importTitle')}
              </div>
              <span className='text-muted-foreground text-xs'>{t('channels.dialogs.keyManagement.importHint')}</span>
            </div>
            <div className='mt-2 flex items-start gap-2'>
              <Textarea
                value={bulkImportText}
                onChange={(e) => setBulkImportText(e.target.value)}
                placeholder={t('channels.dialogs.keyManagement.importPlaceholder')}
                className='min-h-[64px] flex-1 font-mono text-xs'
                disabled={!hasLoadedCredentials || isVertexChannel}
              />
              <Button
                onClick={handleBulkImport}
                disabled={!hasLoadedCredentials || isVertexChannel || isPending || bulkImportText.trim().length === 0}
              >
                {updateChannel.isPending ? <IconLoader2 className='mr-2 h-4 w-4 animate-spin' /> : <IconUpload className='mr-2 h-4 w-4' />}
                {t('channels.dialogs.keyManagement.importButton')}
              </Button>
            </div>
          </div>

          {/* 表格 */}
          <div className='flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border'>
            {/* 批量操作头 */}
            <div className='flex flex-wrap items-center justify-between gap-4 rounded-t-lg border-b bg-muted/40 px-4 py-2'>
              <div className='flex items-center gap-2'>
                <Checkbox
                  checked={isAllSelected || (isSomeSelected && 'indeterminate')}
                  onCheckedChange={handleSelectAll}
                  aria-label={t('common.columns.selectAll')}
                />
                <span className='text-muted-foreground text-sm'>
                  {selectedKeys.size > 0
                    ? t('channels.dialogs.keyManagement.selectedCount', { count: selectedKeys.size })
                    : t('channels.dialogs.keyManagement.totalCount', { count: validKeys.length })}
                </span>
              </div>
              <div className='flex flex-wrap items-center gap-1.5'>
                <Button size='sm' variant='outline' onClick={handleTestSelected} disabled={isPending || selectedKeys.size === 0}>
                  <IconPlayerPlay className='mr-1 h-3.5 w-3.5' />
                  {t('channels.dialogs.keyManagement.testSelected', { count: selectedKeys.size })}
                </Button>
                <Popover open={confirmEnableSelected} onOpenChange={setConfirmEnableSelected}>
                  <PopoverTrigger asChild>
                    <Button size='sm' variant='outline' disabled={isPending || !canBatchEnable}>
                      <IconCircleCheck className='mr-1 h-3.5 w-3.5' />
                      {t('channels.dialogs.keyManagement.enableSelected', { count: selectedDisabledKeys.length })}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className='w-80'>
                    <div className='flex flex-col gap-3'>
                      <p className='text-sm'>
                        {t('channels.dialogs.keyManagement.confirmEnableSelected', { count: selectedDisabledKeys.length })}
                      </p>
                      <div className='flex justify-end gap-2'>
                        <Button size='sm' variant='outline' onClick={() => setConfirmEnableSelected(false)}>
                          {t('common.buttons.cancel')}
                        </Button>
                        <Button size='sm' onClick={handleEnableSelected} disabled={isPending}>
                          {t('common.buttons.confirm')}
                        </Button>
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>
                {batchDisableBlockedByLastEnabled ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className='inline-flex'>
                        <Button size='sm' variant='outline' disabled>
                          <IconBan className='mr-1 h-3.5 w-3.5' />
                          {t('channels.dialogs.keyManagement.disableSelected', { count: selectedEnabledKeys.length })}
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t('channels.dialogs.fields.apiKey.mustKeepOneEnabled')}</p>
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <Popover open={confirmDisableSelected} onOpenChange={setConfirmDisableSelected}>
                    <PopoverTrigger asChild>
                      <Button size='sm' variant='outline' disabled={isPending || !canBatchDisable}>
                        <IconBan className='mr-1 h-3.5 w-3.5' />
                        {t('channels.dialogs.keyManagement.disableSelected', { count: selectedEnabledKeys.length })}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className='w-80'>
                      <div className='flex flex-col gap-3'>
                        <p className='text-sm'>
                          {t('channels.dialogs.keyManagement.confirmDisableSelected', { count: selectedEnabledKeys.length })}
                        </p>
                        <div className='flex justify-end gap-2'>
                          <Button size='sm' variant='outline' onClick={() => setConfirmDisableSelected(false)}>
                            {t('common.buttons.cancel')}
                          </Button>
                          <Button size='sm' onClick={handleDisableSelected} disabled={isPending}>
                            {t('common.buttons.confirm')}
                          </Button>
                        </div>
                      </div>
                    </PopoverContent>
                  </Popover>
                )}
                {batchDeleteBlockedByLastKey || batchDeleteBlockedByLastEnabled ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className='inline-flex'>
                        <Button size='sm' variant='outline' className='text-destructive' disabled>
                          <IconTrash className='mr-1 h-3.5 w-3.5' />
                          {t('channels.dialogs.keyManagement.deleteSelected', { count: selectedKeys.size })}
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>
                        {batchDeleteBlockedByLastKey
                          ? t('channels.dialogs.fields.apiKey.mustKeepOne')
                          : t('channels.dialogs.fields.apiKey.mustKeepOneEnabled')}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <Popover open={confirmDeleteSelected} onOpenChange={setConfirmDeleteSelected}>
                    <PopoverTrigger asChild>
                      <Button
                        size='sm'
                        variant='outline'
                        className='text-destructive'
                        disabled={isPending || selectedKeys.size === 0}
                      >
                        <IconTrash className='mr-1 h-3.5 w-3.5' />
                        {t('channels.dialogs.keyManagement.deleteSelected', { count: selectedKeys.size })}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className='w-80'>
                      <div className='flex flex-col gap-3'>
                        <p className='text-sm'>
                          {t('channels.dialogs.keyManagement.confirmDeleteSelected', { count: selectedKeys.size })}
                        </p>
                        <div className='flex justify-end gap-2'>
                          <Button size='sm' variant='outline' onClick={() => setConfirmDeleteSelected(false)}>
                            {t('common.buttons.cancel')}
                          </Button>
                          <Button size='sm' variant='destructive' onClick={handleDeleteSelected} disabled={isPending}>
                            {t('common.buttons.confirm')}
                          </Button>
                        </div>
                      </div>
                    </PopoverContent>
                  </Popover>
                )}
              </div>
            </div>

            <div className='min-h-0 flex-1 overflow-y-auto'>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className='w-12'></TableHead>
                    {canEditKeyNames && <TableHead className='w-44'>{t('channels.dialogs.keyManagement.nameColumn')}</TableHead>}
                    <TableHead>{t('channels.dialogs.keyManagement.keyColumn')}</TableHead>
                    <TableHead className='w-40'>{t('channels.dialogs.keyManagement.statusColumn')}</TableHead>
                    <TableHead className='w-28'>{t('channels.dialogs.keyManagement.latencyColumn')}</TableHead>
                    <TableHead className='w-36'>{t('channels.dialogs.keyManagement.actionsColumn')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {disabledLoading && validKeys.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={canEditKeyNames ? 6 : 5} className='h-24 text-center'>
                        <IconLoader2 className='text-muted-foreground mx-auto h-5 w-5 animate-spin' />
                      </TableCell>
                    </TableRow>
                  ) : validKeys.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={canEditKeyNames ? 6 : 5} className='h-32 text-center text-sm text-muted-foreground'>
                        {t('channels.dialogs.keyManagement.noKeys')}
                      </TableCell>
                    </TableRow>
                  ) : (
                    validKeys.map((key, index) => {
                      const isTesting = testingKey === key;
                      const isDisabled = isKeyDisabled(key);
                      const disabledKey = activeDisabledKeys.find((item) => item.key === key);
                      const isQuotaDisabled = disabledKey?.quotaDisabled === true;
                      const fallbackName = `key${index + 1}`;
                      const customName = nameMap.get(key) ?? '';
                      const isDuplicateName = Boolean(customName && duplicateNames.has(customName));
                      const isEditingName = editingNameKey === key;
                      const result = getKeyResult(key);
                      const handleCopy = async () => {
                        try {
                          await copyTextToClipboard(key);
                          toast.success(t('channels.dialogs.keyManagement.copySuccess'));
                        } catch {
                          toast.error(t('common.errors.copyFailed'));
                        }
                      };
                      return (
                        <TableRow key={key}>
                          <TableCell>
                            <Checkbox
                              checked={selectedKeys.has(key)}
                              onCheckedChange={(checked) => {
                                setSelectedKeys((prev) => {
                                  const next = new Set(prev);
                                  if (checked) {
                                    next.add(key);
                                  } else {
                                    next.delete(key);
                                  }
                                  return next;
                                });
                              }}
                            />
                          </TableCell>
                          {canEditKeyNames && (
                            <TableCell>
                              {isEditingName ? (
                                <div className='space-y-1'>
                                  <div className='flex items-center gap-1'>
                                    <Input
                                      value={editingNameValue}
                                      placeholder={fallbackName}
                                      onChange={(e) => {
                                        setEditingNameValue(e.target.value);
                                        if (editingNameError) {
                                          setEditingNameError(null);
                                        }
                                      }}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                          e.preventDefault();
                                          skipNameBlurRef.current = true;
                                          void handleSaveKeyName(key);
                                        } else if (e.key === 'Escape') {
                                          e.preventDefault();
                                          skipNameBlurRef.current = true;
                                          cancelEditingKeyName();
                                        }
                                      }}
                                      onBlur={() => {
                                        if (skipNameBlurRef.current) {
                                          skipNameBlurRef.current = false;
                                          return;
                                        }
                                        if (editingNameError) {
                                          return;
                                        }
                                        void handleSaveKeyName(key);
                                      }}
                                      autoFocus
                                      className='h-7 px-2 text-xs'
                                      disabled={isPending}
                                    />
                                    <Button
                                      type='button'
                                      size='sm'
                                      variant='ghost'
                                      className='h-7 w-7 shrink-0 p-0'
                                      onMouseDown={(e) => e.preventDefault()}
                                      onClick={() => {
                                        skipNameBlurRef.current = true;
                                        return handleSaveKeyName(key);
                                      }}
                                      disabled={isPending}
                                      aria-label={t('common.buttons.save')}
                                    >
                                      <IconCheck className='h-3.5 w-3.5' />
                                    </Button>
                                    <Button
                                      type='button'
                                      size='sm'
                                      variant='ghost'
                                      className='h-7 w-7 shrink-0 p-0'
                                      onMouseDown={(e) => e.preventDefault()}
                                      onClick={() => {
                                        skipNameBlurRef.current = true;
                                        cancelEditingKeyName();
                                      }}
                                      disabled={isPending}
                                      aria-label={t('common.buttons.cancel')}
                                    >
                                      <IconX className='h-3.5 w-3.5' />
                                    </Button>
                                  </div>
                                  {editingNameError && <p className='text-destructive text-xs'>{editingNameError}</p>}
                                </div>
                              ) : (
                                <div className='flex items-center gap-1'>
                                  <button
                                    type='button'
                                    onClick={() => startEditingKeyName(key)}
                                    className={`hover:text-foreground truncate text-left text-sm ${
                                      customName ? 'font-medium' : 'text-foreground font-normal'
                                    }`}
                                    title={customName || fallbackName}
                                    disabled={isPending}
                                  >
                                    {customName || fallbackName}
                                  </button>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        type='button'
                                        size='sm'
                                        variant='ghost'
                                        className='h-6 w-6 shrink-0 p-0'
                                        onClick={() => startEditingKeyName(key)}
                                        disabled={isPending}
                                        aria-label={t('channels.dialogs.keyManagement.editName')}
                                      >
                                        <IconPencil className='h-3.5 w-3.5' />
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>{t('channels.dialogs.keyManagement.editName')}</TooltipContent>
                                  </Tooltip>
                                  {isDuplicateName && (
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <IconAlertTriangle className='h-3.5 w-3.5 shrink-0 text-amber-500' />
                                      </TooltipTrigger>
                                      <TooltipContent>{t('channels.dialogs.fields.apiKey.duplicateNameWarning')}</TooltipContent>
                                    </Tooltip>
                                  )}
                                </div>
                              )}
                            </TableCell>
                          )}
                          <TableCell className='font-medium'>
                            <div className='flex items-center gap-2'>
                              {isTesting && <IconLoader2 className='h-3 w-3 animate-spin text-muted-foreground' />}
                              <code className='bg-muted rounded px-2 py-0.5 font-mono text-sm'>
                                {result ? result.keyPrefix : maskAPIKey(key)}
                              </code>
                            </div>
                            {isDisabled && (disabledKey?.reason || (disabledKey?.errorCode != null && disabledKey.errorCode !== 0) || isQuotaDisabled) && (
                              <div className='text-muted-foreground mt-1 flex flex-wrap items-center gap-1.5 text-xs'>
                                {disabledKey?.reason && <span>{disabledKey.reason}</span>}
                                {disabledKey?.errorCode != null && disabledKey.errorCode !== 0 && (
                                  <span>{t('channels.dialogs.fields.apiKey.errorCodeBadge', { code: disabledKey.errorCode })}</span>
                                )}
                                {isQuotaDisabled && <span>{t('channels.dialogs.keyManagement.quotaDisabled')}</span>}
                              </div>
                            )}
                            {result?.error && (
                              <div className='mt-1 flex items-start gap-1 text-xs text-destructive'>
                                <IconAlertTriangle className='mt-0.5 h-3 w-3 shrink-0' />
                                <span className='whitespace-normal break-all'>{result.error}</span>
                              </div>
                            )}
                          </TableCell>
                          <TableCell>
                            {isDisabled ? (
                              <Badge variant='secondary'>{t('channels.dialogs.keyManagement.disabled')}</Badge>
                            ) : result ? (
                              result.success ? (
                                <Badge variant='default' className='border-green-200 bg-green-100 text-green-800'>
                                  {t('channels.dialogs.keyManagement.success')}
                                </Badge>
                              ) : (
                                <Badge variant='destructive'>{t('channels.dialogs.keyManagement.failed')}</Badge>
                              )
                            ) : (
                              <span className='text-muted-foreground'>-</span>
                            )}
                          </TableCell>
                          <TableCell>{result && result.latency > 0 ? `${result.latency.toFixed(2)}s` : '-'}</TableCell>
                          <TableCell>
                            <div className='flex items-center gap-0.5'>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    size='sm'
                                    variant='ghost'
                                    className='h-7 w-7 p-0'
                                    onClick={() => handleTestSingle(key)}
                                    disabled={isPending}
                                    aria-label={t('channels.dialogs.keyManagement.test')}
                                  >
                                    <IconPlayerPlay className='h-4 w-4' />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>{t('channels.dialogs.keyManagement.test')}</TooltipContent>
                              </Tooltip>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    size='sm'
                                    variant='ghost'
                                    className='h-7 w-7 p-0'
                                    onClick={handleCopy}
                                    aria-label={t('channels.dialogs.keyManagement.copy')}
                                  >
                                    <IconCopy className='h-4 w-4' />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>{t('channels.dialogs.keyManagement.copy')}</TooltipContent>
                              </Tooltip>

                              {isDisabled ? (
                                <>
                                  <Popover open={confirmEnableKey === key} onOpenChange={(o) => setConfirmEnableKey(o ? key : null)}>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <PopoverTrigger asChild>
                                          <Button
                                            size='sm'
                                            variant='ghost'
                                            className='h-7 w-7 p-0'
                                            disabled={isPending}
                                            aria-label={t('channels.dialogs.keyManagement.enable')}
                                          >
                                            <IconCircleCheck className='h-4 w-4' />
                                          </Button>
                                        </PopoverTrigger>
                                      </TooltipTrigger>
                                      <TooltipContent>{t('channels.dialogs.keyManagement.enable')}</TooltipContent>
                                    </Tooltip>
                                    <PopoverContent className='w-64'>
                                      <div className='flex flex-col gap-3'>
                                        <p className='text-sm'>{t('channels.dialogs.keyManagement.confirmEnable')}</p>
                                        <div className='flex justify-end gap-2'>
                                          <Button size='sm' variant='outline' onClick={() => setConfirmEnableKey(null)}>
                                            {t('common.buttons.cancel')}
                                          </Button>
                                          <Button size='sm' onClick={() => handleToggleEnable(key)} disabled={isPending}>
                                            {t('common.buttons.confirm')}
                                          </Button>
                                        </div>
                                      </div>
                                    </PopoverContent>
                                  </Popover>
                                  {isQuotaDisabled && (
                                    <Popover
                                      open={confirmKeepDisabledKey === key}
                                      onOpenChange={(o) => setConfirmKeepDisabledKey(o ? key : null)}
                                    >
                                      <PopoverTrigger asChild>
                                        <Button size='sm' variant='outline' className='h-7 px-2' disabled={isPending}>
                                          {t('channels.dialogs.keyManagement.keepDisabled')}
                                        </Button>
                                      </PopoverTrigger>
                                      <PopoverContent className='w-72'>
                                        <div className='flex flex-col gap-3'>
                                          <p className='text-sm'>
                                            {t('channels.dialogs.keyManagement.confirmKeepDisabled')}
                                          </p>
                                          <div className='flex justify-end gap-2'>
                                            <Button size='sm' variant='outline' onClick={() => setConfirmKeepDisabledKey(null)}>
                                              {t('common.buttons.cancel')}
                                            </Button>
                                            <Button size='sm' onClick={() => handleToggleDisable(key)} disabled={isPending}>
                                              {t('common.buttons.confirm')}
                                            </Button>
                                          </div>
                                        </div>
                                      </PopoverContent>
                                    </Popover>
                                  )}
                                </>
                              ) : (
                                <Popover open={confirmDisableKey === key} onOpenChange={(o) => setConfirmDisableKey(o ? key : null)}>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <PopoverTrigger asChild>
                                        <Button
                                          size='sm'
                                          variant='ghost'
                                          className='h-7 w-7 p-0'
                                          disabled={isPending || enabledCredentialCount <= 1}
                                          aria-label={t('channels.dialogs.keyManagement.disable')}
                                        >
                                          <IconBan className='h-4 w-4' />
                                        </Button>
                                      </PopoverTrigger>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      {enabledCredentialCount <= 1
                                        ? t('channels.dialogs.fields.apiKey.mustKeepOneEnabled')
                                        : t('channels.dialogs.keyManagement.disable')}
                                    </TooltipContent>
                                  </Tooltip>
                                  <PopoverContent className='w-64'>
                                    <div className='flex flex-col gap-3'>
                                      <p className='text-sm'>{t('channels.dialogs.keyManagement.confirmDisable')}</p>
                                      <div className='flex justify-end gap-2'>
                                        <Button size='sm' variant='outline' onClick={() => setConfirmDisableKey(null)}>
                                          {t('common.buttons.cancel')}
                                        </Button>
                                        <Button size='sm' onClick={() => handleToggleDisable(key)} disabled={isPending}>
                                          {t('common.buttons.confirm')}
                                        </Button>
                                      </div>
                                    </div>
                                  </PopoverContent>
                                </Popover>
                              )}

                              <Popover open={confirmDeleteKey === key} onOpenChange={(o) => setConfirmDeleteKey(o ? key : null)}>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <PopoverTrigger asChild>
                                      <Button
                                        size='sm'
                                        variant='ghost'
                                        className='text-destructive h-7 w-7 p-0'
                                        disabled={isPending || isLastKey || (!isDisabled && enabledCredentialCount <= 1)}
                                        aria-label={t('channels.dialogs.keyManagement.delete')}
                                      >
                                        <IconTrash className='h-4 w-4' />
                                      </Button>
                                    </PopoverTrigger>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    {isLastKey
                                      ? t('channels.dialogs.fields.apiKey.mustKeepOne')
                                      : !isDisabled && enabledCredentialCount <= 1
                                        ? t('channels.dialogs.fields.apiKey.mustKeepOneEnabled')
                                        : t('channels.dialogs.keyManagement.delete')}
                                  </TooltipContent>
                                </Tooltip>
                                <PopoverContent className='w-64'>
                                  <div className='flex flex-col gap-3'>
                                    <p className='text-sm'>{t('channels.dialogs.keyManagement.confirmDelete')}</p>
                                    <div className='flex justify-end gap-2'>
                                      <Button size='sm' variant='outline' onClick={() => setConfirmDeleteKey(null)}>
                                        {t('common.buttons.cancel')}
                                      </Button>
                                      <Button size='sm' variant='destructive' onClick={() => handleDeleteSingle(key)} disabled={isPending}>
                                        {t('common.buttons.confirm')}
                                      </Button>
                                    </div>
                                  </div>
                                </PopoverContent>
                              </Popover>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          </div>

          {/* Service account rows come after the API keys and act on credentialRef only:
              the JSON body never appears in the table, the copy action, or a tooltip. */}
          {isVertexChannel && (
            <div className='flex shrink-0 flex-col overflow-hidden rounded-lg border'>
              <div className='flex flex-wrap items-center justify-between gap-4 border-b bg-muted/40 px-4 py-2'>
                <div className='flex items-center gap-2'>
                  <IconKey className='text-muted-foreground h-4 w-4' />
                  <span className='text-sm font-medium'>{t('channels.dialogs.keyManagement.serviceAccountTitle')}</span>
                  <span className='text-muted-foreground text-xs'>
                    {t('channels.dialogs.keyManagement.serviceAccountCount', { count: serviceAccounts.length })}
                  </span>
                </div>
                <Button size='sm' variant='outline' onClick={() => setOpen('edit')}>
                  <IconPencil className='mr-1 h-3.5 w-3.5' />
                  {t('channels.dialogs.keyManagement.serviceAccountManage')}
                </Button>
              </div>

              <div className='max-h-64 overflow-y-auto'>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('channels.dialogs.keyManagement.serviceAccountColumn')}</TableHead>
                      <TableHead className='w-32'>{t('channels.dialogs.keyManagement.serviceAccountProjectColumn')}</TableHead>
                      <TableHead className='w-40'>{t('channels.dialogs.keyManagement.statusColumn')}</TableHead>
                      <TableHead className='w-28'>{t('channels.dialogs.keyManagement.latencyColumn')}</TableHead>
                      <TableHead className='w-36'>{t('channels.dialogs.keyManagement.actionsColumn')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {serviceAccounts.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} className='h-20 text-center text-sm text-muted-foreground'>
                          {t('channels.dialogs.keyManagement.serviceAccountEmpty')}
                        </TableCell>
                      </TableRow>
                    ) : (
                      serviceAccounts.map((account, index) => {
                        const credentialRef = account.credentialRef ?? '';
                        const identity = getVertexServiceAccountIdentity(account.jsonData);
                        const isTesting = credentialRef.length > 0 && testingKey === credentialRef;
                        const isDisabled = credentialRef.length > 0 && isKeyDisabled(credentialRef);
                        const result = credentialRef.length > 0 ? getKeyResult(credentialRef) : undefined;
                        const displayName = identity.clientEmail || maskVertexCredentialRef(credentialRef);
                        return (
                          <TableRow key={credentialRef || `${identity.clientEmail}-${index}`}>
                            <TableCell className='font-medium'>
                              <div className='flex items-center gap-2'>
                                {isTesting && <IconLoader2 className='h-3 w-3 animate-spin text-muted-foreground' />}
                                <code className='bg-muted rounded px-2 py-0.5 font-mono text-xs'>
                                  {result ? result.keyPrefix : displayName}
                                </code>
                              </div>
                              {result?.error && (
                                <div className='mt-1 flex items-start gap-1 text-xs text-destructive'>
                                  <IconAlertTriangle className='mt-0.5 h-3 w-3 shrink-0' />
                                  <span className='whitespace-normal break-all'>{result.error}</span>
                                </div>
                              )}
                            </TableCell>
                            <TableCell>
                              <div className='font-mono text-xs'>{account.projectID || '-'}</div>
                              <div className='text-muted-foreground text-xs'>{account.region || 'global'}</div>
                            </TableCell>
                            <TableCell>
                              {isDisabled ? (
                                <Badge variant='secondary'>{t('channels.dialogs.keyManagement.disabled')}</Badge>
                              ) : result ? (
                                result.success ? (
                                  <Badge variant='default' className='border-green-200 bg-green-100 text-green-800'>
                                    {t('channels.dialogs.keyManagement.success')}
                                  </Badge>
                                ) : (
                                  <Badge variant='destructive'>{t('channels.dialogs.keyManagement.failed')}</Badge>
                                )
                              ) : (
                                <span className='text-muted-foreground'>-</span>
                              )}
                            </TableCell>
                            <TableCell>{result && result.latency > 0 ? `${result.latency.toFixed(2)}s` : '-'}</TableCell>
                            <TableCell>
                              <div className='flex items-center gap-0.5'>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      size='sm'
                                      variant='ghost'
                                      className='h-7 w-7 p-0'
                                      onClick={() => handleTestSingle(credentialRef)}
                                      aria-label={t('channels.dialogs.keyManagement.test')}
                                      disabled={isPending || credentialRef.length === 0}
                                    >
                                      <IconPlayerPlay className='h-4 w-4' />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>{t('channels.dialogs.keyManagement.test')}</TooltipContent>
                                </Tooltip>

                                {isDisabled ? (
                                  <Popover
                                    open={confirmEnableKey === credentialRef}
                                    onOpenChange={(o) => setConfirmEnableKey(o ? credentialRef : null)}
                                  >
                                    <PopoverTrigger asChild>
                                      <Button size='sm' variant='ghost' className='h-7 w-7 p-0' disabled={isPending} aria-label={t('channels.dialogs.keyManagement.enable')}>
                                        <IconCircleCheck className='h-4 w-4' />
                                      </Button>
                                    </PopoverTrigger>
                                    <PopoverContent className='w-64'>
                                      <div className='flex flex-col gap-3'>
                                        <p className='text-sm'>{t('channels.dialogs.keyManagement.confirmEnable')}</p>
                                        <div className='flex justify-end gap-2'>
                                          <Button size='sm' variant='outline' onClick={() => setConfirmEnableKey(null)}>
                                            {t('common.buttons.cancel')}
                                          </Button>
                                          <Button size='sm' onClick={() => handleToggleEnable(credentialRef)} disabled={isPending}>
                                            {t('common.buttons.confirm')}
                                          </Button>
                                        </div>
                                      </div>
                                    </PopoverContent>
                                  </Popover>
                                ) : (
                                  <Popover
                                    open={confirmDisableKey === credentialRef}
                                    onOpenChange={(o) => setConfirmDisableKey(o ? credentialRef : null)}
                                  >
                                    <PopoverTrigger asChild>
                                      <Button
                                        size='sm'
                                        variant='ghost'
                                        className='h-7 w-7 p-0'
                                        disabled={isPending || enabledCredentialCount <= 1 || credentialRef.length === 0}
                                        aria-label={t('channels.dialogs.keyManagement.disable')}
                                      >
                                        <IconBan className='h-4 w-4' />
                                      </Button>
                                    </PopoverTrigger>
                                    <PopoverContent className='w-64'>
                                      <div className='flex flex-col gap-3'>
                                        <p className='text-sm'>{t('channels.dialogs.keyManagement.confirmDisable')}</p>
                                        <div className='flex justify-end gap-2'>
                                          <Button size='sm' variant='outline' onClick={() => setConfirmDisableKey(null)}>
                                            {t('common.buttons.cancel')}
                                          </Button>
                                          <Button size='sm' onClick={() => handleToggleDisable(credentialRef)} disabled={isPending}>
                                            {t('common.buttons.confirm')}
                                          </Button>
                                        </div>
                                      </div>
                                    </PopoverContent>
                                  </Popover>
                                )}

                                <Popover
                                  open={confirmDeleteServiceAccount === credentialRef}
                                  onOpenChange={(o) => setConfirmDeleteServiceAccount(o ? credentialRef : null)}
                                >
                                  <PopoverTrigger asChild>
                                    <Button
                                      size='sm'
                                      variant='ghost'
                                      className='text-destructive h-7 w-7 p-0'
                                      disabled={
                                        isPending ||
                                        isLastKey ||
                                        credentialRef.length === 0 ||
                                        (!isDisabled && enabledCredentialCount <= 1)
                                      }
                                      aria-label={t('channels.dialogs.keyManagement.delete')}
                                    >
                                      <IconTrash className='h-4 w-4' />
                                    </Button>
                                  </PopoverTrigger>
                                  <PopoverContent className='w-64'>
                                    <div className='flex flex-col gap-3'>
                                      <p className='text-sm'>{t('channels.dialogs.keyManagement.confirmDelete')}</p>
                                      <div className='flex justify-end gap-2'>
                                        <Button size='sm' variant='outline' onClick={() => setConfirmDeleteServiceAccount(null)}>
                                          {t('common.buttons.cancel')}
                                        </Button>
                                        <Button
                                          size='sm'
                                          variant='destructive'
                                          onClick={() => handleDeleteServiceAccount(credentialRef)}
                                          disabled={isPending}
                                        >
                                          {t('common.buttons.confirm')}
                                        </Button>
                                      </div>
                                    </div>
                                  </PopoverContent>
                                </Popover>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </div>

        <DialogFooter align='between' className='items-center'>
          <div className='text-muted-foreground text-xs'>
            {isPending ? t('channels.dialogs.keyManagement.processing') : t('channels.dialogs.keyManagement.footerHint')}
          </div>
          <Button variant='outline' onClick={handleClose}>
            {t('common.buttons.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
