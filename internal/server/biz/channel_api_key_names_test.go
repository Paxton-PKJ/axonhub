// 职责: 验证渠道 API 密钥名称写入规范化、UpdateChannel 原子启禁用事务、DisableSelectedAPIKeys 与请求指纹落库逻辑。
// 关联文件:
//   internal/server/biz/channel.go
//   internal/server/biz/channel_apikey.go
//   internal/server/biz/request.go
//   internal/objects/channel.go
// 遵循的 Rules:
//   .agents/rules/go-general.md
//   .agents/rules/biz-services.md
// 注意事项:
//   涉及事务回滚、事件总线发布与密码学指纹断言，均使用隔离的内存 SQLite 数据库。

package biz

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	"entgo.io/ent/privacy"
	"github.com/go-sql-driver/mysql"
	"github.com/samber/lo"
	"github.com/stretchr/testify/require"

	"github.com/looplj/axonhub/internal/authz"
	"github.com/looplj/axonhub/internal/contexts"
	"github.com/looplj/axonhub/internal/ent"
	"github.com/looplj/axonhub/internal/ent/channel"
	"github.com/looplj/axonhub/internal/ent/enttest"
	"github.com/looplj/axonhub/internal/ent/migrate"
	entrequest "github.com/looplj/axonhub/internal/ent/request"
	"github.com/looplj/axonhub/internal/objects"
	"github.com/looplj/axonhub/internal/pkg/xerrors"
	"github.com/looplj/axonhub/internal/scopes"
	"github.com/looplj/axonhub/internal/server/events"
	"github.com/looplj/axonhub/llm"
	"github.com/looplj/axonhub/llm/httpclient"
)

func setupChannelNamesBizTest(t *testing.T) (*ChannelService, *ent.Client, context.Context) {
	t.Helper()
	client := enttest.NewEntClient(t, "sqlite3", channelEventDSN(t))
	t.Cleanup(func() { require.NoError(t, client.Close()) })
	ctx := authz.WithTestBypass(ent.NewContext(context.Background(), client))
	svc := NewChannelServiceForTest(client)
	return svc, client, ctx
}

func TestChannelService_APIKeyNames_CreateDuplicateUpdateAndDelete(t *testing.T) {
	svc, client, ctx := setupChannelNamesBizTest(t)

	// 1. CreateChannel normalizes names and drops orphans/blanks.
	created, err := svc.CreateChannel(ctx, ent.CreateChannelInput{
		Type:    channel.TypeOpenai,
		Name:    "create-names-ch",
		BaseURL: lo.ToPtr("https://api.openai.com/v1"),
		Credentials: objects.ChannelCredentials{
			APIKeys: []string{"sk-k1-1111", "sk-k2-2222"},
			APIKeyNames: []objects.APIKeyName{
				{Key: "sk-k1-1111", Name: "  prod-one  "},
				{Key: "sk-orphan", Name: "drop-me"},
				{Key: "sk-k2-2222", Name: "  "},
			},
		},
		SupportedModels:  []string{"gpt-4o"},
		DefaultTestModel: "gpt-4o",
	})
	require.NoError(t, err)
	require.Equal(t, []objects.APIKeyName{{Key: "sk-k1-1111", Name: "prod-one"}}, created.Credentials.APIKeyNames)

	// 2. Unicode >64 char rejection on CreateChannel.
	_, err = svc.CreateChannel(ctx, ent.CreateChannelInput{
		Type:    channel.TypeOpenai,
		Name:    "create-too-long",
		BaseURL: lo.ToPtr("https://api.openai.com/v1"),
		Credentials: objects.ChannelCredentials{
			APIKeys:     []string{"sk-k1-1111"},
			APIKeyNames: []objects.APIKeyName{{Key: "sk-k1-1111", Name: strings.Repeat("字", objects.MaxAPIKeyNameLength+1)}},
		},
		SupportedModels:  []string{"gpt-4o"},
		DefaultTestModel: "gpt-4o",
	})
	require.Error(t, err)

	// 3. OAuth channel strips APIKeyNames on create.
	oauthCh, err := svc.CreateChannel(ctx, ent.CreateChannelInput{
		Type:    channel.TypeCodex,
		Name:    "oauth-no-names",
		BaseURL: lo.ToPtr("https://chatgpt.com/backend-api/codex#"),
		Credentials: objects.ChannelCredentials{
			OAuth:       &objects.OAuthCredentials{AccessToken: "tok", RefreshToken: "ref"},
			APIKeyNames: []objects.APIKeyName{{Key: objects.OAuthCredentialRef, Name: "nope"}},
		},
		SupportedModels:  []string{"gpt-5"},
		DefaultTestModel: "gpt-5",
	})
	require.NoError(t, err)
	require.Nil(t, oauthCh.Credentials.APIKeyNames)

	// 4. DuplicateChannel normalizes names too.
	dup, err := svc.DuplicateChannel(ctx, created.ID, ent.CreateChannelInput{
		Type:    channel.TypeOpenai,
		Name:    "dup-names-ch",
		BaseURL: lo.ToPtr("https://api.openai.com/v1"),
		Credentials: objects.ChannelCredentials{
			APIKeys:     []string{"sk-k1-1111", "sk-k3-3333"},
			APIKeyNames: []objects.APIKeyName{{Key: "sk-k1-1111", Name: "  dup-prod  "}, {Key: "sk-missing", Name: "stale"}},
		},
		SupportedModels:  []string{"gpt-4o"},
		DefaultTestModel: "gpt-4o",
	})
	require.NoError(t, err)
	require.Equal(t, []objects.APIKeyName{{Key: "sk-k1-1111", Name: "dup-prod"}}, dup.Credentials.APIKeyNames)

	// 5. UpdateChannel: omitted APIKeyNames (nil) preserves existing names.
	updatedKeep, err := svc.UpdateChannel(ctx, created.ID, &ent.UpdateChannelInput{
		Credentials: &objects.ChannelCredentials{
			APIKeys:     []string{"sk-k1-1111", "sk-k2-2222"},
			APIKeyNames: nil,
		},
	})
	require.NoError(t, err)
	require.Equal(t, []objects.APIKeyName{{Key: "sk-k1-1111", Name: "prod-one"}}, updatedKeep.Credentials.APIKeyNames)

	// 6. UpdateChannel: explicit empty non-nil slice clears all stored names.
	updatedClear, err := svc.UpdateChannel(ctx, created.ID, &ent.UpdateChannelInput{
		Credentials: &objects.ChannelCredentials{
			APIKeys:     []string{"sk-k1-1111", "sk-k2-2222"},
			APIKeyNames: []objects.APIKeyName{},
		},
	})
	require.NoError(t, err)
	require.Nil(t, updatedClear.Credentials.APIKeyNames)

	// 7. DeleteDisabledAPIKeys prunes deleted key's name AND ONE_KEY_PRESERVED keeps preserved key's name.
	chDel, err := client.Channel.Create().
		SetType(channel.TypeOpenai).
		SetName("delete-prune-names").
		SetBaseURL("https://api.openai.com/v1").
		SetCredentials(objects.ChannelCredentials{
			APIKeys: []string{"sk-keep", "sk-drop"},
			APIKeyNames: []objects.APIKeyName{
				{Key: "sk-keep", Name: "survivor"},
				{Key: "sk-drop", Name: "doomed"},
			},
		}).
		SetDisabledAPIKeys([]objects.DisabledAPIKey{
			{Key: "sk-keep", ErrorCode: 401, Reason: "err"},
			{Key: "sk-drop", ErrorCode: 401, Reason: "err"},
		}).
		SetSupportedModels([]string{"gpt-4o"}).
		SetDefaultTestModel("gpt-4o").
		Save(ctx)
	require.NoError(t, err)

	res, err := svc.DeleteDisabledAPIKeys(ctx, chDel.ID, []string{"sk-drop"})
	require.NoError(t, err)
	require.True(t, res.Success)
	reloaded := reloadChannel(t, ctx, client, chDel.ID)
	require.Equal(t, []objects.APIKeyName{{Key: "sk-keep", Name: "survivor"}}, reloaded.Credentials.APIKeyNames)

	// Trying to delete the last remaining disabled key preserves BOTH the key and its name.
	resLast, err := svc.DeleteDisabledAPIKeys(ctx, chDel.ID, []string{"sk-keep"})
	require.NoError(t, err)
	require.Equal(t, "ONE_KEY_PRESERVED", resLast.Message)
	reloadedLast := reloadChannel(t, ctx, client, chDel.ID)
	require.Equal(t, []string{"sk-keep"}, reloadedLast.Credentials.APIKeys)
	require.Equal(t, []objects.APIKeyName{{Key: "sk-keep", Name: "survivor"}}, reloadedLast.Credentials.APIKeyNames)
}

