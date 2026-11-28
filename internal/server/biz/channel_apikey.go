package biz

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"

	"entgo.io/ent/dialect"
	"entgo.io/ent/privacy"
	"github.com/samber/lo"

	"github.com/looplj/axonhub/internal/authz"
	"github.com/looplj/axonhub/internal/ent"
	"github.com/looplj/axonhub/internal/ent/channel"
	"github.com/looplj/axonhub/internal/log"
	"github.com/looplj/axonhub/internal/objects"
	"github.com/looplj/axonhub/internal/pkg/xcontext"
	"github.com/looplj/axonhub/internal/pkg/xerrors"
	"github.com/looplj/axonhub/internal/scopes"
)

const (
	allKeysDisabledErrorPrefix = "All API keys disabled"
	manualDisableReason        = "Manually disabled by user"
)

// ErrMustKeepOneEnabledAPIKey is returned when disabling or removing keys leaves no enabled API key in the channel.
var ErrMustKeepOneEnabledAPIKey = xerrors.NewCodedError(xerrors.ErrCodeMustKeepOneEnabledAPIKey, "at least one enabled API key must remain")

// ChannelAPIKeyStateChanges specifies API keys to enable and disable atomically within UpdateChannel.
type ChannelAPIKeyStateChanges struct {
	EnableKeys  []string `json:"enableKeys,omitempty"`
	DisableKeys []string `json:"disableKeys,omitempty"`
}

// HasChanges reports whether at least one key enable or disable operation is requested.
func (c *ChannelAPIKeyStateChanges) HasChanges() bool {
	return c != nil && (len(c.EnableKeys) > 0 || len(c.DisableKeys) > 0)
}

// GetChannelForCredentialTest loads metadata before a forced credential is selected.
// It deliberately avoids constructing an outbound from an all-disabled key set.
func (svc *ChannelService) GetChannelForCredentialTest(ctx context.Context, channelID int) (*Channel, error) {
	entity, err := svc.entFromContext(ctx).Channel.Get(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("channel not found: %w", err)
	}
	return buildChannel(entity, svc.httpClient), nil
}

type serialChannelKeyTransactionKey struct{}

// WithSerialChannelKeyTransaction marks a transaction whose caller already
// serializes operations on its client. Other transactions still use row locks
// or SQLite conditional writes to arbitrate changes to the same channel.
func WithSerialChannelKeyTransaction(ctx context.Context) context.Context {
	return context.WithValue(ctx, serialChannelKeyTransactionKey{}, ent.TxFromContext(ctx))
}

func inSerialChannelKeyTransaction(ctx context.Context) bool {
	tx := ent.TxFromContext(ctx)
	return tx != nil && ctx.Value(serialChannelKeyTransactionKey{}) == tx
}

// Channel credentials belong to the site. A direct user's project grants
// cannot authorize either a key mutation or inspection of its preconditions.
func canWriteChannelKeyState(ctx context.Context) bool {
	if principal, ok := authz.GetPrincipal(ctx); ok && principal.IsUser() {
		return scopes.UserHasScope(ctx, scopes.ScopeWriteChannels)
	}
	return authz.HasScope(ctx, scopes.ScopeWriteChannels)
}

func (svc *ChannelService) updateChannelForKeyOp(
	ctx context.Context,
	op func(ctx context.Context, db *ent.Client, dialectName string) (done bool, afterCommit func(context.Context), err error),
) error {
	if !inSerialChannelKeyTransaction(ctx) {
		svc.apiKeyOpsLock.Lock()
		defer svc.apiKeyOpsLock.Unlock()
	}
	db := svc.entFromContext(ctx)
	dialectName := db.Driver().Dialect()
	if dialectName != dialect.SQLite {
		var after func(context.Context)
		if err := svc.RunInTransaction(ctx, func(txCtx context.Context) error {
			txDB := svc.entFromContext(txCtx)
			_, commitHook, err := op(txCtx, txDB, dialectName)
			if err != nil {
				return err
			}
			after = commitHook
			return nil
		}); err != nil {
			return err
		}
		if after != nil {
			runAfterCommit(ctx, after)
		}
		return nil
	}
	for range maxChannelVersionRetryAttempts {
		done, after, err := op(ctx, db, dialectName)
		if err != nil {
			return err
		}
		if done {
			if after != nil {
				runAfterCommit(ctx, after)
			}
			return nil
		}
	}
	return ErrChannelUpdatedConcurrently
}

