// 职责: 验证 API 密钥名称 GraphQL 读取边界、输入反序列化、channelAPIKeyLabel 解析、请求级缓存及 CollectFields 列裁剪。
// 关联文件:
//   internal/server/gql/axonhub.resolvers.go
//   internal/server/gql/request_cache.go
//   internal/server/gql/graphql.go
//   internal/ent/template/collection.tmpl
// 遵循的 Rules:
//   .agents/rules/go-general.md
//   .agents/rules/ent-graphql.md
// 注意事项:
//   SQL 捕获驱动显式实现 dialect.Driver 接口以避免可选接口绕过查询记录。
//   请求级缓存按单次 GraphQL Operation 生效，跨请求会自动重新读取最新渠道配置。

package gql

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	"entgo.io/ent/dialect/sql/schema"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/looplj/axonhub/internal/authz"
	"github.com/looplj/axonhub/internal/contexts"
	"github.com/looplj/axonhub/internal/ent"
	"github.com/looplj/axonhub/internal/ent/channel"
	"github.com/looplj/axonhub/internal/ent/enttest"
	"github.com/looplj/axonhub/internal/ent/migrate"
	"github.com/looplj/axonhub/internal/ent/migrate/schemahook"
	"github.com/looplj/axonhub/internal/ent/project"
	"github.com/looplj/axonhub/internal/ent/request"
	"github.com/looplj/axonhub/internal/ent/requestexecution"
	"github.com/looplj/axonhub/internal/ent/user"
	"github.com/looplj/axonhub/internal/log"
	"github.com/looplj/axonhub/internal/objects"
	"github.com/looplj/axonhub/internal/pkg/xcache"
	"github.com/looplj/axonhub/internal/scopes"
	"github.com/looplj/axonhub/internal/server/biz"
	"github.com/looplj/axonhub/internal/server/middleware"
)

type sqlCaptureDriver struct {
	drv     dialect.Driver
	mu      sync.Mutex
	queries []string
}

func (d *sqlCaptureDriver) record(query string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.queries = append(d.queries, query)
}

func (d *sqlCaptureDriver) reset() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.queries = nil
}

func (d *sqlCaptureDriver) snapshot() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]string, len(d.queries))
	copy(out, d.queries)
	return out
}

func (d *sqlCaptureDriver) Exec(ctx context.Context, query string, args, v any) error {
	return d.drv.Exec(ctx, query, args, v)
}

func (d *sqlCaptureDriver) Query(ctx context.Context, query string, args, v any) error {
	d.record(query)
	return d.drv.Query(ctx, query, args, v)
}

func (d *sqlCaptureDriver) Tx(ctx context.Context) (dialect.Tx, error) {
	tx, err := d.drv.Tx(ctx)
	if err != nil {
		return nil, err
	}
	return &sqlCaptureTx{Tx: tx, rec: d}, nil
}

func (d *sqlCaptureDriver) Close() error {
	return d.drv.Close()
}

func (d *sqlCaptureDriver) Dialect() string {
	return d.drv.Dialect()
}

type sqlCaptureTx struct {
	dialect.Tx
	rec *sqlCaptureDriver
}

func (t *sqlCaptureTx) Query(ctx context.Context, query string, args, v any) error {
	t.rec.record(query)
	return t.Tx.Query(ctx, query, args, v)
}

func newCapturedEntClient(t *testing.T, dsn string) (*ent.Client, *sqlCaptureDriver) {
	t.Helper()

	sqlDB, err := sql.Open("sqlite3", dsn)
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)
	t.Cleanup(func() { _ = sqlDB.Close() })

	rec := &sqlCaptureDriver{drv: entsql.OpenDB("sqlite3", sqlDB)}
	client := enttest.NewClient(t,
		enttest.WithOptions(ent.Driver(rec)),
		enttest.WithMigrateOptions(
			migrate.WithGlobalUniqueID(false),
			migrate.WithForeignKeys(false),
			migrate.WithDropIndex(true),
			migrate.WithDropColumn(true),
			schema.WithHooks(schemahook.V0_3_0),
		),
	)
	t.Cleanup(func() { _ = client.Close() })
	return client, rec
}

func TestChannelCredentialsInput_DistinguishesOmittedVsEmptyAPIKeyNames(t *testing.T) {
	ec := &executionContext{}

	omitted, err := ec.unmarshalInputChannelCredentialsInput(t.Context(), map[string]any{
		"apiKeys": []any{"sk-one"},
	})
	require.NoError(t, err)
	require.Nil(t, omitted.APIKeyNames)

	cleared, err := ec.unmarshalInputChannelCredentialsInput(t.Context(), map[string]any{
		"apiKeys":     []any{"sk-one"},
		"apiKeyNames": []any{},
	})
	require.NoError(t, err)
	require.NotNil(t, cleared.APIKeyNames)
	require.Empty(t, cleared.APIKeyNames)

	named, err := ec.unmarshalInputChannelCredentialsInput(t.Context(), map[string]any{
		"apiKeys": []any{"sk-one"},
		"apiKeyNames": []any{
			map[string]any{"key": "sk-one", "name": "prod"},
		},
	})
	require.NoError(t, err)
	require.Equal(t, []objects.APIKeyName{{Key: "sk-one", Name: "prod"}}, named.APIKeyNames)
}

