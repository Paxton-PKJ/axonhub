package gql

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/99designs/gqlgen/graphql/handler"
	"github.com/99designs/gqlgen/graphql/handler/transport"
	"github.com/stretchr/testify/require"

	"github.com/looplj/axonhub/internal/authz"
	"github.com/looplj/axonhub/internal/ent"
	"github.com/looplj/axonhub/internal/ent/apikey"
	"github.com/looplj/axonhub/internal/ent/channel"
	"github.com/looplj/axonhub/internal/ent/enttest"
	"github.com/looplj/axonhub/internal/ent/project"
	"github.com/looplj/axonhub/internal/ent/user"
	"github.com/looplj/axonhub/internal/objects"
	"github.com/looplj/axonhub/internal/pkg/xcache"
	"github.com/looplj/axonhub/internal/server/biz"
)

// setupAdminGraphQL builds the real admin executable schema (the same one the
// production handler serves) over an in-memory ent client, and returns an
// HTTP-level round trip helper. Going through the schema — instead of calling
// resolvers directly — is the point here: a field missing from the .graphql
// input type would be silently dropped before the resolver ever runs.
func setupAdminGraphQL(t *testing.T) (*handler.Server, context.Context, *ent.Client) {
	t.Helper()

	client := enttest.NewEntClient(t, "sqlite3", "file:ent?mode=memory&_fk=1")
	t.Cleanup(func() { _ = client.Close() })

	cacheCfg := xcache.Config{Mode: xcache.ModeMemory}

	projectSvc := &biz.ProjectService{
		ProjectCache: xcache.NewFromConfig[xcache.Entry[ent.Project]](cacheCfg),
	}

	apiKeySvc := biz.NewAPIKeyService(biz.APIKeyServiceParams{
		CacheConfig:    cacheCfg,
		Ent:            client,
		ProjectService: projectSvc,
		KeyPrefix:      "ah",
	})
	t.Cleanup(apiKeySvc.Stop)

	tmplSvc := biz.NewAPIKeyProfileTemplateService(biz.APIKeyProfileTemplateServiceParams{Ent: client})

	schema := NewExecutableSchema(Config{
		Resolvers: &Resolver{
			client:                       client,
			apiKeyService:                apiKeySvc,
			apiKeyProfileTemplateService: tmplSvc,
		},
	})

	srv := handler.New(schema)
	srv.AddTransport(transport.POST{})

	ctx := authz.WithTestBypass(ent.NewContext(context.Background(), client))

	return srv, ctx, client
}

// adminGraphQLPost executes one document against the admin schema and returns
// the decoded wire response, mirroring what the real HTTP endpoint returns.
func adminGraphQLPost(t *testing.T, srv *handler.Server, ctx context.Context, query string, variables map[string]any) graphqlResponse {
	t.Helper()

	payload, err := json.Marshal(map[string]any{"query": query, "variables": variables})
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodPost, "/admin/graphql", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(ctx)

	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, "graphql transport must answer 200: %s", rec.Body.String())

	var resp graphqlResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp), "raw body: %s", rec.Body.String())

	return resp
}

type graphqlResponse struct {
	Data struct {
		UpdateAPIKeyProfiles struct {
			Profiles profileSetJSON `json:"profiles"`
		} `json:"updateAPIKeyProfiles"`
		CreateAPIKeyProfileTemplate struct {
			Name    string       `json:"name"`
			Profile *profileJSON `json:"profile"`
		} `json:"createApiKeyProfileTemplate"`
	} `json:"data"`
	Errors []struct {
		Message string `json:"message"`
	} `json:"errors"`
}

type profileSetJSON struct {
	ActiveProfile string        `json:"activeProfile"`
	Profiles      []profileJSON `json:"profiles"`
}

type profileJSON struct {
	Name                      string   `json:"name"`
	ChannelIDs                []int    `json:"channelIDs"`
	ChannelTags               []string `json:"channelTags"`
	IndependentChannelWeights bool     `json:"independentChannelWeights"`
	ChannelWeights            []struct {
		ChannelID int `json:"channelID"`
		Weight    int `json:"weight"`
	} `json:"channelWeights"`
}

// profileFixture carries a project-scoped API key plus two channels, so both the
// API key profile and the profile template paths can hand out ordering weights.
type profileFixture struct {
	project *ent.Project
	key     *ent.APIKey
	highID  int
	lowID   int
}