func TestChannelService_UpdateChannel_AtomicAPIKeyStateChangesAndRollback(t *testing.T) {
	svc, client, ctx := setupChannelNamesBizTest(t)
	bus := events.NewBus()
	t.Cleanup(func() { require.NoError(t, bus.Close(context.Background())) })
	svc.EventBus = bus
	enabledCh := subscribeEvent(t, bus, events.TypeChannelCredentialEnabled)
	disabledCh := subscribeEvent(t, bus, events.TypeChannelCredentialDisabled)

	ch, err := client.Channel.Create().
		SetType(channel.TypeOpenai).
		SetName("atomic-update-ch").
		SetBaseURL("https://api.openai.com/v1").
		SetCredentials(objects.ChannelCredentials{
			APIKeys: []string{"sk-a-1111", "sk-b-2222", "sk-c-3333"},
			APIKeyNames: []objects.APIKeyName{
				{Key: "sk-a-1111", Name: "A"},
				{Key: "sk-c-3333", Name: "C"},
			},
		}).
		SetDisabledAPIKeys([]objects.DisabledAPIKey{
			{Key: "sk-b-2222", ErrorCode: 401, Reason: "err"},
			{Key: "sk-c-3333", ErrorCode: 429, Reason: "quota"},
		}).
		SetSupportedModels([]string{"gpt-4o"}).
		SetDefaultTestModel("gpt-4o").
		Save(ctx)
	require.NoError(t, err)

	// Attempt to rename AND delete C AND disable A while keeping B disabled -> fails and rolls back everything!
	_, err = svc.UpdateChannel(ctx, ch.ID, &ent.UpdateChannelInput{
		Credentials: &objects.ChannelCredentials{
			APIKeys:     []string{"sk-a-1111", "sk-b-2222"},
			APIKeyNames: []objects.APIKeyName{{Key: "sk-a-1111", Name: "should-rollback"}},
		},
	}, &ChannelAPIKeyStateChanges{
		DisableKeys: []string{"sk-a-1111"},
	})
	require.ErrorIs(t, err, ErrMustKeepOneEnabledAPIKey)

	afterRollback := reloadChannel(t, ctx, client, ch.ID)
	require.Equal(t, []string{"sk-a-1111", "sk-b-2222", "sk-c-3333"}, afterRollback.Credentials.APIKeys)
	require.Equal(t, "A", afterRollback.Credentials.NameOf("sk-a-1111"))
	require.Len(t, afterRollback.DisabledAPIKeys, 2)

	// Overlapping enable and disable applies enable first, then disable on the same key.
	overlapUpdated, err := svc.UpdateChannel(ctx, ch.ID, &ent.UpdateChannelInput{}, &ChannelAPIKeyStateChanges{
		EnableKeys:  []string{"sk-b-2222"},
		DisableKeys: []string{"sk-b-2222"},
	})
	require.NoError(t, err)
	overlapByKey := make(map[string]objects.DisabledAPIKey, len(overlapUpdated.DisabledAPIKeys))
	for _, dk := range overlapUpdated.DisabledAPIKeys {
		overlapByKey[dk.Key] = dk
	}
	require.Equal(t, manualDisableReason, overlapByKey["sk-b-2222"].Reason)
	require.Zero(t, overlapByKey["sk-b-2222"].ErrorCode)
	require.Equal(t, events.TypeChannelCredentialEnabled, requireEvent(t, enabledCh).Type)
	require.Equal(t, events.TypeChannelCredentialDisabled, requireEvent(t, disabledCh).Type)

	// Atomic valid update: delete C (orphan disabled record pruned automatically), rename channel & keys, enable B, disable A.
	updated, err := svc.UpdateChannel(ctx, ch.ID, &ent.UpdateChannelInput{
		Name: lo.ToPtr("atomic-renamed"),
		Credentials: &objects.ChannelCredentials{
			APIKeys: []string{"sk-a-1111", "sk-b-2222"},
			APIKeyNames: []objects.APIKeyName{
				{Key: "sk-a-1111", Name: "A2"},
				{Key: "sk-b-2222", Name: "B2"},
			},
		},
	}, &ChannelAPIKeyStateChanges{
		EnableKeys:  []string{"sk-b-2222"},
		DisableKeys: []string{"sk-a-1111"},
	})
	require.NoError(t, err)
	require.Equal(t, "A2", updated.Credentials.NameOf("sk-a-1111"))
	require.Equal(t, "B2", updated.Credentials.NameOf("sk-b-2222"))
	require.Len(t, updated.DisabledAPIKeys, 1)
	require.Equal(t, "sk-a-1111", updated.DisabledAPIKeys[0].Key)
	require.Equal(t, manualDisableReason, updated.DisabledAPIKeys[0].Reason)

	enEv := requireEvent(t, enabledCh)
	require.Equal(t, events.TypeChannelCredentialEnabled, enEv.Type)
	require.NotNil(t, enEv.Subject.Channel)
	require.Equal(t, "atomic-renamed", enEv.Subject.Channel.Name)
	disEv := requireEvent(t, disabledCh)
	require.Equal(t, events.TypeChannelCredentialDisabled, disEv.Type)
	require.NotNil(t, disEv.Subject.Channel)
	require.Equal(t, "atomic-renamed", disEv.Subject.Channel.Name)

	// State changes without Credentials work directly on existing keys.
	updated2, err := svc.UpdateChannel(ctx, ch.ID, &ent.UpdateChannelInput{}, &ChannelAPIKeyStateChanges{
		EnableKeys: []string{"sk-a-1111"},
	})
	require.NoError(t, err)
	require.Empty(t, updated2.DisabledAPIKeys)

	// Deleting a key whose DisabledAPIKeys record is already expired still prunes the orphan record.
	expiredOrphanAt := time.Now().Add(-time.Minute)
	chExpOrphan, err := client.Channel.Create().
		SetType(channel.TypeOpenai).
		SetName("expired-orphan-ch").
		SetBaseURL("https://api.openai.com/v1").
		SetStatus(channel.StatusEnabled).
		SetCredentials(objects.ChannelCredentials{
			APIKeys: []string{"sk-keep-1111", "sk-expired-orphan-2222"},
		}).
		SetDisabledAPIKeys([]objects.DisabledAPIKey{
			{Key: "sk-expired-orphan-2222", ErrorCode: 429, Reason: "expired temp", ExpiresAt: &expiredOrphanAt},
		}).
		SetSupportedModels([]string{"gpt-4o"}).
		SetDefaultTestModel("gpt-4o").
		Save(ctx)
	require.NoError(t, err)
	prunedCh, err := svc.UpdateChannel(ctx, chExpOrphan.ID, &ent.UpdateChannelInput{
		Credentials: &objects.ChannelCredentials{
			APIKeys: []string{"sk-keep-1111"},
		},
	})
	require.NoError(t, err)
	require.Empty(t, prunedCh.DisabledAPIKeys)
	require.Empty(t, reloadChannel(t, ctx, client, chExpOrphan.ID).DisabledAPIKeys)
}

