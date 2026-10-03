package orchestrator

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/looplj/axonhub/internal/contexts"
	"github.com/looplj/axonhub/internal/ent"
	"github.com/looplj/axonhub/internal/ent/channel"
	"github.com/looplj/axonhub/internal/ent/model"
	"github.com/looplj/axonhub/internal/objects"
	"github.com/looplj/axonhub/internal/server/biz"
	"github.com/looplj/axonhub/llm"
	"github.com/looplj/axonhub/llm/httpclient"
	"github.com/looplj/axonhub/llm/transformer/openai"
)

// profileWeightsCandidate builds a candidate whose channel carries the given
// global ordering weight and a name derived from the channel ID.
func profileWeightsCandidate(id, orderingWeight int) *ChannelModelsCandidate {
	return &ChannelModelsCandidate{
		Channel: &biz.Channel{
			Channel: &ent.Channel{
				ID:             id,
				Name:           "channel-" + string(rune('A'+id-1)),
				OrderingWeight: orderingWeight,
			},
		},
	}
}

func profileWeightsIDs(candidates []*ChannelModelsCandidate) []int {
	ids := make([]int, 0, len(candidates))
	for _, candidate := range candidates {
		ids = append(ids, candidate.Channel.ID)
	}

	return ids
}

// independentWeightsAPIKey builds an API key whose active profile selects
// channels through independent channel weights.
func independentWeightsAPIKey(
	channelWeights []objects.ProfileChannelWeight,
	channelIDs []int,
	channelTags []string,
	project *ent.Project,
) *ent.APIKey {
	return &ent.APIKey{
		Profiles: &objects.APIKeyProfiles{
			ActiveProfile: "default",
			Profiles: []objects.APIKeyProfile{{
				Name:                      "default",
				ChannelIDs:                channelIDs,
				ChannelTags:               channelTags,
				IndependentChannelWeights: true,
				ChannelWeights:            channelWeights,
			}},
		},
		Edges: ent.APIKeyEdges{Project: project},
	}
}

func TestProfileChannelWeightsSelector_FiltersToProfileSet(t *testing.T) {
	// Given
	base := &staticChannelSelector{candidates: []*ChannelModelsCandidate{
		profileWeightsCandidate(1, 10),
		profileWeightsCandidate(2, 20),
		profileWeightsCandidate(3, 30),
	}}
	selector := WithProfileChannelWeightsSelector(base, map[int]int{1: 10, 2: 20})

	// When
	result, err := selector.Select(context.Background(), &llm.Request{Model: "gpt-4"})

	// Then
	require.NoError(t, err)
	require.Equal(t, []int{1, 2}, profileWeightsIDs(result))
}

func TestProfileChannelWeightsSelector_EmptyWeights_DeniesAll(t *testing.T) {
	// Given
	base := &staticChannelSelector{candidates: []*ChannelModelsCandidate{
		profileWeightsCandidate(1, 10),
	}}
	selector := WithProfileChannelWeightsSelector(base, map[int]int{})

	// When
	result, err := selector.Select(context.Background(), &llm.Request{Model: "gpt-4"})

	// Then
	require.NoError(t, err)
	require.NotNil(t, result)
	require.Empty(t, result)
}

func TestProfileChannelWeightsSelector_OverridesOrderingWeightWithoutMutatingOriginal(t *testing.T) {
	// Given
	originalOutbound, err := openai.NewOutboundTransformer("https://api.example.com/v1", "test-key")
	require.NoError(t, err)

	originalHTTPClient := httpclient.NewHttpClient()
	originalSettings := &objects.ChannelSettings{ExtraModelPrefix: "prefix"}
	originalChannel := &biz.Channel{
		Channel: &ent.Channel{
			ID:             7,
			Name:           "original",
			OrderingWeight: 10,
			Settings:       originalSettings,
		},
		Outbound:   originalOutbound,
		HTTPClient: originalHTTPClient,
	}
	base := &staticChannelSelector{candidates: []*ChannelModelsCandidate{{Channel: originalChannel}}}
	selector := WithProfileChannelWeightsSelector(base, map[int]int{7: 90})

	// When
	result, err := selector.Select(context.Background(), &llm.Request{Model: "gpt-4"})

	// Then
	require.NoError(t, err)
	require.Len(t, result, 1)

	got := result[0].Channel
	require.Equal(t, 90, got.OrderingWeight)
	require.Equal(t, 10, originalChannel.OrderingWeight, "the original channel must not be mutated")
	require.NotSame(t, originalChannel.Channel, got.Channel)
	require.Equal(t, originalChannel.ID, got.ID)
	require.Equal(t, originalChannel.Name, got.Name)
	require.Equal(t, originalOutbound, got.Outbound)
	require.Same(t, originalHTTPClient, got.HTTPClient)
	require.Same(t, originalSettings, got.Settings)
}