func updateChannelOneForKeyOp(db *ent.Client, dialectName string, ch *ent.Channel) *ent.ChannelUpdateOne {
	update := db.Channel.UpdateOneID(ch.ID)
	if dialectName == dialect.SQLite {
		update = update.Where(channel.UpdatedAtEQ(ch.UpdatedAt)).
			SetUpdatedAt(nextSQLiteChannelUpdatedAt(ch.UpdatedAt))
	}
	return update
}

func resolveChannelSaveResult(ctx context.Context, saveErr error, actionDesc string) (bool, error) {
	if saveErr == nil {
		return true, nil
	}
	if isSQLiteBusySnapshotError(saveErr) {
		return false, ErrChannelUpdatedConcurrently
	}
	if ent.IsNotFound(saveErr) {
		if ent.TxFromContext(ctx) != nil {
			return false, ErrChannelUpdatedConcurrently
		}
		return false, nil
	}
	return false, fmt.Errorf("failed to %s: %w", actionDesc, saveErr)
}

// DisableAPIKey 禁用指定 key；若所有 key 都不可用则禁用 channel.
func (svc *ChannelService) DisableAPIKey(
	ctx context.Context,
	channelID int,
	key string,
	errorCode int,
	reason string,
	expiresAt ...*time.Time,
) error {
	if key == "" {
		return fmt.Errorf("api key cannot be empty")
	}

	return svc.updateChannelForKeyOp(ctx, func(opCtx context.Context, db *ent.Client, dialectName string) (bool, func(context.Context), error) {
		// 读取 channel；在支持行锁的方言上用 FOR UPDATE 获取已提交最新状态。
		ch, err := loadChannelForCredentialUpdate(opCtx, db, channelID)
		if err != nil {
			return false, nil, fmt.Errorf("failed to get channel: %w", err)
		}

		// 检查 key 是否在 credentials 中。OAuth 渠道用固定的 OAuthCredentialRef 作为
		// 唯一凭证标识，所以这里按凭证引用而非明文 key 匹配。
		allKeys := ch.Credentials.GetAllCredentialRefs()

		found := slices.Contains(allKeys, key)
		if !found {
			// key 不在 credentials 中，忽略
			return true, nil, nil
		}

		activeDisabledKeys := lo.Filter(ch.DisabledAPIKeys, func(dk objects.DisabledAPIKey, _ int) bool {
			return !dk.IsExpired()
		})

		// An explicit disable request owns the record from now on. An existing
		// quota-owned record is replaced with the requested reason/error/expiry so
		// a manual, plugin or HTTP-error-rule action transfers ownership away from
		// the quota reconciler; any other existing record keeps this call
		// idempotent.
		var existing *objects.DisabledAPIKey

		remainingDisabledKeys := make([]objects.DisabledAPIKey, 0, len(activeDisabledKeys))
		for _, dk := range activeDisabledKeys {
			if dk.Key == key {
				candidate := dk
				existing = &candidate

				continue
			}

			remainingDisabledKeys = append(remainingDisabledKeys, dk)
		}

		if existing != nil && !existing.QuotaDisabled {
			// 已禁用，忽略
			return true, nil, nil
		}

		// 追加到 disabled_api_keys
		disabledKey := objects.DisabledAPIKey{
			Key:        key,
			DisabledAt: time.Now(),
			ErrorCode:  errorCode,
			Reason:     reason,
		}
		if len(expiresAt) > 0 {
			disabledKey.ExpiresAt = expiresAt[0]
		}

		newDisabledKeys := append(remainingDisabledKeys, disabledKey)

		// 计算 enabled 凭证
		enabledKeys := ch.Credentials.GetEnabledCredentialRefs(newDisabledKeys)

		// 更新 channel
		update := updateChannelOneForKeyOp(db, dialectName, ch).
			SetDisabledAPIKeys(newDisabledKeys)

		// 如果没有可用 key 了，禁用整个 channel
		channelDisabled := len(enabledKeys) == 0
		// Taking over the last key of a channel an operator already disabled must not
		// restamp the auto-disable markers: they are what allows a later recovery to
		// enable the channel and report it as enabled. A scheduled disable is owned
		// by its schedule until the stored re-enable expiry, so it is never taken
		// over (doing so would clear the planned downtime).
		autoDisable := channelDisabled &&
			!isScheduledAutoDisabled(ch) &&
			(ch.Status == channel.StatusEnabled || ch.AutoDisabledAt != nil)
		var (
			autoDisabledAt     time.Time
			autoDisabledReason string
		)
		if autoDisable {
			autoDisabledAt = time.Now()
			autoDisabledReason = fmt.Sprintf("%s (last error: %d)", allKeysDisabledErrorPrefix, errorCode)
			update.SetStatus(channel.StatusDisabled)
			update.SetErrorMessage(autoDisabledReason)
			update.SetAutoDisabledAt(autoDisabledAt)
			update.ClearAutoDisableExpiresAt()
		}

		_, saveErr := update.Save(opCtx)
		done, err := resolveChannelSaveResult(opCtx, saveErr, "disable api key")
		if err != nil || !done {
			return done, nil, err
		}

		status := ch.Status
		if channelDisabled {
			status = channel.StatusDisabled
		}
		return true, func(afterCtx context.Context) {
			if autoDisable {
				log.Warn(afterCtx, "Channel disabled because all API keys are disabled",
					log.Int("channel_id", channelID),
					log.String("channel_name", ch.Name),
				)
			}

			log.Info(afterCtx, "API key disabled",
				log.Int("channel_id", channelID),
				log.Int("error_code", errorCode),
			)

			svc.publishCredentialDisabled(afterCtx, ch, key, errorCode, reason, disabledKey.ExpiresAt, status)

			if autoDisable {
				svc.asyncNotifyChannelAutoDisabled(afterCtx, ChannelAutoDisabledEvent{
					ChannelID:       ch.ID,
					ChannelName:     ch.Name,
					ChannelProvider: ch.Type.String(),
					ChannelBaseURL:  ch.BaseURL,
					ChannelStatus:   channel.StatusDisabled.String(),
					StatusCode:      errorCode,
					Reason:          autoDisabledReason,
					OccurredAt:      autoDisabledAt,
				})

				// Synchronously reload the local cache to immediately stop selecting this channel.
				// This matches the behavior of markChannelUnavailable.
				reloadCtx, cancel := xcontext.DetachWithTimeout(afterCtx, 10*time.Second)
				defer cancel()
				_, err := authz.RunAsHost(reloadCtx, svc.db, "channel-cache-reload", func(hostCtx context.Context) (struct{}, error) {
					return struct{}{}, svc.enabledChannelsCache.Load(hostCtx, true)
				})
				if err != nil {
					log.Warn(afterCtx, "Failed to synchronously reload channels after API key exhaustion",
						log.Int("channel_id", channelID),
						log.Cause(err),
					)
				}
			}

			// Also notify other instances via the watcher for cross-instance cache invalidation.
			svc.asyncReloadChannels()
		}, nil
	})
}