func TestChannelService_DisableSelectedAPIKeys(t *testing.T) {
	svc, client, ctx := setupChannelNamesBizTest(t)
	bus := events.NewBus()
	t.Cleanup(func() { require.NoError(t, bus.Close(context.Background())) })
	svc.EventBus = bus
	disabledCh := subscribeEvent(t, bus, events.TypeChannelCredentialDisabled)

	expired := time.Now().Add(-time.Minute)
	unexpiredTemp := time.Now().Add(time.Hour)
	ch, err := client.Channel.Create().
		SetType(channel.TypeOpenai).
		SetName("batch-disable-ch").
		SetBaseURL("https://api.openai.com/v1").
		SetStatus(channel.StatusEnabled).
		SetCredentials(objects.ChannelCredentials{
			APIKeys: []string{"sk-1", "sk-2", "sk-3", "sk-4", "sk-5", ""},
		}).
		SetDisabledAPIKeys([]objects.DisabledAPIKey{
			{Key: "sk-2", ErrorCode: 401, Reason: manualDisableReason},                    // already manually disabled
			{Key: "sk-3", ErrorCode: 429, Reason: "quota exhausted", QuotaDisabled: true},   // quota disabled
			{Key: "sk-4", ErrorCode: 500, Reason: "expired temp", ExpiresAt: &expired},      // expired -> treated enabled
			{Key: "sk-5", ErrorCode: 429, Reason: "temp limit", ExpiresAt: &unexpiredTemp},  // active temporary non-quota disable
		}).
		SetSupportedModels([]string{"gpt-4o"}).
		SetDefaultTestModel("gpt-4o").
		Save(ctx)
	require.NoError(t, err)

	// Trying to disable sk-1 and sk-4 leaves only an empty key -> must reject cleanly.
	err = svc.DisableSelectedAPIKeys(ctx, ch.ID, []string{"sk-1", "sk-4"})
	require.ErrorIs(t, err, ErrMustKeepOneEnabledAPIKey)
	var coded *xerrors.CodedError
	require.True(t, errors.As(err, &coded))
	require.Equal(t, xerrors.ErrCodeMustKeepOneEnabledAPIKey, coded.Code)

	// Empty / no-op cases return nil without writing or publishing events.
	require.NoError(t, svc.DisableSelectedAPIKeys(ctx, ch.ID, nil))
	require.NoError(t, svc.DisableSelectedAPIKeys(ctx, ch.ID, []string{"sk-nonexistent"}))
	require.Equal(t, int64(0), bus.Stats().Published)

	// Disable sk-2 (idempotent skip), sk-3 (replaces quota disable), sk-4 (new manual disable),
	// sk-5 (unexpired temporary non-quota disable -> idempotent skip) while leaving sk-1 enabled.
	err = svc.DisableSelectedAPIKeys(ctx, ch.ID, []string{"sk-2", "sk-3", "sk-3", "sk-4", "sk-5", "sk-nonexistent"})
	require.NoError(t, err)

	updated := reloadChannel(t, ctx, client, ch.ID)
	require.Equal(t, channel.StatusEnabled, updated.Status)
	require.Len(t, updated.DisabledAPIKeys, 4)

	byKey := make(map[string]objects.DisabledAPIKey, len(updated.DisabledAPIKeys))
	for _, dk := range updated.DisabledAPIKeys {
		byKey[dk.Key] = dk
	}
	require.False(t, byKey["sk-3"].QuotaDisabled)
	require.Equal(t, manualDisableReason, byKey["sk-3"].Reason)
	require.Equal(t, manualDisableReason, byKey["sk-4"].Reason)
	require.False(t, byKey["sk-5"].QuotaDisabled)
	require.Equal(t, 429, byKey["sk-5"].ErrorCode)
	require.Equal(t, "temp limit", byKey["sk-5"].Reason)
	require.NotNil(t, byKey["sk-5"].ExpiresAt)

	// Exactly 2 events published: sk-3 (replaced) and sk-4 (newly disabled); sk-2 and sk-5 skipped.
	ev1 := requireEvent(t, disabledCh)
	ev2 := requireEvent(t, disabledCh)
	require.Equal(t, []string{events.Fingerprint("sk-3"), events.Fingerprint("sk-4")},
		[]string{ev1.Subject.Credential.Fingerprint, ev2.Subject.Credential.Fingerprint})
	require.Empty(t, disabledCh)

	// Missing ScopeWriteChannels is denied even on no-op inputs.
	readOnlyUser := &ent.User{ID: 999, Scopes: []string{string(scopes.ScopeReadChannels)}}
	readOnlyCtx := contexts.WithUser(authz.NewUserContext(ent.NewContext(context.Background(), client), readOnlyUser.ID), readOnlyUser)
	err = svc.DisableSelectedAPIKeys(readOnlyCtx, ch.ID, nil)
	require.ErrorIs(t, err, privacy.Deny)

	// Rolling back an outer transaction does not persist or emit disable events.
	// Re-enable sk-4 first so sk-1 is not the sole enabled key when testing rollback.
	require.NoError(t, svc.EnableAPIKey(ctx, ch.ID, "sk-4"))
	rollbackSentinel := errors.New("force rollback")
	err = svc.RunInTransaction(ctx, func(txCtx context.Context) error {
		require.NoError(t, svc.DisableSelectedAPIKeys(txCtx, ch.ID, []string{"sk-1"}))
		require.Empty(t, disabledCh)
		return rollbackSentinel
	})
	require.ErrorIs(t, err, rollbackSentinel)
	require.Empty(t, disabledCh)
	afterRollback := reloadChannel(t, ctx, client, ch.ID)
	require.Len(t, afterRollback.DisabledAPIKeys, 3)
}