func TestChannelResolver_Credentials_APIKeyNamesAndScopes(t *testing.T) {
	_, ctx, client := setupTestQueryResolver(t)
	defer client.Close()

	ch, err := client.Channel.Create().
		SetType(channel.TypeOpenai).
		SetName("Named OpenAI").
		SetBaseURL("https://api.openai.com/v1").
		SetCredentials(objects.ChannelCredentials{
			APIKeys: []string{"sk-live-1111", "sk-live-2222"},
			VertexAPIKeys: []objects.VertexAPIKey{
				{ProjectID: "p-legacy", APIKey: "sk-legacy-vertex-triple", Region: "global"},
			},
			APIKeyNames: []objects.APIKeyName{
				{Key: "sk-live-1111", Name: "primary"},
				{Key: "sk-legacy-vertex-triple", Name: "stale-triple"},
				{Key: "sk-removed-9999", Name: "orphan"},
			},
		}).
		SetSupportedModels([]string{"gpt-4o"}).
		SetDefaultTestModel("gpt-4o").
		Save(ctx)
	require.NoError(t, err)

	oauthCh, err := client.Channel.Create().
		SetType(channel.TypeCodex).
		SetName("OAuth Codex").
		SetBaseURL("https://chatgpt.com/backend-api/codex#").
		SetCredentials(objects.ChannelCredentials{
			OAuth: &objects.OAuthCredentials{AccessToken: "tok"},
			APIKeyNames: []objects.APIKeyName{
				{Key: objects.OAuthCredentialRef, Name: "should-not-leak"},
			},
		}).
		SetSupportedModels([]string{"gpt-5"}).
		SetDefaultTestModel("gpt-5").
		Save(ctx)
	require.NoError(t, err)

	antigravityCh, err := client.Channel.Create().
		SetType(channel.TypeAntigravity).
		SetName("Antigravity Channel").
		SetBaseURL("https://example.invalid").
		SetCredentials(objects.ChannelCredentials{
			APIKeys: []string{"sk-ag-1"},
			APIKeyNames: []objects.APIKeyName{
				{Key: "sk-ag-1", Name: "ag-secret-name"},
			},
		}).
		SetSupportedModels([]string{"ag-model"}).
		SetDefaultTestModel("ag-model").
		Save(ctx)
	require.NoError(t, err)

	readOnlyUser := &ent.User{ID: 1001, Scopes: []string{string(scopes.ScopeReadChannels)}}
	readOnlyCtx := contexts.WithUser(ctx, readOnlyUser)
	channelRes := &channelResolver{&Resolver{client: client}}

	noWriteCreds, err := channelRes.Credentials(readOnlyCtx, ch)
	require.NoError(t, err)
	require.Nil(t, noWriteCreds)

	writeCtx := vertexCredentialsContext(t, ctx, client)
	creds, err := channelRes.Credentials(writeCtx, ch)
	require.NoError(t, err)
	require.NotNil(t, creds)
	require.Equal(t, []objects.APIKeyName{{Key: "sk-live-1111", Name: "primary"}}, creds.APIKeyNames)

	oauthCreds, err := channelRes.Credentials(writeCtx, oauthCh)
	require.NoError(t, err)
	require.NotNil(t, oauthCreds)
	require.Nil(t, oauthCreds.APIKeyNames)

	agCreds, err := channelRes.Credentials(writeCtx, antigravityCh)
	require.NoError(t, err)
	require.NotNil(t, agCreds)
	require.Nil(t, agCreds.APIKeyNames)

	vertexCh, err := client.Channel.Create().
		SetType(channel.TypeGeminiVertex).
		SetName("Vertex Channel").
		SetBaseURL("https://us-central1-aiplatform.googleapis.com").
		SetCredentials(objects.ChannelCredentials{
			APIKeys: []string{"sk-v-flat"},
			VertexAPIKeys: []objects.VertexAPIKey{
				{ProjectID: "p1", APIKey: "AIza-v1", Region: "global"},
			},
			APIKeyNames: []objects.APIKeyName{
				{Key: "sk-v-flat", Name: "stale-flat"},
				{Key: "AIza-v1", Name: "stale-bound"},
			},
		}).
		SetSupportedModels([]string{"gemini-2.5-pro"}).
		SetDefaultTestModel("gemini-2.5-pro").
		Save(ctx)
	require.NoError(t, err)
	vertexCreds, err := channelRes.Credentials(writeCtx, vertexCh)
	require.NoError(t, err)
	require.NotNil(t, vertexCreds)
	require.Equal(t, []string{"sk-v-flat"}, vertexCreds.APIKeys)
	require.Nil(t, vertexCreds.APIKeyNames)
}