// EnableAPIKey 重新启用指定 key（从 disabled_api_keys 中移除）.
func (svc *ChannelService) EnableAPIKey(ctx context.Context, channelID int, key string) error {
	return svc.updateChannelForKeyOp(ctx, func(opCtx context.Context, db *ent.Client, dialectName string) (bool, func(context.Context), error) {
		ch, err := loadChannelForCredentialUpdate(opCtx, db, channelID)
		if err != nil {
			return false, nil, fmt.Errorf("failed to get channel: %w", err)
		}

		if len(ch.DisabledAPIKeys) == 0 {
			// 没有禁用的 key，忽略
			return true, nil, nil
		}

		// 从 disabled_api_keys 中移除指定 key
		newDisabledKeys := make([]objects.DisabledAPIKey, 0, len(ch.DisabledAPIKeys))
		found := false

		for _, dk := range ch.DisabledAPIKeys {
			if dk.Key == key {
				found = true
				continue
			}

			newDisabledKeys = append(newDisabledKeys, dk)
		}

		if !found {
			// key 不在禁用列表中，忽略
			return true, nil, nil
		}

		update := updateChannelOneForKeyOp(db, dialectName, ch).
			SetDisabledAPIKeys(newDisabledKeys)
		update = applyRecoveredChannelStatus(opCtx, update, ch, ch.Credentials, newDisabledKeys)

		_, saveErr := update.Save(opCtx)
		done, err := resolveChannelSaveResult(opCtx, saveErr, "enable api key")
		if err != nil || !done {
			return done, nil, err
		}

		return true, func(afterCtx context.Context) {
			svc.publishCredentialEnabled(afterCtx, ch, []string{key}, newDisabledKeys, credentialTriggerManual)
			svc.asyncReloadChannels()
		}, nil
	})
}