func TestChannelService_UpdateChannel_ExpectedUpdatedAtAndConcurrentDisable(t *testing.T) {
	t.Run("stale expectedUpdatedAt rejects rename without overwriting rotated keys", func(t *testing.T) {
		svc, client, ctx := setupChannelNamesBizTest(t)

		created, err := svc.CreateChannel(ctx, ent.CreateChannelInput{
			Type:    channel.TypeOpenai,
			Name:    "optimistic-rename-ch",
			BaseURL: lo.ToPtr("https://api.openai.com/v1"),
			Credentials: objects.ChannelCredentials{
				APIKeys: []string{"sk-1", "sk-2"},
			},
			SupportedModels:  []string{"gpt-4o"},
			DefaultTestModel: "gpt-4o",
		})
		require.NoError(t, err)
		staleUpdatedAt := created.UpdatedAt

		// Another admin rotates sk-2 -> sk-3 before the rename saves.
		rotated, err := svc.UpdateChannel(ctx, created.ID, &ent.UpdateChannelInput{
			Credentials: &objects.ChannelCredentials{
				APIKeys: []string{"sk-1", "sk-3"},
			},
		})
		require.NoError(t, err)
		require.True(t, rotated.UpdatedAt.After(staleUpdatedAt))

		// Submitting the stale snapshot with staleUpdatedAt fails instead of restoring sk-2.
		_, err = svc.UpdateChannel(
			WithExpectedChannelVersion(ctx, staleUpdatedAt),
			created.ID,
			&ent.UpdateChannelInput{
				Credentials: &objects.ChannelCredentials{
					APIKeys:     []string{"sk-1", "sk-2"},
					APIKeyNames: []objects.APIKeyName{{Key: "sk-1", Name: "primary"}},
				},
			},
		)
		require.ErrorIs(t, err, ErrChannelUpdatedConcurrently)
		var coded *xerrors.CodedError
		require.True(t, errors.As(err, &coded))
		require.Equal(t, xerrors.ErrCodeChannelUpdatedConcurrently, coded.Code)

		afterConflict := reloadChannel(t, ctx, client, created.ID)
		require.Equal(t, []string{"sk-1", "sk-3"}, afterConflict.Credentials.APIKeys)
		require.Empty(t, afterConflict.Credentials.NameOf("sk-1"))

		// Re-submitting against the refreshed snapshot and keys commits cleanly.
		renamed, err := svc.UpdateChannel(
			WithExpectedChannelVersion(ctx, rotated.UpdatedAt),
			created.ID,
			&ent.UpdateChannelInput{
				Credentials: &objects.ChannelCredentials{
					APIKeys:     []string{"sk-1", "sk-3"},
					APIKeyNames: []objects.APIKeyName{{Key: "sk-1", Name: "primary"}},
				},
			},
		)
		require.NoError(t, err)
		require.Equal(t, []string{"sk-1", "sk-3"}, renamed.Credentials.APIKeys)
		require.Equal(t, "primary", renamed.Credentials.NameOf("sk-1"))
	})

	t.Run("concurrent DisableSelectedAPIKeys never drops an acknowledged disable", func(t *testing.T) {
		dsn := "file:" + filepath.Join(t.TempDir(), "concurrent_disable.db") + "?_fk=1&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)"
		schemaClient := enttest.NewEntClient(t, "sqlite3", dsn)
		require.NoError(t, schemaClient.Close())

		raw, err := entsql.Open("sqlite3", dsn)
		require.NoError(t, err)
		raw.DB().SetMaxOpenConns(4)
		raw.DB().SetMaxIdleConns(4)
		client := ent.NewClient(ent.Driver(raw))
		t.Cleanup(func() { require.NoError(t, client.Close()) })

		ctx := authz.WithTestBypass(ent.NewContext(context.Background(), client))
		svc := NewChannelServiceForTest(client)
		bus := events.NewBus()
		t.Cleanup(func() { require.NoError(t, bus.Close(context.Background())) })
		svc.EventBus = bus
		disabledCh := subscribeEvent(t, bus, events.TypeChannelCredentialDisabled)

		ch, err := client.Channel.Create().
			SetType(channel.TypeOpenai).
			SetName("concurrent-disable-ch").
			SetBaseURL("https://api.openai.com/v1").
			SetStatus(channel.StatusEnabled).
			SetCredentials(objects.ChannelCredentials{
				APIKeys: []string{"sk-a", "sk-b", "sk-c"},
			}).
			SetSupportedModels([]string{"gpt-4o"}).
			SetDefaultTestModel("gpt-4o").
			Save(ctx)
		require.NoError(t, err)

		ready := make(chan struct{})
		errs := make([]error, 2)
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-ready
			errs[0] = svc.DisableSelectedAPIKeys(ctx, ch.ID, []string{"sk-a"})
		}()
		go func() {
			defer wg.Done()
			<-ready
			errs[1] = svc.DisableSelectedAPIKeys(ctx, ch.ID, []string{"sk-b"})
		}()
		close(ready)
		wg.Wait()

		require.True(t, errs[0] == nil || errs[1] == nil, "at least one concurrent disable must succeed: errs=%v", errs)

		after := reloadChannel(t, ctx, client, ch.ID)
		disabledKeys := make(map[string]bool, len(after.DisabledAPIKeys))
		for _, dk := range after.DisabledAPIKeys {
			disabledKeys[dk.Key] = true
		}
		if errs[0] == nil {
			require.True(t, disabledKeys["sk-a"], "first call succeeded without persisting sk-a")
		}
		if errs[1] == nil {
			require.True(t, disabledKeys["sk-b"], "second call succeeded without persisting sk-b")
		}

		// Emitted events match persisted disables; a failed loser never publishes.
		for range len(after.DisabledAPIKeys) {
			requireEvent(t, disabledCh)
		}
		require.Empty(t, disabledCh)
	})

	t.Run("deterministic overlapping two-connection SQLite DisableSelectedAPIKeys rejects stale snapshot without publishing event", func(t *testing.T) {
		dsn := "file:" + filepath.Join(t.TempDir(), "cas_overlap.db") + "?_fk=1&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)"
		schemaClient := enttest.NewEntClient(t, "sqlite3", dsn)
		require.NoError(t, schemaClient.Close())

		openClient := func() *ent.Client {
			raw, err := entsql.Open("sqlite3", dsn)
			require.NoError(t, err)
			raw.DB().SetMaxOpenConns(2)
			raw.DB().SetMaxIdleConns(2)
			c := ent.NewClient(ent.Driver(raw))
			t.Cleanup(func() { require.NoError(t, c.Close()) })
			return c
		}
		client1 := openClient()
		client2 := openClient()

		ctx1 := authz.WithTestBypass(ent.NewContext(context.Background(), client1))
		ctx2 := authz.WithTestBypass(ent.NewContext(context.Background(), client2))

		svc1 := NewChannelServiceForTest(client1)
		bus1 := events.NewBus()
		t.Cleanup(func() { require.NoError(t, bus1.Close(context.Background())) })
		svc1.EventBus = bus1
		ch1Events := subscribeEvent(t, bus1, events.TypeChannelCredentialDisabled)

		svc2 := NewChannelServiceForTest(client2)
		bus2 := events.NewBus()
		t.Cleanup(func() { require.NoError(t, bus2.Close(context.Background())) })
		svc2.EventBus = bus2
		ch2Events := subscribeEvent(t, bus2, events.TypeChannelCredentialDisabled)

		ch, err := client1.Channel.Create().
			SetType(channel.TypeOpenai).
			SetName("cas-overlap-ch").
			SetBaseURL("https://api.openai.com/v1").
			SetStatus(channel.StatusEnabled).
			SetCredentials(objects.ChannelCredentials{
				APIKeys: []string{"sk-a", "sk-b", "sk-c"},
			}).
			SetSupportedModels([]string{"gpt-4o"}).
			SetDefaultTestModel("gpt-4o").
			Save(ctx1)
		require.NoError(t, err)

		var injected atomic.Bool
		var err2 error
		client1.Channel.Use(func(next ent.Mutator) ent.Mutator {
			return ent.MutateFunc(func(ctx context.Context, m ent.Mutation) (ent.Value, error) {
				if m.Op().Is(ent.OpUpdate) && injected.CompareAndSwap(false, true) {
					// client1 holds its pre-update WAL read snapshot inside its open transaction while
					// client2 commits a competing disable on an independent SQLite connection first.
					err2 = svc2.DisableSelectedAPIKeys(ctx2, ch.ID, []string{"sk-b"})
				}
				return next.Mutate(ctx, m)
			})
		})

		err1 := svc1.DisableSelectedAPIKeys(ctx1, ch.ID, []string{"sk-a"})
		require.True(t, injected.Load())
		require.NoError(t, err2)
		require.Error(t, err1, "overlapping stale transaction must be rejected rather than overwriting sk-b")

		after := reloadChannel(t, ctx2, client2, ch.ID)
		require.Len(t, after.DisabledAPIKeys, 1)
		require.Equal(t, "sk-b", after.DisabledAPIKeys[0].Key)

		requireEvent(t, ch2Events)
		require.Empty(t, ch2Events)
		require.Empty(t, ch1Events, "rejected transaction must not emit credential disabled events")
	})

	t.Run("single-connection SQLite completes without holding process lock over DB access", func(t *testing.T) {
		dsn := "file:single_conn_" + strings.NewReplacer("/", "_", " ", "_").Replace(t.Name()) + "?mode=memory&cache=shared&_fk=1"
		schemaClient := enttest.NewEntClient(t, "sqlite3", dsn)
		t.Cleanup(func() { require.NoError(t, schemaClient.Close()) })

		raw, err := entsql.Open("sqlite3", dsn)
		require.NoError(t, err)
		raw.DB().SetMaxOpenConns(1)
		client := ent.NewClient(ent.Driver(raw))
		t.Cleanup(func() { require.NoError(t, client.Close()) })

		ctx := authz.WithTestBypass(ent.NewContext(context.Background(), client))
		svc := NewChannelServiceForTest(client)

		ch, err := client.Channel.Create().
			SetType(channel.TypeOpenai).
			SetName("single-conn-ch").
			SetBaseURL("https://api.openai.com/v1").
			SetStatus(channel.StatusEnabled).
			SetCredentials(objects.ChannelCredentials{
				APIKeys: []string{"sk-1", "sk-2", "sk-3"},
			}).
			SetSupportedModels([]string{"gpt-4o"}).
			SetDefaultTestModel("gpt-4o").
			Save(ctx)
		require.NoError(t, err)

		require.NoError(t, svc.DisableSelectedAPIKeys(ctx, ch.ID, []string{"sk-1"}))
		updated, err := svc.UpdateChannel(ctx, ch.ID, &ent.UpdateChannelInput{}, &ChannelAPIKeyStateChanges{
			EnableKeys:  []string{"sk-1"},
			DisableKeys: []string{"sk-2"},
		})
		require.NoError(t, err)
		require.Len(t, updated.DisabledAPIKeys, 1)
		require.Equal(t, "sk-2", updated.DisabledAPIKeys[0].Key)
	})
}