func createProfileFixture(t *testing.T, ctx context.Context, client *ent.Client) profileFixture {
	t.Helper()

	hashed, err := biz.HashPassword("test-password")
	require.NoError(t, err)

	owner, err := client.User.Create().
		SetEmail(fmt.Sprintf("owner-%d@example.com", time.Now().UnixNano())).
		SetPassword(hashed).
		SetFirstName("Owner").
		SetLastName("User").
		SetStatus(user.StatusActivated).
		Save(ctx)
	require.NoError(t, err)

	proj, err := client.Project.Create().
		SetName(fmt.Sprintf("project-%d", time.Now().UnixNano())).
		SetStatus(project.StatusActive).
		Save(ctx)
	require.NoError(t, err)

	keyValue, err := biz.GenerateAPIKey("ah")
	require.NoError(t, err)

	key, err := client.APIKey.Create().
		SetName("weights-key").
		SetKey(keyValue).
		SetUserID(owner.ID).
		SetProjectID(proj.ID).
		SetType(apikey.TypeUser).
		SetProfiles(&objects.APIKeyProfiles{
			ActiveProfile: "Default",
			Profiles:      []objects.APIKeyProfile{{Name: "Default"}},
		}).
		Save(ctx)
	require.NoError(t, err)

	newChannel := func(name string) int {
		t.Helper()

		ch, err := client.Channel.Create().
			SetType(channel.TypeOpenai).
			SetName(name).
			SetCredentials(objects.ChannelCredentials{APIKey: "key-" + name}).
			SetSupportedModels([]string{"gpt-4"}).
			SetDefaultTestModel("gpt-4").
			SetStatus(channel.StatusEnabled).
			Save(ctx)
		require.NoError(t, err)

		return ch.ID
	}

	return profileFixture{
		project: proj,
		key:     key,
		highID:  newChannel("high-priority"),
		lowID:   newChannel("low-priority"),
	}
}

const updateAPIKeyProfilesQuery = `mutation UpdateProfileChannelWeights($id: ID!, $input: UpdateAPIKeyProfilesInput!) {
  updateAPIKeyProfiles(id: $id, input: $input) {
    profiles {
      activeProfile
      profiles {
        name
        channelIDs
        channelTags
        independentChannelWeights
        channelWeights { channelID weight }
      }
    }
  }
}`

// The admin schema binds APIKeyProfileInput straight to objects.APIKeyProfile,
// so a field absent from the .graphql input is dropped by gqlgen and the stored
// profile comes back with independentChannelWeights=false. This exercises the
// whole chain: document -> executor -> resolver -> ent -> document.
func TestUpdateAPIKeyProfiles_ChannelWeights_RoundTrip(t *testing.T) {
	srv, ctx, client := setupAdminGraphQL(t)

	fx := createProfileFixture(t, ctx, client)

	resp := adminGraphQLPost(t, srv, ctx, updateAPIKeyProfilesQuery, map[string]any{
		"id": fmt.Sprintf("gid://axonhub/APIKey/%d", fx.key.ID),
		"input": map[string]any{
			"activeProfile": "Production",
			"profiles": []any{
				map[string]any{
					"name":                      "Production",
					"channelIDs":                []any{fx.highID},
					"channelTags":               []any{"canary"},
					"independentChannelWeights": true,
					"channelWeights": []any{
						map[string]any{"channelID": fx.highID, "weight": 80},
						map[string]any{"channelID": fx.lowID, "weight": 20},
					},
				},
			},
		},
	})

	require.Empty(t, resp.Errors, "mutation must succeed")
	require.Equal(t, "Production", resp.Data.UpdateAPIKeyProfiles.Profiles.ActiveProfile)
	require.Len(t, resp.Data.UpdateAPIKeyProfiles.Profiles.Profiles, 1)

	got := resp.Data.UpdateAPIKeyProfiles.Profiles.Profiles[0]
	require.Equal(t, "Production", got.Name)
	require.True(t, got.IndependentChannelWeights, "independent mode must survive the round trip")
	require.Equal(t, []int{fx.highID}, got.ChannelIDs, "legacy filters are preserved alongside the weights")
	require.Equal(t, []string{"canary"}, got.ChannelTags)
	require.Len(t, got.ChannelWeights, 2)
	require.Equal(t, fx.highID, got.ChannelWeights[0].ChannelID)
	require.Equal(t, 80, got.ChannelWeights[0].Weight)
	require.Equal(t, fx.lowID, got.ChannelWeights[1].ChannelID)
	require.Equal(t, 20, got.ChannelWeights[1].Weight)
}

func TestUpdateAPIKeyProfiles_ChannelWeights_ValidationError(t *testing.T) {
	srv, ctx, client := setupAdminGraphQL(t)

	fx := createProfileFixture(t, ctx, client)

	resp := adminGraphQLPost(t, srv, ctx, updateAPIKeyProfilesQuery, map[string]any{
		"id": fmt.Sprintf("gid://axonhub/APIKey/%d", fx.key.ID),
		"input": map[string]any{
			"activeProfile": "Default",
			"profiles": []any{
				map[string]any{
					"name":                      "Default",
					"independentChannelWeights": true,
					"channelWeights":            []any{},
				},
			},
		},
	})

	require.NotEmpty(t, resp.Errors, "empty weights in independent mode must be rejected")
	require.Contains(t, resp.Errors[0].Message, "independent channel weights requires at least one channel")

	// The rejected input must not have been persisted.
	stored, err := client.APIKey.Get(ctx, fx.key.ID)
	require.NoError(t, err)
	require.False(t, stored.Profiles.Profiles[0].IndependentChannelWeights)
}