func TestProfileChannelWeightsSelector_WeightDrivesFailoverOrder(t *testing.T) {
	policy := &mockRetryPolicyProvider{policy: &biz.RetryPolicy{Enabled: true, MaxChannelRetries: 3}}
	newCandidates := func() []*ChannelModelsCandidate {
		return []*ChannelModelsCandidate{
			profileWeightsCandidate(1, 10),
			profileWeightsCandidate(2, 50),
			profileWeightsCandidate(3, 100),
		}
	}

	// Control: without the profile selector the global weights drive the order.
	globalSelector := WithLoadBalancedSelector(
		&staticChannelSelector{candidates: newCandidates()},
		NewLoadBalancer(policy, nil, NewWeightStrategy()),
		policy,
	)
	globalResult, err := globalSelector.Select(context.Background(), &llm.Request{Model: "gpt-4"})
	require.NoError(t, err)
	require.Equal(t, []int{3, 2, 1}, profileWeightsIDs(globalResult))

	// Given: profile weights invert the global order.
	selector := WithLoadBalancedSelector(
		WithProfileChannelWeightsSelector(&staticChannelSelector{candidates: newCandidates()}, map[int]int{1: 100, 2: 50, 3: 10}),
		NewLoadBalancer(policy, nil, NewWeightStrategy()),
		policy,
	)

	// When
	result, err := selector.Select(context.Background(), &llm.Request{Model: "gpt-4"})

	// Then
	require.NoError(t, err)
	require.Equal(t, []int{1, 2, 3}, profileWeightsIDs(result))
}

func TestSelectCandidates_IndependentMode_IgnoresChannelIDsAndTags(t *testing.T) {
	// Given
	inbound := &PersistentInboundTransformer{state: &PersistenceState{
		CandidateSelector: &staticChannelSelector{candidates: []*ChannelModelsCandidate{
			quotaRoutingCandidate(1, ""),
			quotaRoutingCandidate(2, ""),
			quotaRoutingCandidate(4, ""),
		}},
		APIKey: independentWeightsAPIKey(
			[]objects.ProfileChannelWeight{{ChannelID: 1, Weight: 80}, {ChannelID: 2, Weight: 20}},
			[]int{4},
			[]string{"x"},
			nil,
		),
	}}
	middleware := selectCandidates(inbound, nil, &mockQuotaRoutingSettingsProvider{})

	// When
	_, err := middleware.OnInboundLlmRequest(context.Background(), &llm.Request{Model: "model"})

	// Then
	require.NoError(t, err)
	require.Equal(t, []int{1, 2}, profileWeightsIDs(inbound.state.ChannelModelsCandidates))
}

func TestSelectCandidates_LegacyMode_UnchangedWhenIndependentOff(t *testing.T) {
	// Given
	apiKey := independentWeightsAPIKey([]objects.ProfileChannelWeight{{ChannelID: 1, Weight: 80}}, []int{4}, nil, nil)
	apiKey.Profiles.Profiles[0].IndependentChannelWeights = false

	inbound := &PersistentInboundTransformer{state: &PersistenceState{
		CandidateSelector: &staticChannelSelector{candidates: []*ChannelModelsCandidate{
			quotaRoutingCandidate(1, ""),
			quotaRoutingCandidate(2, ""),
			quotaRoutingCandidate(4, ""),
		}},
		APIKey: apiKey,
	}}
	middleware := selectCandidates(inbound, nil, &mockQuotaRoutingSettingsProvider{})

	// When
	_, err := middleware.OnInboundLlmRequest(context.Background(), &llm.Request{Model: "model"})

	// Then
	require.NoError(t, err)
	require.Equal(t, []int{4}, profileWeightsIDs(inbound.state.ChannelModelsCandidates))
}

func TestSelectCandidates_IndependentMode_RespectsProjectUpperBound(t *testing.T) {
	// Given
	project := &ent.Project{
		Profiles: &objects.ProjectProfiles{
			ActiveProfile: "project-default",
			Profiles: []objects.ProjectProfile{{
				Name:       "project-default",
				ChannelIDs: []int{1},
			}},
		},
	}
	inbound := &PersistentInboundTransformer{state: &PersistenceState{
		CandidateSelector: &staticChannelSelector{candidates: []*ChannelModelsCandidate{
			quotaRoutingCandidate(1, ""),
			quotaRoutingCandidate(2, ""),
		}},
		APIKey: independentWeightsAPIKey(
			[]objects.ProfileChannelWeight{{ChannelID: 1, Weight: 80}, {ChannelID: 2, Weight: 20}},
			nil,
			nil,
			project,
		),
	}}
	middleware := selectCandidates(inbound, nil, &mockQuotaRoutingSettingsProvider{})

	// When
	_, err := middleware.OnInboundLlmRequest(context.Background(), &llm.Request{Model: "model"})

	// Then
	require.NoError(t, err)
	require.Equal(t, []int{1}, profileWeightsIDs(inbound.state.ChannelModelsCandidates))
}