func TestRequestService_CreateRequestExecution_ChannelAPIKeyFingerprint(t *testing.T) {
	client := enttest.NewEntClient(t, "sqlite3", channelEventDSN(t))
	defer client.Close()

	baseCtx := authz.WithTestBypass(ent.NewContext(context.Background(), client))
	reqSvc := newRequestServiceForAPIKeyIndex(t, client)

	makeReq := func(model string) *ent.Request {
		r, err := client.Request.Create().
			SetModelID(model).
			SetFormat(string(llm.APIFormatOpenAIChatCompletion)).
			SetRequestBody([]byte(`{}`)).
			SetStatus(entrequest.StatusProcessing).
			SetStream(false).
			Save(baseCtx)
		require.NoError(t, err)
		return r
	}

	// 1. Multi-key ordinary channel
	multiCh, err := client.Channel.Create().
		SetName("multi-fp").
		SetType(channel.TypeOpenai).
		SetCredentials(objects.ChannelCredentials{APIKeys: []string{"sk-one-1111", "sk-two-2222"}}).
		SetSupportedModels([]string{"gpt-4o"}).
		SetDefaultTestModel("gpt-4o").
		Save(baseCtx)
	require.NoError(t, err)
	ctxMulti := contexts.EnsureContainer(baseCtx)
	contexts.WithChannelAPIKey(ctxMulti, "sk-two-2222")
	execMulti, err := reqSvc.CreateRequestExecution(ctxMulti, &Channel{Channel: multiCh}, "gpt-4o", makeReq("gpt-4o"), httpclient.Request{Body: []byte(`{}`)}, llm.APIFormatOpenAIChatCompletion, false)
	require.NoError(t, err)
	require.NotNil(t, execMulti.ChannelAPIKeyFingerprint)
	require.Equal(t, objects.CredentialFingerprint("sk-two-2222"), *execMulti.ChannelAPIKeyFingerprint)
	require.NotNil(t, execMulti.ChannelAPIKeyIndex)
	require.Equal(t, 2, *execMulti.ChannelAPIKeyIndex)

	// 2. Single-key ordinary channel still gets fingerprint (index stays nil)
	singleCh, err := client.Channel.Create().
		SetName("single-fp").
		SetType(channel.TypeOpenai).
		SetCredentials(objects.ChannelCredentials{APIKeys: []string{"sk-single-9999"}}).
		SetSupportedModels([]string{"gpt-4o"}).
		SetDefaultTestModel("gpt-4o").
		Save(baseCtx)
	require.NoError(t, err)
	ctxSingle := contexts.EnsureContainer(baseCtx)
	contexts.WithChannelAPIKey(ctxSingle, "sk-single-9999")
	execSingle, err := reqSvc.CreateRequestExecution(ctxSingle, &Channel{Channel: singleCh}, "gpt-4o", makeReq("gpt-4o"), httpclient.Request{Body: []byte(`{}`)}, llm.APIFormatOpenAIChatCompletion, false)
	require.NoError(t, err)
	require.NotNil(t, execSingle.ChannelAPIKeyFingerprint)
	require.Equal(t, objects.CredentialFingerprint("sk-single-9999"), *execSingle.ChannelAPIKeyFingerprint)
	require.Nil(t, execSingle.ChannelAPIKeyIndex)

	// 3. Codex third-party channel
	tpCh, err := client.Channel.Create().
		SetName("codex-tp-fp").
		SetType(channel.TypeCodex).
		SetCredentials(objects.ChannelCredentials{APIKeys: []string{"sk-tp-5555"}}).
		SetSupportedModels([]string{"gpt-5"}).
		SetDefaultTestModel("gpt-5").
		Save(baseCtx)
	require.NoError(t, err)
	ctxTP := contexts.EnsureContainer(baseCtx)
	contexts.WithChannelAPIKey(ctxTP, "sk-tp-5555")
	execTP, err := reqSvc.CreateRequestExecution(ctxTP, &Channel{Channel: tpCh}, "gpt-5", makeReq("gpt-5"), httpclient.Request{Body: []byte(`{}`)}, llm.APIFormatOpenAIChatCompletion, false)
	require.NoError(t, err)
	require.NotNil(t, execTP.ChannelAPIKeyFingerprint)
	require.Equal(t, objects.CredentialFingerprint("sk-tp-5555"), *execTP.ChannelAPIKeyFingerprint)

	// 4. Vertex API key + Service account credentialRef
	account := objects.GCPCredential{JSONData: `{"client_email":"sa@example.invalid","private_key_id":"kid","private_key":"pk"}`}
	saRef := account.CredentialRef()
	vertexCh, err := client.Channel.Create().
		SetName("vertex-fp").
		SetType(channel.TypeGeminiVertex).
		SetCredentials(objects.ChannelCredentials{
			VertexAPIKeys:         []objects.VertexAPIKey{{APIKey: "AIza-vertex-key"}},
			VertexServiceAccounts: []objects.GCPCredential{account},
		}).
		SetSupportedModels([]string{"gemini-2.5-pro"}).
		SetDefaultTestModel("gemini-2.5-pro").
		Save(baseCtx)
	require.NoError(t, err)

	ctxVKey := contexts.EnsureContainer(baseCtx)
	contexts.WithChannelAPIKey(ctxVKey, "AIza-vertex-key")
	execVKey, err := reqSvc.CreateRequestExecution(ctxVKey, &Channel{Channel: vertexCh}, "gemini-2.5-pro", makeReq("gemini-2.5-pro"), httpclient.Request{Body: []byte(`{}`)}, llm.APIFormatOpenAIChatCompletion, false)
	require.NoError(t, err)
	require.Equal(t, objects.CredentialFingerprint("AIza-vertex-key"), lo.FromPtr(execVKey.ChannelAPIKeyFingerprint))

	ctxSA := contexts.EnsureContainer(baseCtx)
	contexts.WithChannelAPIKey(ctxSA, saRef)
	execSA, err := reqSvc.CreateRequestExecution(ctxSA, &Channel{Channel: vertexCh}, "gemini-2.5-pro", makeReq("gemini-2.5-pro"), httpclient.Request{Body: []byte(`{}`)}, llm.APIFormatOpenAIChatCompletion, false)
	require.NoError(t, err)
	require.Equal(t, objects.CredentialFingerprint(saRef), lo.FromPtr(execSA.ChannelAPIKeyFingerprint))

	// 5. OAuth channel records OAuthCredentialRef fingerprint without suffix or index,
	// even when a previous API-key attempt left a plaintext key in the shared container.
	oauthCh, err := client.Channel.Create().
		SetName("oauth-fp").
		SetType(channel.TypeCodex).
		SetCredentials(objects.ChannelCredentials{OAuth: &objects.OAuthCredentials{AccessToken: "tok", RefreshToken: "ref"}}).
		SetSupportedModels([]string{"gpt-5"}).
		SetDefaultTestModel("gpt-5").
		Save(baseCtx)
	require.NoError(t, err)
	oauthRetryCtx := contexts.EnsureContainer(baseCtx)
	contexts.WithChannelAPIKey(oauthRetryCtx, "sk-stale-from-previous-attempt")
	execOAuth, err := reqSvc.CreateRequestExecution(oauthRetryCtx, &Channel{Channel: oauthCh}, "gpt-5", makeReq("gpt-5"), httpclient.Request{Body: []byte(`{}`)}, llm.APIFormatOpenAIChatCompletion, false)
	require.NoError(t, err)
	require.NotNil(t, execOAuth.ChannelAPIKeyFingerprint)
	require.Equal(t, objects.CredentialFingerprint(objects.OAuthCredentialRef), *execOAuth.ChannelAPIKeyFingerprint)
	require.Nil(t, execOAuth.ChannelAPIKeySuffix)
	require.Nil(t, execOAuth.ChannelAPIKeyIndex)
}