// EnableAllAPIKeys 清空 disabled_api_keys.
func (svc *ChannelService) EnableAllAPIKeys(ctx context.Context, channelID int) error {
	return svc.updateChannelForKeyOp(ctx, func(opCtx context.Context, db *ent.Client, dialectName string) (bool, func(context.Context), error) {
		ch, err := loadChannelForCredentialUpdate(opCtx, db, channelID)
		if err != nil {
			return false, nil, fmt.Errorf("failed to get channel: %w", err)
		}

		if len(ch.DisabledAPIKeys) == 0 {
			// 没有禁用的 key，忽略
			return true, nil, nil
		}

		// 更新 channel，清空 disabled_api_keys
		update := updateChannelOneForKeyOp(db, dialectName, ch).
			SetDisabledAPIKeys([]objects.DisabledAPIKey{})
		update = applyRecoveredChannelStatus(opCtx, update, ch, ch.Credentials, nil)

		_, saveErr := update.Save(opCtx)
		done, err := resolveChannelSaveResult(opCtx, saveErr, "enable all api keys")
		if err != nil || !done {
			return done, nil, err
		}

		return true, func(afterCtx context.Context) {
			log.Info(afterCtx, "All API keys enabled",
				log.Int("channel_id", channelID),
			)

			svc.publishCredentialEnabled(afterCtx, ch, disabledKeyValues(ch.DisabledAPIKeys), nil, credentialTriggerManual)
			svc.asyncReloadChannels()
		}, nil
	})
}

// EnableSelectedAPIKeys re-enables multiple specific keys from disabled_api_keys.
func (svc *ChannelService) EnableSelectedAPIKeys(ctx context.Context, channelID int, keys []string) error {
	if len(keys) == 0 {
		return nil
	}

	return svc.updateChannelForKeyOp(ctx, func(opCtx context.Context, db *ent.Client, dialectName string) (bool, func(context.Context), error) {
		ch, err := loadChannelForCredentialUpdate(opCtx, db, channelID)
		if err != nil {
			return false, nil, fmt.Errorf("failed to get channel: %w", err)
		}

		if len(ch.DisabledAPIKeys) == 0 {
			return true, nil, nil
		}

		keysToEnable := make(map[string]struct{}, len(keys))
		for _, k := range keys {
			keysToEnable[k] = struct{}{}
		}

		newDisabledKeys := make([]objects.DisabledAPIKey, 0, len(ch.DisabledAPIKeys))
		enabledKeys := make([]string, 0, len(keys))
		for _, dk := range ch.DisabledAPIKeys {
			if _, found := keysToEnable[dk.Key]; !found {
				newDisabledKeys = append(newDisabledKeys, dk)
				continue
			}
			enabledKeys = append(enabledKeys, dk.Key)
		}

		if len(newDisabledKeys) == len(ch.DisabledAPIKeys) {
			return true, nil, nil
		}

		update := updateChannelOneForKeyOp(db, dialectName, ch).
			SetDisabledAPIKeys(newDisabledKeys)
		update = applyRecoveredChannelStatus(opCtx, update, ch, ch.Credentials, newDisabledKeys)

		_, saveErr := update.Save(opCtx)
		done, err := resolveChannelSaveResult(opCtx, saveErr, "enable selected api keys")
		if err != nil || !done {
			return done, nil, err
		}

		return true, func(afterCtx context.Context) {
			log.Info(afterCtx, "Selected API keys enabled",
				log.Int("channel_id", channelID),
				log.Int("count", len(keys)),
			)

			svc.publishCredentialEnabled(afterCtx, ch, enabledKeys, newDisabledKeys, credentialTriggerManual)
			svc.asyncReloadChannels()
		}, nil
	})
}