func TestRequestExecutionResolver_ChannelAPIKeyLabel_Scenarios(t *testing.T) {
	_, setupCtx, client := setupTestQueryResolver(t)
	defer client.Close()

	multiCh, err := client.Channel.Create().
		SetType(channel.TypeOpenai).
		SetName("Multi Channel").
		SetBaseURL("https://api.openai.com/v1").
		SetCredentials(objects.ChannelCredentials{
			APIKeys: []string{"sk-k1-1111", "sk-k2-2222"},
			APIKeyNames: []objects.APIKeyName{
				{Key: "sk-k1-1111", Name: "prod"},
			},
		}).
		SetSupportedModels([]string{"gpt-4o"}).
		SetDefaultTestModel("gpt-4o").
		Save(setupCtx)
	require.NoError(t, err)

	singleCh, err := client.Channel.Create().
		SetType(channel.TypeOpenai).
		SetName("Single Unnamed").
		SetBaseURL("https://api.openai.com/v1").
		SetCredentials(objects.ChannelCredentials{APIKeys: []string{"sk-only-3333"}}).
		SetSupportedModels([]string{"gpt-4o"}).
		SetDefaultTestModel("gpt-4o").
		Save(setupCtx)
	require.NoError(t, err)

	oauthCh, err := client.Channel.Create().
		SetType(channel.TypeCodex).
		SetName("OAuth Channel").
		SetBaseURL("https://chatgpt.com/backend-api/codex#").
		SetCredentials(objects.ChannelCredentials{
			OAuth: &objects.OAuthCredentials{AccessToken: "tok"},
			// Even if stale names existed in raw DB JSON, OAuth must never expose names.
			APIKeyNames: []objects.APIKeyName{{Key: objects.OAuthCredentialRef, Name: "stale-oauth-name"}},
		}).
		SetSupportedModels([]string{"gpt-5"}).
		SetDefaultTestModel("gpt-5").
		Save(setupCtx)
	require.NoError(t, err)

	ownerCtx := vertexCredentialsContext(t, setupCtx, client)
	execRes := &requestExecutionResolver{&Resolver{client: client}}

	fpK1 := objects.CredentialFingerprint("sk-k1-1111")
	fpK2 := objects.CredentialFingerprint("sk-k2-2222")
	fpDeleted := objects.CredentialFingerprint("sk-deleted-4444")
	fpSingle := objects.CredentialFingerprint("sk-only-3333")
	fpOAuth := objects.CredentialFingerprint(objects.OAuthCredentialRef)

	// 1. Named key returns live name, then reflects rename immediately.
	label, err := execRes.ChannelAPIKeyLabel(ownerCtx, &ent.RequestExecution{
		ChannelID:                multiCh.ID,
		ChannelAPIKeyFingerprint: &fpK1,
	})
	require.NoError(t, err)
	require.NotNil(t, label)
	require.False(t, label.Deleted)
	require.NotNil(t, label.Name)
	require.Equal(t, "prod", *label.Name)

	// 2. Unnamed multi-key returns 1-based position.
	label, err = execRes.ChannelAPIKeyLabel(ownerCtx, &ent.RequestExecution{
		ChannelID:                multiCh.ID,
		ChannelAPIKeyFingerprint: &fpK2,
	})
	require.NoError(t, err)
	require.NotNil(t, label)
	require.False(t, label.Deleted)
	require.Nil(t, label.Name)
	require.NotNil(t, label.Index)
	require.Equal(t, 2, *label.Index)

	// Reorder and rename -> labels resolve live from latest channel state.
	_, err = client.Channel.UpdateOneID(multiCh.ID).
		SetCredentials(objects.ChannelCredentials{
			APIKeys: []string{"sk-k2-2222", "sk-k1-1111"},
			APIKeyNames: []objects.APIKeyName{
				{Key: "sk-k1-1111", Name: "renamed-prod"},
			},
		}).
		Save(setupCtx)
	require.NoError(t, err)

	label, err = execRes.ChannelAPIKeyLabel(ownerCtx, &ent.RequestExecution{
		ChannelID:                multiCh.ID,
		ChannelAPIKeyFingerprint: &fpK1,
	})
	require.NoError(t, err)
	require.Equal(t, "renamed-prod", *label.Name)

	label, err = execRes.ChannelAPIKeyLabel(ownerCtx, &ent.RequestExecution{
		ChannelID:                multiCh.ID,
		ChannelAPIKeyFingerprint: &fpK2,
	})
	require.NoError(t, err)
	require.NotNil(t, label.Index)
	require.Equal(t, 1, *label.Index)

	// 3. Unnamed single key returns {deleted: false} with nil name and nil index.
	label, err = execRes.ChannelAPIKeyLabel(ownerCtx, &ent.RequestExecution{
		ChannelID:                singleCh.ID,
		ChannelAPIKeyFingerprint: &fpSingle,
	})
	require.NoError(t, err)
	require.Equal(t, &ChannelAPIKeyLabel{Deleted: false}, label)

	// 4. OAuth channel returns {deleted: false} without name or index.
	label, err = execRes.ChannelAPIKeyLabel(ownerCtx, &ent.RequestExecution{
		ChannelID:                oauthCh.ID,
		ChannelAPIKeyFingerprint: &fpOAuth,
	})
	require.NoError(t, err)
	require.Equal(t, &ChannelAPIKeyLabel{Deleted: false}, label)

	// 5. Deleted key from living channel returns {deleted: true}.
	label, err = execRes.ChannelAPIKeyLabel(ownerCtx, &ent.RequestExecution{
		ChannelID:                multiCh.ID,
		ChannelAPIKeyFingerprint: &fpDeleted,
	})
	require.NoError(t, err)
	require.Equal(t, &ChannelAPIKeyLabel{Deleted: true}, label)

	// 6. Legacy execution without fingerprint returns nil.
	label, err = execRes.ChannelAPIKeyLabel(ownerCtx, &ent.RequestExecution{ChannelID: multiCh.ID})
	require.NoError(t, err)
	require.Nil(t, label)

	// 7. Deleted channel or missing read_channels permission returns nil.
	label, err = execRes.ChannelAPIKeyLabel(ownerCtx, &ent.RequestExecution{
		ChannelID:                999999,
		ChannelAPIKeyFingerprint: &fpK1,
	})
	require.NoError(t, err)
	require.Nil(t, label)

	readUser := &ent.User{ID: 2001, Scopes: []string{string(scopes.ScopeReadChannels)}}
	label, err = execRes.ChannelAPIKeyLabel(contexts.WithUser(setupCtx, readUser), &ent.RequestExecution{
		ChannelID:                multiCh.ID,
		ChannelAPIKeyFingerprint: &fpK1,
	})
	require.NoError(t, err)
	require.NotNil(t, label)
	require.Equal(t, "renamed-prod", *label.Name)

	noPermUser := &ent.User{ID: 2002, Scopes: []string{}}
	label, err = execRes.ChannelAPIKeyLabel(contexts.WithUser(ent.NewContext(t.Context(), client), noPermUser), &ent.RequestExecution{
		ChannelID:                multiCh.ID,
		ChannelAPIKeyFingerprint: &fpK1,
	})
	require.NoError(t, err)
	require.Nil(t, label)

	// 8. Legacy hidden Vertex binding on a non-Vertex channel never surfaces a stale custom name.
	legacyTripleCh, err := client.Channel.Create().
		SetType(channel.TypeOpenai).
		SetName("Legacy Triple Label").
		SetBaseURL("https://api.openai.com/v1").
		SetCredentials(objects.ChannelCredentials{
			APIKeys: []string{"sk-visible-1111"},
			VertexAPIKeys: []objects.VertexAPIKey{
				{ProjectID: "p1", APIKey: "sk-hidden-triple-9999", Region: "global"},
			},
			APIKeyNames: []objects.APIKeyName{
				{Key: "sk-visible-1111", Name: "visible"},
				{Key: "sk-hidden-triple-9999", Name: "hidden-stale-name"},
			},
		}).
		SetSupportedModels([]string{"gpt-4o"}).
		SetDefaultTestModel("gpt-4o").
		Save(setupCtx)
	require.NoError(t, err)

	fpHiddenTriple := objects.CredentialFingerprint("sk-hidden-triple-9999")
	label, err = execRes.ChannelAPIKeyLabel(ownerCtx, &ent.RequestExecution{
		ChannelID:                legacyTripleCh.ID,
		ChannelAPIKeyFingerprint: &fpHiddenTriple,
	})
	require.NoError(t, err)
	require.NotNil(t, label)
	require.False(t, label.Deleted)
	require.Nil(t, label.Name)
}