func TestNextChannelUpdatedAt_MySQLWholeSecondPrecision(t *testing.T) {
	futureSameSec := time.Now().UTC().Add(10 * time.Second).Truncate(time.Second).Add(950 * time.Millisecond)
	next1 := nextChannelUpdatedAt(dialect.MySQL, futureSameSec)
	require.Equal(t, time.UTC, next1.Location())
	require.Equal(t, 0, next1.Nanosecond())
	require.True(t, next1.After(futureSameSec.Truncate(time.Second)))
	require.Equal(t, time.Second, next1.Sub(futureSameSec.Truncate(time.Second)))

	next2 := nextChannelUpdatedAt(dialect.MySQL, next1)
	require.Equal(t, 0, next2.Nanosecond())
	require.Equal(t, time.Second, next2.Sub(next1))

	past := time.Now().UTC().Add(-10 * time.Second)
	pastNext := nextChannelUpdatedAt(dialect.MySQL, past)
	require.Equal(t, 0, pastNext.Nanosecond())
	require.True(t, pastNext.After(past.Truncate(time.Second)))

	microPrev := time.Now().UTC().Add(10 * time.Second)
	microNext := nextChannelUpdatedAt(dialect.SQLite, microPrev)
	require.True(t, microNext.After(microPrev))
}