func TestSelectCandidates_IndependentMode_QuotaExhaustedStaysInProfile(t *testing.T) {
	settings := &mockQuotaRoutingSettingsProvider{settings: biz.QuotaRoutingSettings{DefaultMode: objects.QuotaRoutingModeRemoveOnExhausted}}
	newInbound := func() *PersistentInboundTransformer {
		return &PersistentInboundTransformer{state: &PersistenceState{
			CandidateSelector: &staticChannelSelector{candidates: []*ChannelModelsCandidate{
				quotaRoutingCandidate(1, ""),
				quotaRoutingCandidate(2, ""),
				quotaRoutingCandidate(3, ""),
			}},
			LoadBalancers: map[string]*LoadBalancer{},
			APIKey: independentWeightsAPIKey(
				[]objects.ProfileChannelWeight{{ChannelID: 1, Weight: 80}, {ChannelID: 2, Weight: 20}},
				nil,
				nil,
				nil,
			),
		}}
	}

	// Given: only channel 1 is exhausted.
	inbound := newInbound()
	middleware := selectCandidates(inbound, &mockQuotaStatusProvider{statuses: map[int]*biz.QuotaChannelStatus{
		1: quotaExhaustedStatus(),
	}}, settings)

	// When
	_, err := middleware.OnInboundLlmRequest(context.Background(), &llm.Request{Model: "model"})

	// Then
	require.NoError(t, err)
	require.Equal(t, []int{2}, profileWeightsIDs(inbound.state.ChannelModelsCandidates))

	// Given: every profile channel is exhausted.
	inbound = newInbound()
	middleware = selectCandidates(inbound, &mockQuotaStatusProvider{statuses: map[int]*biz.QuotaChannelStatus{
		1: quotaExhaustedStatus(),
		2: quotaExhaustedStatus(),
	}}, settings)

	// When
	_, err = middleware.OnInboundLlmRequest(context.Background(), &llm.Request{Model: "model"})

	// Then
	var quotaErr *QuotaExhaustedError
	require.True(t, errors.As(err, &quotaErr))
	require.Empty(t, inbound.state.ChannelModelsCandidates)
}

// createProfileWeightsChannel creates an enabled OpenAI channel with a distinct
// base URL so recorded upstream requests can be attributed back to it.
func createProfileWeightsChannel(t *testing.T, ctx context.Context, client *ent.Client, name, baseURL string) *ent.Channel {
	t.Helper()

	ch, err := client.Channel.Create().
		SetType(channel.TypeOpenai).
		SetName(name).
		SetBaseURL(baseURL).
		SetCredentials(objects.ChannelCredentials{APIKey: "test-key-" + name}).
		SetSupportedModels([]string{"gpt-4"}).
		SetDefaultTestModel("gpt-4").
		SetOrderingWeight(50).
		SetStatus(channel.StatusEnabled).
		Save(ctx)
	require.NoError(t, err)

	return ch
}

// createProfileWeightsModel registers a configured model whose association
// matches every enabled channel supporting modelID.
func createProfileWeightsModel(t *testing.T, ctx context.Context, client *ent.Client, modelID string) {
	t.Helper()

	_, err := client.Model.Create().
		SetDeveloper("openai").
		SetModelID(modelID).
		SetName(modelID).
		SetType(model.TypeChat).
		SetGroup("test").
		SetIcon("icon").
		SetModelCard(&objects.ModelCard{}).
		SetSettings(&objects.ModelSettings{
			Associations: []*objects.ModelAssociation{{
				Type:    "model",
				ModelID: &objects.ModelIDAssociation{ModelID: modelID},
			}},
		}).
		SetStatus(model.StatusEnabled).
		Save(ctx)
	require.NoError(t, err)
}

