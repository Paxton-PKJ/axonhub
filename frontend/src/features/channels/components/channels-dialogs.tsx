import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useChannels } from '../context/channels-context';
import { useChannelDetails } from '../data/channels';
import type { Channel } from '../data/schema';
import { ChannelsActionDialog } from './channels-action-dialog';
import { ChannelsAPIKeyManagementDialog } from './channels-api-key-management-dialog';
import { ChannelsArchiveDialog } from './channels-archive-dialog';
import { ChannelsAvailabilityDialog } from './channels-availability-dialog';
import { ChannelsBulkApplyTemplateDialog } from './channels-bulk-apply-template-dialog';
import { ChannelsBulkArchiveDialog } from './channels-bulk-archive-dialog';
import { ChannelsBulkAutoDisableDialog } from './channels-bulk-auto-disable-dialog';
import { ChannelsBulkClearTemplateDialog } from './channels-bulk-clear-template-dialog';
import { ChannelsBulkManageTagsDialog } from './channels-bulk-manage-tags-dialog';
import { ChannelsBulkDeleteDialog } from './channels-bulk-delete-dialog';
import { ChannelsBulkDisableDialog } from './channels-bulk-disable-dialog';
import { ChannelsBulkEnableDialog } from './channels-bulk-enable-dialog';
import { ChannelsBulkImportDialog } from './channels-bulk-import-dialog';
import { ChannelsBulkOrderingDialog } from './channels-bulk-ordering-dialog';
import { ChannelsBulkTestDialog } from './channels-bulk-test-dialog';
import { ChannelsDeleteDialog } from './channels-delete-dialog';
import { ChannelsDisabledAPIKeysDialog } from './channels-disabled-api-keys-dialog';
import { ChannelsEndpointsDialog } from './channels-endpoints-dialog';
import { ChannelsErrorResolvedDialog } from './channels-error-resolved-dialog';
import { ChannelsModelMappingDialog } from './channels-model-mapping-dialog';
import { ChannelsModelPriceDialog } from './channels-model-price-dialog';
import { ChannelsOverrideDialog } from './channels-override-dialog';
import { ChannelsProxyDialog } from './channels-proxy-dialog';
import { ChannelsRateLimitDialog } from './channels-rate-limit-dialog';
import { ChannelsStatusDialog } from './channels-status-dialog';
import { ChannelsSystemSettingsDialog } from './channels-system-settings-dialog';
import { ChannelsTemplateManagerDialog } from './channels-template-manager-dialog';
import { ChannelsTestDialog } from './channels-test-dialog';
import { ChannelsTestHistoryDrawer } from './channels-test-history-drawer';
import { ChannelsTransformOptionsDialog } from './channels-transform-options-dialog';

