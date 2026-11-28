// 职责: 验证失败重试与渠道故障转移切入无密钥渠道前清空上下文残留密钥，避免误归因旧密钥。
// 关联文件:
//
//	internal/contexts/context.go
//	internal/server/orchestrator/outbound.go
//	internal/server/biz/request.go
//
// 遵循的 Rules:
//
//	.agents/rules/go-general.md
//
// 注意事项:
//
//	PrepareForRetry 必须在 refreshChannelBeforeRetry 读取上一次凭证之后再清理上下文密钥。
package orchestrator

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/looplj/axonhub/internal/contexts"
	"github.com/looplj/axonhub/internal/ent/channel"
	entrequest "github.com/looplj/axonhub/internal/ent/request"
	"github.com/looplj/axonhub/internal/objects"
	"github.com/looplj/axonhub/internal/server/biz"
	"github.com/looplj/axonhub/llm"
	"github.com/looplj/axonhub/llm/httpclient"
)

func TestNextChannel_ClearsStaleAPIKeyForKeylessFailover(t *testing.T) {
	ctx, client := setupTest(t)
	channelSvc := newTestChannelServiceForChannels(client)
	_, reqSvc, _, _ := setupTestServices(t, client)

	openAIEntity, err := client.Channel.Create().
		SetType(channel.TypeOpenai).
		SetName("keyed-primary").
		SetBaseURL("https://api.openai.com/v1").
		SetCredentials(objects.ChannelCredentials{
			APIKeys: []string{"sk-openai-failover-1111"},
		}).
		SetSupportedModels([]string{"llama3"}).
		SetDefaultTestModel("llama3").
		SetStatus(channel.StatusEnabled).
		Save(ctx)
	require.NoError(t, err)

	ollamaEntity, err := client.Channel.Create().
		SetType(channel.TypeOllama).
		SetName("keyless-ollama").
		SetBaseURL("http://localhost:11434").
		SetCredentials(objects.ChannelCredentials{}).
		SetSupportedModels([]string{"llama3"}).
		SetDefaultTestModel("llama3").
		SetStatus(channel.StatusEnabled).
		Save(ctx)
	require.NoError(t, err)

	bizOpenAI, err := channelSvc.GetChannel(ctx, openAIEntity.ID)
	require.NoError(t, err)
	bizOllama, err := channelSvc.GetChannel(ctx, ollamaEntity.ID)
	require.NoError(t, err)

	reqEntity, err := client.Request.Create().
		SetModelID("llama3").
		SetFormat(string(llm.APIFormatOpenAIChatCompletion)).
		SetRequestBody([]byte(`{}`)).
		SetStatus(entrequest.StatusProcessing).
		SetStream(false).
		Save(ctx)
	require.NoError(t, err)

	reqCtx := contexts.EnsureContainer(ctx)
	contexts.WithChannelAPIKey(reqCtx, "sk-openai-failover-1111")

	processor := &PersistentOutboundTransformer{
		wrapped: bizOpenAI.Outbound,
		state: &PersistenceState{
			ChannelService:        channelSvc,
			OriginalModel:         "llama3",
			CurrentCandidateIndex: 0,
			ChannelModelsCandidates: []*ChannelModelsCandidate{
				{
					Channel:   bizOpenAI,
					Models:    []biz.ChannelModelEntry{{ActualModel: "llama3"}},
					APIFormat: string(llm.APIFormatOpenAIChatCompletion),
				},
				{
					Channel:   bizOllama,
					Models:    []biz.ChannelModelEntry{{ActualModel: "llama3"}},
					APIFormat: string(llm.APIFormatOpenAIChatCompletion),
				},
			},
		},
	}
	processor.state.CurrentCandidate = processor.state.ChannelModelsCandidates[0]

	require.NoError(t, processor.NextChannel(reqCtx))

	_, ok := contexts.GetChannelAPIKey(reqCtx)
	require.False(t, ok)

	exec, err := reqSvc.CreateRequestExecution(
		reqCtx,
		bizOllama,
		"llama3",
		reqEntity,
		httpclient.Request{Body: []byte(`{}`)},
		llm.APIFormatOpenAIChatCompletion,
		false,
	)
	require.NoError(t, err)
	require.Nil(t, exec.ChannelAPIKeyFingerprint)
	require.Nil(t, exec.ChannelAPIKeySuffix)
	require.Nil(t, exec.ChannelAPIKeyIndex)
}

func TestPrepareForRetry_ClearsStaleAPIKeyAfterRefresh(t *testing.T) {
	ctx, client := setupTest(t)
	channelSvc := newTestChannelServiceForChannels(client)

	entity := createRetryGuardChannel(t, ctx, client, "prepare-retry-clear",
		objects.ChannelCredentials{APIKeys: []string{"sk-retry-1111", "sk-retry-2222"}})
	snapshot := retryGuardSnapshot(t, ctx, channelSvc, entity.ID)

	client.Channel.UpdateOneID(entity.ID).
		SetDisabledAPIKeys([]objects.DisabledAPIKey{{Key: "sk-retry-1111"}}).
		SaveX(ctx)

	transformer := newRetryGuardTransformer(channelSvc, snapshot, "sk-retry-1111")
	retryCtx := contexts.WithChannelAPIKey(contexts.EnsureContainer(ctx), "sk-retry-1111")

	require.NoError(t, transformer.PrepareForRetry(retryCtx))

	_, ok := contexts.GetChannelAPIKey(retryCtx)
	require.False(t, ok)
	require.Equal(t, []string{"sk-retry-2222"}, transformer.state.CurrentCandidate.Channel.GetEnabledAPIKeys())
}