func TestSelectCandidates_IndependentMode_Failover_NeverLeavesProfile(t *testing.T) {
	ctx, client := setupTest(t)

	project := createTestProject(t, ctx, client)
	ctx = contexts.WithProjectID(ctx, project.ID)

	channelA := createProfileWeightsChannel(t, ctx, client, "profile-failover-a", "https://a.profile-failover.test/v1")
	channelB := createProfileWeightsChannel(t, ctx, client, "profile-failover-b", "https://b.profile-failover.test/v1")
	channelC := createProfileWeightsChannel(t, ctx, client, "profile-failover-c", "https://c.profile-failover.test/v1")
	channelD := createProfileWeightsChannel(t, ctx, client, "profile-failover-d", "https://d.profile-failover.test/v1")
	createProfileWeightsModel(t, ctx, client, "gpt-4")

	_, _, systemService, _ := setupTestServices(t, client)

	// Keep the failover assertions deterministic and fast: no retry delay, and a
	// single attempt per channel before switching.
	require.NoError(t, systemService.SetRetryPolicy(ctx, &biz.RetryPolicy{
		Enabled:                 true,
		MaxChannelRetries:       3,
		MaxSingleChannelRetries: 0,
		RetryDelayMs:            0,
		LoadBalancerStrategy:    biz.LoadBalancerStrategyAdaptive,
		TraceStickyMode:         biz.TraceStickyDisabled,
	}))

	channelService := newTestChannelServiceForChannels(client)
	require.Len(t, channelService.GetEnabledChannels(), 4)

	executor := &sequenceExecutor{}
	for range 8 {
		executor.steps = append(executor.steps, executorStep{
			err: &httpclient.Error{StatusCode: 502, Body: []byte(`{"error":{"message":"upstream error"}}`)},
		})
	}

	selector := NewDefaultSelector(channelService, newTestModelService(client), systemService)
	orchestrator := newTestOrchestrator(t, selector, client, executor)

	ctx = contexts.WithAPIKey(ctx, independentWeightsAPIKey(
		[]objects.ProfileChannelWeight{{ChannelID: channelA.ID, Weight: 100}, {ChannelID: channelB.ID, Weight: 50}},
		nil,
		nil,
		nil,
	))

	// When
	startedAt := time.Now()
	_, err := orchestrator.Process(ctx, buildTestRequest("gpt-4", "Hello!", false))
	elapsed := time.Since(startedAt)

	// Then
	require.Error(t, err)
	require.NotEmpty(t, executor.requests)

	baseURLs := map[string]int{}
	for _, request := range executor.requests {
		baseURLs[matchedChannelBaseURL(request.URL, channelA.BaseURL, channelB.BaseURL, channelC.BaseURL, channelD.BaseURL)]++
	}

	t.Logf("observed upstream URLs: %v (elapsed %s)", baseURLs, elapsed)
	require.Len(t, baseURLs, 2)
	require.GreaterOrEqual(t, baseURLs[channelA.BaseURL], 1)
	require.GreaterOrEqual(t, baseURLs[channelB.BaseURL], 1)
}

// matchedChannelBaseURL attributes a recorded request URL to one of the known
// channel base URLs, returning the URL itself when nothing matches so the
// assertion failure shows the unexpected value.
func matchedChannelBaseURL(requestURL string, baseURLs ...string) string {
	for _, baseURL := range baseURLs {
		if strings.HasPrefix(requestURL, baseURL) {
			return baseURL
		}
	}

	return requestURL
}

func TestSelectCandidates_IndependentMode_StickyOutsideProfileIgnored(t *testing.T) {
	trace := &ent.Trace{ID: 10, ThreadID: 20}
	ctx := contexts.WithTrace(context.Background(), trace)

	policy := &mockRetryPolicyProvider{policy: &biz.RetryPolicy{
		Enabled:           true,
		MaxChannelRetries: 2,
		TraceStickyMode:   biz.TraceStickyPreferPreviousChannel,
	}}
	newSelector := func(stickyChannelID int) *LoadBalancedSelector {
		return WithTraceStickyLoadBalancedSelector(
			WithProfileChannelWeightsSelector(&staticChannelSelector{candidates: []*ChannelModelsCandidate{
				profileWeightsCandidate(1, 10),
				profileWeightsCandidate(2, 50),
				profileWeightsCandidate(3, 30),
				profileWeightsCandidate(4, 40),
			}}, map[int]int{1: 100, 2: 50}),
			NewLoadBalancer(policy, nil),
			policy,
			&fakePreviousChannelProvider{traceChannelIDs: map[int]int{trace.ID: stickyChannelID}},
		)
	}

	t.Run("previous channel outside the profile is ignored", func(t *testing.T) {
		// Given: the previous channel is D, which the profile excludes.
		result, err := newSelector(4).Select(ctx, &llm.Request{Model: "gpt-4"})

		// Then
		require.NoError(t, err)
		require.Equal(t, []int{1, 2}, profileWeightsIDs(result))
		for _, candidate := range result {
			require.False(t, candidate.TraceSticky)
		}
	})

	t.Run("previous channel inside the profile is pinned first", func(t *testing.T) {
		// Given: the previous channel is B, which the profile includes.
		result, err := newSelector(2).Select(ctx, &llm.Request{Model: "gpt-4"})

		// Then
		require.NoError(t, err)
		require.Equal(t, []int{2, 1}, profileWeightsIDs(result))
		require.True(t, result[0].TraceSticky)
	})
}