export function ChannelsDialogs() {
  const { t } = useTranslation();
  const { open, setOpen, currentRow: partialCurrentRow, setCurrentRow, selectedChannels } = useChannels();
  const detailsQuery = useChannelDetails(partialCurrentRow?.id, {
    enabled: Boolean(partialCurrentRow && open),
  });
  const lastSyncedDetailsRef = useRef<Channel | null>(null);
  const [hydratedRowId, setHydratedRowId] = useState<string | null>(null);

  useEffect(() => {
    if (!partialCurrentRow) {
      lastSyncedDetailsRef.current = null;
      setHydratedRowId(null);
      return;
    }
    if (hydratedRowId && hydratedRowId !== partialCurrentRow.id) {
      lastSyncedDetailsRef.current = null;
      setHydratedRowId(null);
    }
  }, [partialCurrentRow, hydratedRowId]);

  const rowHasDetails = Boolean(partialCurrentRow && partialCurrentRow.credentials !== undefined);

  useEffect(() => {
    const fetched = detailsQuery.data;
    if (!fetched || partialCurrentRow?.id !== fetched.id) return;
    if (rowHasDetails && lastSyncedDetailsRef.current === fetched) return;
    lastSyncedDetailsRef.current = fetched;
    if (partialCurrentRow !== fetched) {
      setCurrentRow(fetched);
    }
    setHydratedRowId(fetched.id);
  }, [detailsQuery.data, partialCurrentRow, rowHasDetails, setCurrentRow]);

  useEffect(() => {
    if (open || !partialCurrentRow) return;
    // Cancel delayed cleanup if a row dialog reopens during its close animation.
    const timeout = setTimeout(() => setCurrentRow(null), 500);
    return () => clearTimeout(timeout);
  }, [open, partialCurrentRow, setCurrentRow]);

  // List rows intentionally contain only fields required by visible columns.
  // Delay row-scoped dialogs until the full snapshot has been loaded for the active channel ID,
  // while keeping mounted dialogs intact when background/conflict refetches refresh the same row.
  // Credential-bearing dialogs must never fall back to a partial list row when the initial fetch fails.
  const detailsMatchesRow = Boolean(partialCurrentRow && detailsQuery.data?.id === partialCurrentRow.id);
  const isRowHydrated = Boolean(
    partialCurrentRow &&
      ((rowHasDetails && hydratedRowId === partialCurrentRow.id) || (detailsMatchesRow && detailsQuery.data !== undefined))
  );
  const requiresFullDetails =
    open === 'edit' || open === 'duplicate' || open === 'viewModels' || open === 'keyManagement';
  const showDetailsLoadError = Boolean(
    partialCurrentRow && requiresFullDetails && !isRowHydrated && detailsQuery.isError
  );
  const currentRow =
    partialCurrentRow && (!open || isRowHydrated || (detailsQuery.isError && !requiresFullDetails))
      ? detailsMatchesRow && detailsQuery.data && (!rowHasDetails || lastSyncedDetailsRef.current !== detailsQuery.data)
        ? detailsQuery.data
        : partialCurrentRow
      : null;
  return (
    <>
      <ChannelsSystemSettingsDialog />

      <Dialog
        open={showDetailsLoadError}
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            setOpen(null);
          }
        }}
      >
        <DialogContent className='sm:max-w-md'>
          <DialogHeader>
            <DialogTitle>{t('channels.dialogs.detailsLoadError.title')}</DialogTitle>
            <DialogDescription>{t('channels.dialogs.detailsLoadError.description')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant='outline' onClick={() => setOpen(null)}>
              {t('common.buttons.close')}
            </Button>
            <Button
              onClick={() => {
                void detailsQuery.refetch();
              }}
              disabled={detailsQuery.isFetching}
            >
              {detailsQuery.isFetching
                ? t('channels.dialogs.detailsLoadError.retrying')
                : t('channels.dialogs.detailsLoadError.retry')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ChannelsTemplateManagerDialog open={open === 'templates'} onOpenChange={(isOpen) => setOpen(isOpen ? 'templates' : null)} />

      <ChannelsActionDialog key='channel-add' open={open === 'add'} onOpenChange={(isOpen) => setOpen(isOpen ? 'add' : null)} />

      <ChannelsBulkArchiveDialog />

      <ChannelsBulkDisableDialog />

      <ChannelsBulkEnableDialog />

      <ChannelsBulkTestDialog />

      <ChannelsBulkDeleteDialog />

      <ChannelsBulkManageTagsDialog />

      <ChannelsBulkApplyTemplateDialog
        open={open === 'bulkApplyTemplate'}
        onOpenChange={(isOpen) => setOpen(isOpen ? 'bulkApplyTemplate' : null)}
        selectedChannels={selectedChannels}
      />

      <ChannelsBulkAutoDisableDialog
        open={open === 'bulkAutoDisable'}
        onOpenChange={(isOpen) => setOpen(isOpen ? 'bulkAutoDisable' : null)}
        selectedChannels={selectedChannels}
      />

      <ChannelsBulkClearTemplateDialog />

      <ChannelsBulkImportDialog isOpen={open === 'bulkImport'} onClose={() => setOpen(null)} />

      <ChannelsBulkOrderingDialog open={open === 'bulkOrdering'} onOpenChange={(isOpen) => setOpen(isOpen ? 'bulkOrdering' : null)} />

      {currentRow && (
        <>
          <ChannelsActionDialog
            key={`channel-edit-${currentRow.id}`}
            onOpenModelMapping={() => setOpen('modelMapping')}
            open={open === 'edit'}
            onOpenChange={(isOpen) => {
              if (isOpen) {
                setOpen('edit');
              } else {
                setOpen(null);
              }
            }}
            currentRow={currentRow}
          />

          <ChannelsActionDialog
            key={`channel-duplicate-${currentRow.id}`}
            open={open === 'duplicate'}
            onOpenChange={(isOpen) => {
              if (isOpen) {
                setOpen('duplicate');
              } else {
                setOpen(null);
              }
            }}
            duplicateFromRow={currentRow}
          />

          <ChannelsActionDialog
            key={`channel-view-models-${currentRow.id}`}
            onOpenModelMapping={() => setOpen('modelMapping')}
            open={open === 'viewModels'}
            onOpenChange={(isOpen) => {
              if (isOpen) {
                setOpen('viewModels');
              } else {
                setOpen(null);
              }
            }}
            currentRow={currentRow}
            showModelsPanel={true}
          />

          <ChannelsDeleteDialog
            key={`channel-delete-${currentRow.id}`}
            open={open === 'delete'}
            onOpenChange={(isOpen) => {
              if (!isOpen) {
                setOpen(null);
              }
            }}
            currentRow={currentRow}
          />

          {/* <ChannelsSettingsDialog
            key={`channel-settings-${currentRow.id}`}
            open={open === 'settings'}
            onOpenChange={() => {
              setOpen('settings')
            }}
            currentRow={currentRow}
          /> */}

          <ChannelsModelMappingDialog
            key={`channel-model-mapping-${currentRow.id}`}
            open={open === 'modelMapping'}
            onOpenChange={(isOpen) => {
              if (isOpen) {
                setOpen('modelMapping');
              } else {
                setOpen(null);
              }
            }}
            currentRow={currentRow}
          />

          <ChannelsModelPriceDialog />

          <ChannelsOverrideDialog
            key={`channel-overrides-${currentRow.id}`}
            open={open === 'overrides'}
            onOpenChange={(isOpen) => {
              if (!isOpen) {
                setOpen(null);
              }
            }}
            currentRow={currentRow}
          />

          <ChannelsProxyDialog
            key={`channel-proxy-${currentRow.id}`}
            open={open === 'proxy'}
            onOpenChange={(isOpen) => {
              if (!isOpen) {
                setOpen(null);
              }
            }}
            currentRow={currentRow}
          />

          <ChannelsStatusDialog
            key={`channel-status-${currentRow.id}`}
            open={open === 'status'}
            onOpenChange={(isOpen) => {
              if (isOpen) {
                setOpen('status');
              } else {
                setOpen(null);
              }
            }}
            currentRow={currentRow}
          />

          <ChannelsArchiveDialog
            key={`channel-archive-${currentRow.id}`}
            open={open === 'archive'}
            onOpenChange={(isOpen) => {
              if (isOpen) {
                setOpen('archive');
              } else {
                setOpen(null);
              }
            }}
            currentRow={currentRow}
          />

          <ChannelsTestDialog
            key={`channel-test-${currentRow.id}`}
            open={open === 'test'}
            onOpenChange={(isOpen: boolean) => {
              if (isOpen) {
                setOpen('test');
              } else {
                setOpen(null);
              }
            }}
            channel={currentRow}
          />

          <ChannelsTestHistoryDrawer
            key={`channel-test-history-${currentRow.id}`}
            open={open === 'testHistory'}
            onOpenChange={(isOpen) => {
              if (isOpen) {
                setOpen('testHistory');
              } else {
                setOpen(null);
              }
            }}
            channel={currentRow}
          />

          <ChannelsErrorResolvedDialog
            key={`channel-error-resolved-${currentRow.id}`}
            open={open === 'errorResolved'}
            onOpenChange={(isOpen) => {
              if (!isOpen) {
                setOpen(null);
              }
            }}
          />

          <ChannelsTransformOptionsDialog
            key={`channel-transform-options-${currentRow.id}`}
            open={open === 'transformOptions'}
            onOpenChange={(isOpen) => {
              if (!isOpen) {
                setOpen(null);
              }
            }}
            currentRow={currentRow}
          />

          <ChannelsRateLimitDialog
            key={`channel-rate-limit-${currentRow.id}`}
            open={open === 'rateLimit'}
            onOpenChange={(isOpen) => {
              if (!isOpen) {
                setOpen(null);
              }
            }}
            currentRow={currentRow}
          />

          <ChannelsEndpointsDialog
            key={`channel-endpoints-${currentRow.id}`}
            open={open === 'endpoints'}
            onOpenChange={(isOpen) => {
              if (!isOpen) {
                setOpen(null);
              }
            }}
            channel={currentRow}
          />

          <ChannelsDisabledAPIKeysDialog
            key={`channel-disabled-api-keys-${currentRow.id}`}
            open={open === 'disabledAPIKeys'}
            onOpenChange={(isOpen) => {
              if (!isOpen) {
                setOpen(null);
              }
            }}
          />

          <ChannelsAvailabilityDialog
            key={`channel-availability-${currentRow.id}`}
            open={open === 'availability'}
            onOpenChange={(isOpen) => {
              if (!isOpen) {
                setOpen(null);
              }
            }}
            currentRow={currentRow}
          />

          <ChannelsAPIKeyManagementDialog
            key={`channel-key-management-${currentRow.id}`}
            currentRow={currentRow}
            open={open === 'keyManagement'}
            onOpenChange={(isOpen) => {
              if (!isOpen) {
                setOpen(null);
              }
            }}
          />
        </>
      )}
    </>
  );
}