func TestChannelService_MySQLSameSecondOptimisticLock(t *testing.T) {
	dsn := os.Getenv("AXONHUB_TEST_PAYLOAD_MYSQL_DSN")
	if dsn == "" {
		t.Skip("AXONHUB_TEST_PAYLOAD_MYSQL_DSN is not configured")
	}
	config, err := mysql.ParseDSN(dsn)
	require.NoError(t, err)
	require.Equal(t, "tcp", config.Net)
	host, _, err := net.SplitHostPort(config.Addr)
	require.NoError(t, err)
	require.Contains(t, []string{"127.0.0.1", "localhost", "::1"}, host)
	require.Equal(t, "axonhub_payload_test", config.DBName)

	bootstrap, err := sql.Open("mysql", dsn)
	require.NoError(t, err)
	t.Cleanup(func() { _ = bootstrap.Close() })
	database := fmt.Sprintf("axonhub_channel_version_test_%d", time.Now().UnixNano())
	_, err = bootstrap.ExecContext(t.Context(), "CREATE DATABASE `"+database+"`")
	require.NoError(t, err)
	t.Cleanup(func() {
		dropCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, err := bootstrap.ExecContext(dropCtx, "DROP DATABASE `"+database+"`")
		require.NoError(t, err)
	})

	config.DBName = database
	config.ParseTime = true
	db, err := sql.Open("mysql", config.FormatDSN())
	require.NoError(t, err)
	db.SetMaxOpenConns(4)
	client := ent.NewClient(ent.Driver(entsql.OpenDB(dialect.MySQL, db)))
	t.Cleanup(func() { require.NoError(t, client.Close()) })

	ctx, cancel := context.WithTimeout(authz.WithTestBypass(ent.NewContext(t.Context(), client)), 30*time.Second)
	defer cancel()
	require.NoError(t, client.Schema.Create(ctx, migrate.WithForeignKeys(false)))

	svc := NewChannelServiceForTest(client)

	created, err := svc.CreateChannel(ctx, ent.CreateChannelInput{
		Type:    channel.TypeOpenai,
		Name:    "mysql-version-ch",
		BaseURL: lo.ToPtr("https://api.openai.com/v1"),
		Credentials: objects.ChannelCredentials{
			APIKeys: []string{"sk-r1", "sk-r2"},
		},
		SupportedModels:  []string{"gpt-4o"},
		DefaultTestModel: "gpt-4o",
	})
	require.NoError(t, err)
	require.Equal(t, 0, created.UpdatedAt.Nanosecond())
	loadedCreated := reloadChannel(t, ctx, client, created.ID)
	require.True(t, loadedCreated.UpdatedAt.Equal(created.UpdatedAt))

	rotated, err := svc.UpdateChannel(ctx, created.ID, &ent.UpdateChannelInput{
		Credentials: &objects.ChannelCredentials{
			APIKeys: []string{"sk-r1", "sk-r3"},
		},
	})
	require.NoError(t, err)
	require.GreaterOrEqual(t, rotated.UpdatedAt.Sub(created.UpdatedAt), time.Second)

	// Stale expectedUpdatedAt from the same second must still be rejected on MySQL.
	_, err = svc.UpdateChannel(
		WithExpectedChannelVersion(ctx, created.UpdatedAt),
		created.ID,
		&ent.UpdateChannelInput{Name: lo.ToPtr("stale-rename")},
	)
	require.ErrorIs(t, err, ErrChannelUpdatedConcurrently)

	renamed, err := svc.UpdateChannel(
		WithExpectedChannelVersion(ctx, rotated.UpdatedAt),
		created.ID,
		&ent.UpdateChannelInput{Name: lo.ToPtr("fresh-rename")},
	)
	require.NoError(t, err)
	require.True(t, renamed.UpdatedAt.After(rotated.UpdatedAt))

	require.NoError(t, svc.DisableSelectedAPIKeys(ctx, created.ID, []string{"sk-r3"}))
	_, err = svc.UpdateChannel(
		WithExpectedChannelVersion(ctx, renamed.UpdatedAt),
		created.ID,
		&ent.UpdateChannelInput{
			Credentials: &objects.ChannelCredentials{
				APIKeys:     []string{"sk-r1", "sk-r3"},
				APIKeyNames: []objects.APIKeyName{{Key: "sk-r1", Name: "primary"}},
			},
		},
	)
	require.ErrorIs(t, err, ErrChannelUpdatedConcurrently)
}