func TestChannelAPIKeyLabel_CollectFieldsAvoidsSelectStarAndCachesChannelsPerRequest(t *testing.T) {
	// Ensure channelAPIKeyFingerprint is never exposed in ent.graphql SDL.
	for _, src := range sources {
		if strings.HasSuffix(src.Name, "ent.graphql") {
			require.NotContains(t, src.Input, "channelAPIKeyFingerprint")
		}
	}

	dsn := fmt.Sprintf("file:gql_collect_fields_%d?mode=memory&_fk=1", time.Now().UnixNano())
	db, rec := newCapturedEntClient(t, dsn)
	setupCtx := authz.WithTestBypass(ent.NewContext(t.Context(), db))

	owner, err := db.User.Create().
		SetEmail("owner-label-perf@example.com").
		SetPassword("pw").
		SetFirstName("Owner").
		SetLastName("Perf").
		SetStatus(user.StatusActivated).
		SetIsOwner(true).
		Save(setupCtx)
	require.NoError(t, err)

	proj, err := db.Project.Create().
		SetName("perf-project").
		SetStatus(project.StatusActive).
		Save(setupCtx)
	require.NoError(t, err)

	chA, err := db.Channel.Create().
		SetType(channel.TypeOpenai).
		SetName("Channel A").
		SetBaseURL("https://api.openai.com/v1").
		SetCredentials(objects.ChannelCredentials{
			APIKeys: []string{"sk-a1-1111", "sk-a2-2222"},
			APIKeyNames: []objects.APIKeyName{
				{Key: "sk-a1-1111", Name: "alpha"},
			},
		}).
		SetSupportedModels([]string{"gpt-4o"}).
		SetDefaultTestModel("gpt-4o").
		Save(setupCtx)
	require.NoError(t, err)

	chB, err := db.Channel.Create().
		SetType(channel.TypeOpenai).
		SetName("Channel B").
		SetBaseURL("https://api.openai.com/v1").
		SetCredentials(objects.ChannelCredentials{
			APIKeys: []string{"sk-b1-3333", "sk-b2-4444"},
		}).
		SetSupportedModels([]string{"gpt-4o"}).
		SetDefaultTestModel("gpt-4o").
		Save(setupCtx)
	require.NoError(t, err)

	seedExecution := func(chID int, fp string, idx int) int {
		req, err := db.Request.Create().
			SetProjectID(proj.ID).
			SetChannelID(chID).
			SetModelID("gpt-4o").
			SetRequestBody(objects.JSONRawMessage(`{"prompt":"secret"}`)).
			SetStatus(request.StatusCompleted).
			SetStream(false).
			Save(setupCtx)
		require.NoError(t, err)

		builder := db.RequestExecution.Create().
			SetProjectID(proj.ID).
			SetRequestID(req.ID).
			SetChannelID(chID).
			SetModelID("gpt-4o").
			SetRequestBody(objects.JSONRawMessage(`{"large":"payload"}`)).
			SetResponseBody(objects.JSONRawMessage(`{"large":"response"}`)).
			SetStatus(requestexecution.StatusCompleted).
			SetStream(false).
			SetChannelAPIKeyIndex(idx)
		if fp != "" {
			builder.SetChannelAPIKeyFingerprint(fp)
		}
		_, err = builder.Save(setupCtx)
		require.NoError(t, err)
		return req.ID
	}

	reqA1 := seedExecution(chA.ID, objects.CredentialFingerprint("sk-a1-1111"), 1)
	seedExecution(chA.ID, objects.CredentialFingerprint("sk-a2-2222"), 2)
	seedExecution(chA.ID, objects.CredentialFingerprint("sk-removed"), 2)
	seedExecution(chB.ID, objects.CredentialFingerprint("sk-b2-4444"), 2)
	seedExecution(chB.ID, "", 1) // legacy row without fingerprint

	sysSvc := biz.NewSystemService(biz.SystemServiceParams{
		Ent:         db,
		CacheConfig: xcache.Config{Mode: xcache.ModeMemory},
	})
	handler := NewGraphqlHandlers(Dependencies{
		Ent:           db,
		SystemService: sysSvc,
	})

	postGraphQL := func(query string, variables map[string]any) map[string]any {
		payload := map[string]any{"query": query}
		if variables != nil {
			payload["variables"] = variables
		}
		body, err := json.Marshal(payload)
		require.NoError(t, err)
		req := httptest.NewRequest(http.MethodPost, "/admin/graphql", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		ctx := ent.NewContext(req.Context(), db)
		ctx = contexts.WithUser(authz.NewUserContext(ctx, owner.ID), owner)
		recorder := httptest.NewRecorder()
		handler.Graphql.ServeHTTP(recorder, req.WithContext(ctx))
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		var resp map[string]any
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &resp), recorder.Body.String())
		require.Empty(t, resp["errors"], recorder.Body.String())
		return resp
	}

	isExecutionRowQuery := func(q string) bool {
		upper := strings.ToUpper(strings.TrimSpace(q))
		if !strings.HasPrefix(upper, "SELECT") && !strings.HasPrefix(upper, "WITH") {
			return false
		}
		if !strings.Contains(q, "`request_executions`") && !strings.Contains(q, `"request_executions"`) && !strings.Contains(q, "FROM request_executions") {
			return false
		}
		return !strings.Contains(upper, "COUNT(")
	}

	rec.reset()
	_ = postGraphQL(requestListQueryWithChannelAPIKeyIndex, map[string]any{"first": 10})
	queries := rec.snapshot()

	var execSelects []string
	var perIDChannelSelects int
	var totalChannelSelects int
	for _, q := range queries {
		if isExecutionRowQuery(q) {
			execSelects = append(execSelects, q)
		}
		isSelect := strings.HasPrefix(strings.ToUpper(strings.TrimSpace(q)), "SELECT")
		if isSelect && (strings.Contains(q, "FROM `channels`") || strings.Contains(q, `FROM "channels"`)) && strings.Contains(q, "WHERE") {
			totalChannelSelects++
			if !strings.Contains(strings.ToUpper(q), " IN (") {
				perIDChannelSelects++
			}
		}
	}

	require.NotEmpty(t, execSelects)
	for _, q := range execSelects {
		upper := strings.ToUpper(q)
		// Ent LimitPerRow wraps the projected request_executions query in a src_query CTE
		// and selects columns from src_query, so ensure the base table never uses SELECT *.
		require.NotContains(t, upper, "SELECT * FROM `REQUEST_EXECUTIONS`")
		require.NotContains(t, upper, `SELECT * FROM "REQUEST_EXECUTIONS"`)
		require.NotContains(t, upper, "SELECT `REQUEST_EXECUTIONS`.*")
		require.NotContains(t, upper, `SELECT "REQUEST_EXECUTIONS".*`)
		require.NotContains(t, q, "request_body")
		require.NotContains(t, q, "response_body")
		require.NotContains(t, q, "response_chunks")
		require.NotContains(t, q, "request_headers")
		require.NotContains(t, q, "response_headers")
		require.Contains(t, q, "channel_api_key_fingerprint")
		require.Contains(t, q, "channel_id")
	}
	// 5 executions across 2 distinct channels: cache collapses per-ID resolver reads to 2 (+ at most 1 Ent IN-batch eager load).
	require.Equal(t, 2, perIDChannelSelects)
	require.LessOrEqual(t, totalChannelSelects, 3)

	// Querying channelAPIKeyLabel WITHOUT selecting channel or channelID must still collect channel_id and resolve cleanly.
	rec.reset()
	reqGUID := fmt.Sprintf("gid://axonhub/%s/%d", ent.TypeRequest, reqA1)
	standaloneQuery := `
	  query StandaloneLabel($id: ID!) {
	    node(id: $id) {
	      ... on Request {
	        executions(first: 10) {
	          edges {
	            node {
	              id
	              channelAPIKeyLabel {
	                name
	                index
	                deleted
	              }
	            }
	          }
	        }
	      }
	    }
	  }
	`
	resp := postGraphQL(standaloneQuery, map[string]any{"id": reqGUID})
	dataMap := resp["data"].(map[string]any)
	nodeMap := dataMap["node"].(map[string]any)
	execConn := nodeMap["executions"].(map[string]any)
	edges := execConn["edges"].([]any)
	require.Len(t, edges, 1)
	execNode := edges[0].(map[string]any)["node"].(map[string]any)
	labelMap := execNode["channelAPIKeyLabel"].(map[string]any)
	require.Equal(t, "alpha", labelMap["name"])
	require.Equal(t, false, labelMap["deleted"])

	standaloneQueries := rec.snapshot()
	foundStandaloneExec := false
	for _, q := range standaloneQueries {
		if isExecutionRowQuery(q) {
			foundStandaloneExec = true
			require.NotContains(t, q, "request_body")
			require.NotContains(t, q, "response_body")
			require.Contains(t, q, "channel_id")
			require.Contains(t, q, "channel_api_key_fingerprint")
		}
	}
	require.True(t, foundStandaloneExec)

	// Querying ONLY channelID must NOT collect channel_api_key_fingerprint.
	rec.reset()
	channelIDOnlyQuery := `
	  query ChannelIDOnly($id: ID!) {
	    node(id: $id) {
	      ... on Request {
	        executions(first: 10) {
	          edges {
	            node {
	              id
	              channelID
	            }
	          }
	        }
	      }
	    }
	  }
	`
	_ = postGraphQL(channelIDOnlyQuery, map[string]any{"id": reqGUID})
	channelIDOnlyQueries := rec.snapshot()
	foundChannelIDOnly := false
	for _, q := range channelIDOnlyQueries {
		if isExecutionRowQuery(q) {
			foundChannelIDOnly = true
			require.Contains(t, q, "channel_id")
			require.NotContains(t, q, "channel_api_key_fingerprint")
		}
	}
	require.True(t, foundChannelIDOnly)
}