// DeleteDisabledAPIKeysResult is the result of deleting disabled API keys.
type DeleteDisabledAPIKeysResult struct {
	Success bool
	Message string
}

// DeleteDisabledAPIKeys removes disabled API keys from both disabled_api_keys list and credentials.
// It ensures at least one API key remains and prevents deletion for OAuth channels.
func (svc *ChannelService) DeleteDisabledAPIKeys(ctx context.Context, channelID int, keys []string) (*DeleteDisabledAPIKeysResult, error) {
	if len(keys) == 0 {
		return &DeleteDisabledAPIKeysResult{Success: true}, nil
	}

	var result *DeleteDisabledAPIKeysResult
	err := svc.updateChannelForKeyOp(ctx, func(opCtx context.Context, db *ent.Client, dialectName string) (bool, func(context.Context), error) {
		ch, err := loadChannelForCredentialUpdate(opCtx, db, channelID)
		if err != nil {
			return false, nil, fmt.Errorf("failed to get channel: %w", err)
		}

		// Check if channel uses OAuth - cannot delete keys for OAuth channels
		if ch.Credentials.IsOAuth() {
			return false, nil, fmt.Errorf("cannot delete API keys for OAuth channels")
		}

		keysToDelete := make(map[string]struct{}, len(keys))
		for _, k := range keys {
			keysToDelete[k] = struct{}{}
		}

		// Remove from disabled_api_keys
		newDisabledKeys := make([]objects.DisabledAPIKey, 0, len(ch.DisabledAPIKeys))
		for _, dk := range ch.DisabledAPIKeys {
			if _, found := keysToDelete[dk.Key]; !found {
				newDisabledKeys = append(newDisabledKeys, dk)
			}
		}

		// Remove from credentials
		attemptResult := &DeleteDisabledAPIKeysResult{Success: true}
		allRefs := ch.Credentials.GetAllCredentialRefs()
		if len(allRefs) > 0 && lo.EveryBy(allRefs, func(ref string) bool {
			_, found := keysToDelete[ref]
			return found
		}) {
			delete(keysToDelete, allRefs[0])
			attemptResult.Message = "ONE_KEY_PRESERVED"
		}
		newCredentials := ch.Credentials
		if len(newCredentials.APIKeys) > 0 {
			filteredKeys := make([]string, 0, len(newCredentials.APIKeys))
			for _, k := range newCredentials.APIKeys {
				if _, found := keysToDelete[k]; !found {
					filteredKeys = append(filteredKeys, k)
				}
			}

			newCredentials.APIKeys = filteredKeys
		}

		if newCredentials.APIKey != "" {
			if _, found := keysToDelete[newCredentials.APIKey]; found {
				newCredentials.APIKey = ""
			}
		}

		// Vertex keys are stored as project-bound triples and also surface through
		// GetAllAPIKeys. Leaving the triple behind would keep the key selectable while
		// its disable record is gone, so the channel would immediately route through the
		// credential that was just deleted.
		if len(newCredentials.VertexAPIKeys) > 0 {
			keptVertices := make([]objects.VertexAPIKey, 0, len(newCredentials.VertexAPIKeys))
			for _, credential := range newCredentials.VertexAPIKeys {
				if _, found := keysToDelete[credential.APIKey]; found {
					continue
				}
				keptVertices = append(keptVertices, credential)
			}

			newCredentials.VertexAPIKeys = keptVertices
		}

		newCredentials.VertexServiceAccounts = lo.Filter(newCredentials.VertexServiceAccounts, func(credential objects.GCPCredential, _ int) bool {
			_, found := keysToDelete[credential.CredentialRef()]
			return !found
		})
		if len(newCredentials.APIKeyNames) > 0 {
			newCredentials.PruneAPIKeyNames(newCredentials.GetFlatAPIKeys())
		}

		update := updateChannelOneForKeyOp(db, dialectName, ch).
			SetDisabledAPIKeys(newDisabledKeys).
			SetCredentials(newCredentials)
		update = applyRecoveredChannelStatus(opCtx, update, ch, newCredentials, newDisabledKeys)

		_, saveErr := update.Save(opCtx)
		done, err := resolveChannelSaveResult(opCtx, saveErr, "delete disabled api keys")
		if err != nil || !done {
			return done, nil, err
		}

		result = attemptResult
		return true, func(afterCtx context.Context) {
			log.Info(afterCtx, "Disabled API keys deleted",
				log.Int("channel_id", channelID),
				log.Int("count", len(keys)),
			)

			svc.asyncReloadChannels()
		}, nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func applyRecoveredChannelStatus(
	ctx context.Context,
	update *ent.ChannelUpdateOne,
	ch *ent.Channel,
	credentials objects.ChannelCredentials,
	disabledKeys []objects.DisabledAPIKey,
) *ent.ChannelUpdateOne {
	// AutoDisabledAt is the marker of this package's own all-keys auto-disable;
	// a manual channel disable clears it and must survive a credential recovery.
	if !channelIsAllKeysDisabled(ch) ||
		len(credentials.GetEnabledCredentialRefs(disabledKeys)) == 0 {
		return update
	}

	log.Info(ctx, "Re-enabled channel after API key availability recovered",
		log.Int("channel_id", ch.ID),
		log.String("channel_name", ch.Name),
	)

	return update.SetStatus(channel.StatusEnabled).ClearErrorMessage().ClearAutoDisabledAt().ClearAutoDisableExpiresAt()
}

// cleanupExpiredDisabledAPIKeys prunes elapsed temporary disables and restores
// channels that were disabled only because all of their keys were unavailable.
func (svc *ChannelService) cleanupExpiredDisabledAPIKeys(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	ctx = authz.WithSystemBypass(ctx, "channel-cleanup-expired-disabled-api-keys")

	channelIDs, err := svc.entFromContext(ctx).Channel.Query().
		Where(channel.StatusIn(channel.StatusEnabled, channel.StatusDisabled)).
		IDs(ctx)
	if err != nil {
		log.Error(ctx, "Failed to query channels for expired API key cleanup", log.Cause(err))
		return
	}

	needsReload := false
	for _, channelID := range channelIDs {
		cleaned, removed, err := svc.cleanupChannelExpiredDisabledAPIKeys(ctx, channelID)
		if err != nil {
			log.Error(ctx, "Failed to cleanup expired disabled API keys",
				log.Int("channel_id", channelID),
				log.Cause(err),
			)
			continue
		}
		if !cleaned {
			continue
		}

		log.Info(ctx, "Cleaned up expired disabled API keys",
			log.Int("channel_id", channelID),
			log.Int("removed", removed),
		)
		needsReload = true
	}

	if svc.cleanupExpiredAutoDisabledChannels(ctx) {
		needsReload = true
	}

	if needsReload {
		svc.asyncReloadChannels()
	}
}

func (svc *ChannelService) cleanupExpiredAutoDisabledChannels(ctx context.Context) bool {
	now := time.Now()
	channelIDs, err := svc.entFromContext(ctx).Channel.Query().
		Where(
			channel.StatusEQ(channel.StatusDisabled),
			channel.AutoDisabledAtNotNil(),
			channel.AutoDisableExpiresAtNotNil(),
			channel.AutoDisableExpiresAtLTE(now),
		).
		IDs(ctx)
	if err != nil {
		log.Error(ctx, "Failed to query expired auto-disabled channels", log.Cause(err))
		return false
	}
	if len(channelIDs) == 0 {
		return false
	}

	recovered := false
	for _, channelID := range channelIDs {
		affected, err := svc.entFromContext(ctx).Channel.Update().
			Where(
				channel.ID(channelID),
				channel.StatusEQ(channel.StatusDisabled),
				channel.AutoDisabledAtNotNil(),
				channel.AutoDisableExpiresAtNotNil(),
				channel.AutoDisableExpiresAtLTE(now),
			).
			SetStatus(channel.StatusEnabled).
			ClearErrorMessage().
			ClearAutoDisabledAt().
			ClearAutoDisableExpiresAt().
			Save(ctx)
		if err != nil {
			log.Error(ctx, "Failed to recover expired auto-disabled channel",
				log.Int("channel_id", channelID),
				log.Cause(err),
			)
			continue
		}
		if affected == 0 {
			continue
		}

		log.Info(ctx, "Recovered channel after auto-disable expiry",
			log.Int("channel_id", channelID),
		)
		recovered = true
		svc.publishChannelAutoEnabled(ctx, channelID)
	}

	return recovered
}

func (svc *ChannelService) cleanupChannelExpiredDisabledAPIKeys(ctx context.Context, channelID int) (bool, int, error) {
	var (
		cleaned bool
		removed int
	)
	err := svc.updateChannelForKeyOp(ctx, func(opCtx context.Context, db *ent.Client, dialectName string) (bool, func(context.Context), error) {
		ch, err := loadChannelForCredentialUpdate(opCtx, db, channelID)
		if err != nil {
			return false, nil, fmt.Errorf("failed to get channel: %w", err)
		}

		expired := make([]objects.DisabledAPIKey, 0)
		active := make([]objects.DisabledAPIKey, 0, len(ch.DisabledAPIKeys))
		for _, dk := range ch.DisabledAPIKeys {
			if dk.IsExpired() {
				expired = append(expired, dk)
				continue
			}
			active = append(active, dk)
		}
		removedCount := len(expired)
		if removedCount == 0 {
			cleaned = false
			removed = 0
			return true, nil, nil
		}

		update := updateChannelOneForKeyOp(db, dialectName, ch).
			SetDisabledAPIKeys(active)
		update = applyRecoveredChannelStatus(opCtx, update, ch, ch.Credentials, active)
		_, saveErr := update.Save(opCtx)
		done, err := resolveChannelSaveResult(opCtx, saveErr, "update channel")
		if err != nil || !done {
			return done, nil, err
		}

		cleaned = true
		removed = removedCount
		return true, func(afterCtx context.Context) {
			svc.publishCredentialEnabled(afterCtx, ch, disabledKeyValues(expired), active, credentialTriggerExpired)
		}, nil
	})
	if err != nil {
		return false, 0, err
	}
	return cleaned, removed, nil
}

func channelSupportsAPIKeyNames(channelType channel.Type, creds objects.ChannelCredentials) bool {
	return channelType != channel.TypeAntigravity && channelType != channel.TypeGeminiVertex && !creds.IsOAuth()
}

type apiKeyStateApplyResult struct {
	disabledKeys    []objects.DisabledAPIKey
	enabledKeys     []string
	disabledApplied []objects.DisabledAPIKey
	changed         bool
}

func deduplicateNonEmptyKeys(keys []string) []string {
	if len(keys) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(keys))
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		if strings.TrimSpace(key) == "" {
			continue
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, key)
	}
	return result
}

func applyChannelAPIKeyStateChanges(
	updatedCreds objects.ChannelCredentials,
	existingDisabled []objects.DisabledAPIKey,
	changes *ChannelAPIKeyStateChanges,
	pruneOrphans bool,
	now time.Time,
) (*apiKeyStateApplyResult, error) {
	enableKeys := []string(nil)
	disableKeys := []string(nil)
	if changes != nil {
		enableKeys = deduplicateNonEmptyKeys(changes.EnableKeys)
		disableKeys = deduplicateNonEmptyKeys(changes.DisableKeys)
	}

	enableSet := make(map[string]struct{}, len(enableKeys))
	for _, k := range enableKeys {
		enableSet[k] = struct{}{}
	}

	validRefs := updatedCreds.GetAllCredentialRefs()
	validRefSet := make(map[string]struct{}, len(validRefs))
	for _, ref := range validRefs {
		if strings.TrimSpace(ref) != "" {
			validRefSet[ref] = struct{}{}
		}
	}

	result := make([]objects.DisabledAPIKey, 0, len(existingDisabled))
	existingByKey := make(map[string]int, len(existingDisabled))
	enabledApplied := make([]string, 0, len(enableKeys))
	changed := false

	for _, dk := range existingDisabled {
		if pruneOrphans {
			if _, valid := validRefSet[dk.Key]; !valid {
				changed = true
				continue
			}
		}
		if dk.IsExpired() {
			continue
		}
		if _, shouldEnable := enableSet[dk.Key]; shouldEnable {
			enabledApplied = append(enabledApplied, dk.Key)
			changed = true
			continue
		}
		existingByKey[dk.Key] = len(result)
		result = append(result, dk)
	}

	disabledApplied := make([]objects.DisabledAPIKey, 0, len(disableKeys))
	for _, key := range disableKeys {
		if _, valid := validRefSet[key]; !valid {
			continue
		}
		manualEntry := objects.DisabledAPIKey{
			Key:        key,
			DisabledAt: now,
			Reason:     manualDisableReason,
		}
		if idx, exists := existingByKey[key]; exists {
			existing := result[idx]
			if !existing.QuotaDisabled {
				// Already actively disabled (non-quota); idempotent skip.
				continue
			}
			result[idx] = manualEntry
			disabledApplied = append(disabledApplied, manualEntry)
			changed = true
			continue
		}
		existingByKey[key] = len(result)
		result = append(result, manualEntry)
		disabledApplied = append(disabledApplied, manualEntry)
		changed = true
	}

	if len(disabledApplied) > 0 && len(validRefSet) > 0 {
		enabledCount := 0
		for ref := range validRefSet {
			if _, disabled := existingByKey[ref]; !disabled {
				enabledCount++
			}
		}
		if enabledCount == 0 {
			return nil, ErrMustKeepOneEnabledAPIKey
		}
	}

	return &apiKeyStateApplyResult{
		disabledKeys:    result,
		enabledKeys:     enabledApplied,
		disabledApplied: disabledApplied,
		changed:         changed,
	}, nil
}

// DisableSelectedAPIKeys manually disables the specified API keys of a channel.
func (svc *ChannelService) DisableSelectedAPIKeys(ctx context.Context, channelID int, keys []string) error {
	if !canWriteChannelKeyState(ctx) {
		return privacy.Deny
	}
	if len(keys) == 0 {
		return nil
	}

	// Independent transactions compete in the database. For an externally
	// shared client, avoid racing another operation on that same transaction,
	// but never wait for a process lock while holding a database connection.
	if ent.TxFromContext(ctx) != nil && !inSerialChannelKeyTransaction(ctx) {
		if !svc.apiKeyOpsLock.TryLock() {
			return ErrChannelUpdatedConcurrently
		}
		defer svc.apiKeyOpsLock.Unlock()
	}
	return svc.RunInTransaction(ctx, func(txCtx context.Context) error {
		ch, err := authz.RunWithScopeDecision(txCtx, scopes.ScopeWriteChannels, func(queryCtx context.Context) (*ent.Channel, error) {
			return loadChannelForCredentialUpdate(queryCtx, svc.entFromContext(queryCtx), channelID)
		})
		if err != nil {
			return fmt.Errorf("failed to get channel: %w", err)
		}

		applied, err := applyChannelAPIKeyStateChanges(
			ch.Credentials,
			ch.DisabledAPIKeys,
			&ChannelAPIKeyStateChanges{DisableKeys: keys},
			false,
			time.Now(),
		)
		if err != nil {
			return err
		}
		if !applied.changed || len(applied.disabledApplied) == 0 {
			return nil
		}

		txDB := svc.entFromContext(txCtx)
		update := txDB.Channel.Update().
			Where(channel.IDEQ(channelID)).
			SetDisabledAPIKeys(applied.disabledKeys)
		if txDB.Driver().Dialect() == dialect.SQLite {
			update = update.
				Where(channel.UpdatedAtEQ(ch.UpdatedAt)).
				SetUpdatedAt(nextSQLiteChannelUpdatedAt(ch.UpdatedAt))
		}
		affected, err := update.Save(txCtx)
		if err != nil {
			if isSQLiteBusySnapshotError(err) {
				return ErrChannelUpdatedConcurrently
			}
			return fmt.Errorf("failed to disable selected api keys: %w", err)
		}
		if affected == 0 {
			return ErrChannelUpdatedConcurrently
		}

		disabledSnapshot := applied.disabledApplied
		chSnapshot := ch
		status := ch.Status
		runAfterCommit(txCtx, func(afterCtx context.Context) {
			for _, dk := range disabledSnapshot {
				svc.publishCredentialDisabled(afterCtx, chSnapshot, dk.Key, dk.ErrorCode, dk.Reason, dk.ExpiresAt, status)
			}
		})
		svc.reloadChannelsAfterCommit(txCtx)

		return nil
	})
}