func TestChannelAPIKeyStateMutations_HTTPGraphQLAndDebugLogRedaction(t *testing.T) {
	dsn := fmt.Sprintf("file:gql_api_key_mutations_%d?mode=memory&_fk=1", time.Now().UnixNano())
	db := enttest.NewEntClient(t, "sqlite3", dsn)
	defer db.Close()

	logPath := filepath.Join(os.TempDir(), fmt.Sprintf("axonhub-gql-redaction-%d.log", time.Now().UnixNano()))
	log.SetGlobalConfig(log.Config{
		Name:     "gql-redaction-test",
		Level:    log.DebugLevel,
		Encoding: "json",
		Output:   "file",
		File:     log.FileConfig{Path: logPath},
	})
	t.Cleanup(func() {
		log.SetGlobalConfig(log.Config{
			Name:   "global",
			Level:  log.InfoLevel,
			Output: "stdio",
		})
		_ = os.Remove(logPath)
	})

	setupCtx := authz.WithTestBypass(ent.NewContext(t.Context(), db))
	owner, err := db.User.Create().
		SetEmail("owner-mut@example.com").
		SetPassword("pw").
		SetFirstName("Owner").
		SetLastName("Mut").
		SetStatus(user.StatusActivated).
		SetIsOwner(true).
		Save(setupCtx)
	require.NoError(t, err)

	secretKey1 := "sk-secret-http-key-alpha-1111"
	secretKey2 := "sk-secret-http-key-bravo-2222"

	ch, err := db.Channel.Create().
		SetType(channel.TypeOpenai).
		SetName("mut-channel").
		SetBaseURL("https://api.openai.com/v1").
		SetCredentials(objects.ChannelCredentials{
			APIKeys: []string{secretKey1, secretKey2},
		}).
		SetSupportedModels([]string{"gpt-4o"}).
		SetDefaultTestModel("gpt-4o").
		Save(setupCtx)
	require.NoError(t, err)

	handler := NewGraphqlHandlers(Dependencies{
		Ent:            db,
		ChannelService: biz.NewChannelServiceForTest(db),
	})

	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(func(c *gin.Context) {
		ctx := contexts.WithUser(authz.NewUserContext(ent.NewContext(c.Request.Context(), db), owner.ID), owner)
		ctx = log.ForceEnableLevel(ctx, log.DebugLevel)
		c.Request = c.Request.WithContext(ctx)
		c.Next()
	})
	router.Use(middleware.AccessLog())
	router.POST("/admin/graphql", gin.WrapH(handler.Graphql))

	postRawViaRouter := func(rawBody []byte) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/admin/graphql", bytes.NewReader(rawBody))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	post := func(query string, variables map[string]any) map[string]any {
		body, err := json.Marshal(map[string]any{"query": query, "variables": variables})
		require.NoError(t, err)
		rec := postRawViaRouter(body)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var resp map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp), rec.Body.String())
		return resp
	}

	chGUID := fmt.Sprintf("gid://axonhub/%s/%d", ent.TypeChannel, ch.ID)

	// 1. Failing disableSelectedChannelAPIKeys (aliased, fragment spread, custom variable name)
	// surfaces MUST_KEEP_ONE_ENABLED_API_KEY to caller while sanitizing AccessLog and debug logs.
	customVarKey1 := "sk-secret-custom-var-7777"
	disableAllResp := post(
		`fragment DisSel on Mutation { disAlias: disableSelectedChannelAPIKeys(channelID: $id, keys: $customSecretList) }
		mutation($id: ID!, $customSecretList: [String!]!) { ...DisSel }`,
		map[string]any{"id": chGUID, "customSecretList": []string{customVarKey1, secretKey2}},
	)
	errs := disableAllResp["errors"].([]any)
	require.NotEmpty(t, errs)

	// Also verify the real key pair returns MUST_KEEP_ONE_ENABLED_API_KEY.
	disableRealAllResp := post(
		`mutation($id: ID!, $customSecretList: [String!]!) { disableSelectedChannelAPIKeys(channelID: $id, keys: $customSecretList) }`,
		map[string]any{"id": chGUID, "customSecretList": []string{secretKey1, secretKey2}},
	)
	errs = disableRealAllResp["errors"].([]any)
	require.NotEmpty(t, errs)
	errMap := errs[0].(map[string]any)
	ext := errMap["extensions"].(map[string]any)
	require.Equal(t, "MUST_KEEP_ONE_ENABLED_API_KEY", ext["code"])

	// 2. Succeeding disableSelectedChannelAPIKeys.
	disableOneResp := post(
		`mutation($id: ID!, $customSecretList: [String!]!) { disableSelectedChannelAPIKeys(channelID: $id, keys: $customSecretList) }`,
		map[string]any{"id": chGUID, "customSecretList": []string{secretKey1}},
	)
	require.Empty(t, disableOneResp["errors"])
	require.Equal(t, true, disableOneResp["data"].(map[string]any)["disableSelectedChannelAPIKeys"])

	// 3. Failing and succeeding updateChannel + expectedUpdatedAt optimistic concurrency protection.
	redactedUpdateKey1 := "sk-secret-redacted-update-1111"
	redactedUpdateKey2 := "sk-secret-redacted-update-2222"
	redactedUpdateName1 := "redacted-name-alpha"
	updateFailResp := post(
		`mutation($id: ID!, $input: UpdateChannelInput!, $apiKeyStateChanges: ChannelAPIKeyStateChangesInput) {
			updateChannel(id: $id, input: $input, apiKeyStateChanges: $apiKeyStateChanges) { id }
		}`,
		map[string]any{
			"id": chGUID,
			"input": map[string]any{
				"credentials": map[string]any{
					"apiKeys": []string{redactedUpdateKey1, redactedUpdateKey2},
				},
			},
			"apiKeyStateChanges": map[string]any{
				"disableKeys": []string{redactedUpdateKey1, redactedUpdateKey2},
			},
		},
	)
	require.NotEmpty(t, updateFailResp["errors"])

	updateResp := post(
		`mutation($id: ID!, $input: UpdateChannelInput!, $apiKeyStateChanges: ChannelAPIKeyStateChangesInput) {
			updateChannel(id: $id, input: $input, apiKeyStateChanges: $apiKeyStateChanges) {
				id
				updatedAt
				credentials { apiKeyNames { key name } }
			}
		}`,
		map[string]any{
			"id": chGUID,
			"input": map[string]any{
				"credentials": map[string]any{
					"apiKeys":     []string{redactedUpdateKey1, redactedUpdateKey2},
					"apiKeyNames": []map[string]any{{"key": redactedUpdateKey1, "name": redactedUpdateName1}},
				},
			},
			"apiKeyStateChanges": map[string]any{
				"enableKeys":  []string{redactedUpdateKey1},
				"disableKeys": []string{redactedUpdateKey2},
			},
		},
	)
	require.Empty(t, updateResp["errors"])
	reloaded := db.Channel.GetX(setupCtx, ch.ID)
	require.Equal(t, redactedUpdateName1, reloaded.Credentials.NameOf(redactedUpdateKey1))
	require.Len(t, reloaded.DisabledAPIKeys, 1)
	require.Equal(t, redactedUpdateKey2, reloaded.DisabledAPIKeys[0].Key)

	// 3b. Stale expectedUpdatedAt rejects overwrite and returns CHANNEL_UPDATED_CONCURRENTLY; fresh expectedUpdatedAt succeeds.
	staleTimestamp := reloaded.UpdatedAt.Add(-time.Minute).UTC().Format(time.RFC3339Nano)
	staleUpdateResp := post(
		`mutation($id: ID!, $input: UpdateChannelInput!, $expectedUpdatedAt: Time) {
			updateChannel(id: $id, input: $input, expectedUpdatedAt: $expectedUpdatedAt) { id updatedAt }
		}`,
		map[string]any{
			"id": chGUID,
			"input": map[string]any{
				"credentials": map[string]any{
					"apiKeys": []string{"sk-stale-overwrite-should-not-stick"},
				},
			},
			"expectedUpdatedAt": staleTimestamp,
		},
	)
	staleErrs := staleUpdateResp["errors"].([]any)
	require.NotEmpty(t, staleErrs)
	require.Equal(t, "CHANNEL_UPDATED_CONCURRENTLY", staleErrs[0].(map[string]any)["extensions"].(map[string]any)["code"])
	afterStale := db.Channel.GetX(setupCtx, ch.ID)
	require.Equal(t, []string{redactedUpdateKey1, redactedUpdateKey2}, afterStale.Credentials.APIKeys)

	freshUpdateResp := post(
		`mutation($id: ID!, $input: UpdateChannelInput!, $expectedUpdatedAt: Time) {
			updateChannel(id: $id, input: $input, expectedUpdatedAt: $expectedUpdatedAt) {
				id
				updatedAt
				credentials { apiKeyNames { key name } }
			}
		}`,
		map[string]any{
			"id": chGUID,
			"input": map[string]any{
				"credentials": map[string]any{
					"apiKeys":     []string{redactedUpdateKey1, redactedUpdateKey2},
					"apiKeyNames": []map[string]any{{"key": redactedUpdateKey1, "name": "fresh-name"}},
				},
			},
			"expectedUpdatedAt": afterStale.UpdatedAt.UTC().Format(time.RFC3339Nano),
		},
	)
	require.Empty(t, freshUpdateResp["errors"])
	require.Equal(t, "fresh-name", db.Channel.GetX(setupCtx, ch.ID).Credentials.NameOf(redactedUpdateKey1))

	// 3c. Malformed GraphQL request containing an inline secret string must never leak to debug log or AccessLog.
	malformedSecret := "sk-secret-malformed-payload-9999"
	malformedPayload, err := json.Marshal(map[string]any{
		"query": fmt.Sprintf(`mutation { disableSelectedChannelAPIKeys(channelID: %q, keys: [%q]`, chGUID, malformedSecret),
	})
	require.NoError(t, err)
	malformedRec := postRawViaRouter(malformedPayload)
	require.True(t, malformedRec.Code >= 400 || strings.Contains(malformedRec.Body.String(), `"errors"`))

	// 4. read_channels-only user must receive FORBIDDEN on disableSelectedChannelAPIKeys (including empty keys) and updateChannel.
	readUser, err := db.User.Create().
		SetEmail("reader-gql-mut@example.com").
		SetPassword("pw").
		SetFirstName("Read").
		SetLastName("GQL").
		SetStatus(user.StatusActivated).
		SetScopes([]string{string(scopes.ScopeReadChannels)}).
		Save(setupCtx)
	require.NoError(t, err)

	postAsReadUser := func(query string, variables map[string]any) map[string]any {
		body, err := json.Marshal(map[string]any{"query": query, "variables": variables})
		require.NoError(t, err)
		req := httptest.NewRequest(http.MethodPost, "/admin/graphql", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		uCtx := contexts.WithUser(authz.NewUserContext(ent.NewContext(req.Context(), db), readUser.ID), readUser)
		rec := httptest.NewRecorder()
		handler.Graphql.ServeHTTP(rec, req.WithContext(uCtx))
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var resp map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp), rec.Body.String())
		return resp
	}

	for _, tc := range []struct {
		query string
		vars  map[string]any
	}{
		{
			query: `mutation($id: ID!, $keys: [String!]!) { disableSelectedChannelAPIKeys(channelID: $id, keys: $keys) }`,
			vars:  map[string]any{"id": chGUID, "keys": []string{redactedUpdateKey1}},
		},
		{
			query: `mutation($id: ID!, $keys: [String!]!) { disableSelectedChannelAPIKeys(channelID: $id, keys: $keys) }`,
			vars:  map[string]any{"id": chGUID, "keys": []string{}},
		},
		{
			query: `mutation($id: ID!, $input: UpdateChannelInput!) { updateChannel(id: $id, input: $input) { id } }`,
			vars:  map[string]any{"id": chGUID, "input": map[string]any{"name": "blocked"}},
		},
	} {
		resp := postAsReadUser(tc.query, tc.vars)
		require.NotEmpty(t, resp["errors"], tc.query)
		require.Equal(t, "FORBIDDEN", resp["errors"].([]any)[0].(map[string]any)["extensions"].(map[string]any)["code"], tc.query)
	}

	// Verify both debug log and real AccessLog middleware emitted safe summaries and never leaked any plaintext key or name.
	logBytes, err := os.ReadFile(logPath)
	require.NoError(t, err)
	logContent := string(logBytes)
	require.Contains(t, logContent, "received graphql request")
	require.Contains(t, logContent, "[ACCESS]")
	require.Contains(t, logContent, "MUST_KEEP_ONE_ENABLED_API_KEY")
	require.Contains(t, logContent, "CHANNEL_UPDATED_CONCURRENTLY")
	require.NotContains(t, logContent, secretKey1)
	require.NotContains(t, logContent, secretKey2)
	require.NotContains(t, logContent, customVarKey1)
	require.NotContains(t, logContent, redactedUpdateKey1)
	require.NotContains(t, logContent, redactedUpdateKey2)
	require.NotContains(t, logContent, redactedUpdateName1)
	require.NotContains(t, logContent, malformedSecret)
}

func TestRequestCache_ClonesChannelForConcurrentPoliciesResolution(t *testing.T) {
	cache := newGQLRequestCache()
	shared := &ent.Channel{ID: 77}
	resolver := &channelResolver{&Resolver{}}

	const workers = 16
	var wg sync.WaitGroup
	results := make([]*objects.ChannelPolicies, workers)
	channels := make([]*ent.Channel, workers)
	for i := range workers {
		wg.Go(func() {
			ch, err := cache.getOrLoadChannel(77, func() (*ent.Channel, error) {
				return shared, nil
			})
			require.NoError(t, err)
			channels[i] = ch
			pol, err := resolver.Policies(context.Background(), ch)
			require.NoError(t, err)
			results[i] = pol
		})
	}
	wg.Wait()

	require.Empty(t, shared.Policies.Stream)
	for i := range workers {
		require.NotSame(t, shared, channels[i])
		require.Equal(t, objects.CapabilityPolicyUnlimited, results[i].Stream)
	}
}
