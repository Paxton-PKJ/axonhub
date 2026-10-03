package openapi_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
)

// updateAPIKeyProfilesQuery selects the full profile shape so a field missing
// from the OpenAPI schema would surface either as a validation error (input) or
// as a missing key in the response (output).
const updateAPIKeyProfilesQuery = `mutation Weighted($id: ID!, $input: UpdateAPIKeyProfilesInput!) {
  updateAPIKeyProfiles(id: $id, input: $input) {
    id
    profiles {
      activeProfile
      profiles {
        name
        independentChannelWeights
        channelWeights { channelID weight }
        channelIDs
        channelTags
      }
    }
  }
}`

type updateProfilesResponse struct {
	Data struct {
		UpdateAPIKeyProfiles struct {
			ID       string `json:"id"`
			Profiles struct {
				ActiveProfile string             `json:"activeProfile"`
				Profiles      []openAPIProfileDL `json:"profiles"`
			} `json:"profiles"`
		} `json:"updateAPIKeyProfiles"`
	} `json:"data"`
	Errors []struct {
		Message string `json:"message"`
	} `json:"errors"`
}

// openAPIProfileDL keeps channelWeights raw so the tests can tell null (field
// absent from the request) apart from an empty list.
type openAPIProfileDL struct {
	Name                      string          `json:"name"`
	IndependentChannelWeights bool            `json:"independentChannelWeights"`
	ChannelWeights            json.RawMessage `json:"channelWeights"`
	ChannelIDs                []int           `json:"channelIDs"`
	ChannelTags               []string        `json:"channelTags"`
}

type channelWeightJSON struct {
	ChannelID int `json:"channelID"`
	Weight    int `json:"weight"`
}

func (p openAPIProfileDL) weights(t *testing.T) []channelWeightJSON {
	t.Helper()

	var weights []channelWeightJSON
	require.NoError(t, json.Unmarshal(p.ChannelWeights, &weights))

	return weights
}

// gqlPostQuery is gqlPost with a caller-supplied document; the quota query in
// openapi_e2e_test.go is hardcoded to apiKeyQuotaUsages.
func gqlPostQuery(t *testing.T, url, bearer, query string, vars map[string]any) (int, []byte) {
	t.Helper()

	payload, err := json.Marshal(map[string]any{"query": query, "variables": vars})
	require.NoError(t, err)

	req, err := http.NewRequest(http.MethodPost, url+"/openapi/v1/graphql", bytes.NewReader(payload))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}

	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)

	return resp.StatusCode, body
}

func updateProfiles(t *testing.T, env e2eEnv, input map[string]any) updateProfilesResponse {
	t.Helper()

	code, body := gqlPostQuery(t, env.server.URL, env.saWriter, updateAPIKeyProfilesQuery, map[string]any{
		"id":    fmt.Sprintf("gid://axonhub/APIKey/%d", env.targetID),
		"input": input,
	})
	t.Logf("HTTP %d body: %s", code, body)
	require.Equal(t, http.StatusOK, code)

	var resp updateProfilesResponse
	require.NoError(t, json.Unmarshal(body, &resp))
	require.Empty(t, resp.Errors, "mutation must succeed")

	return resp
}

// The OpenAPI schema binds APIKeyProfileInput straight to objects.APIKeyProfile,
// so before the fields were declared it silently dropped them and the stored
// profile came back with the mode off. This is the transport-level guard.
func TestE2E_UpdateAPIKeyProfiles_ChannelWeights_RoundTrip(t *testing.T) {
	env := setupE2E(t)

	resp := updateProfiles(t, env, map[string]any{
		"activeProfile": "Weighted",
		"profiles": []any{
			map[string]any{
				"name":                      "Weighted",
				"channelIDs":                []any{env.chanHigh},
				"channelTags":               []any{"canary"},
				"independentChannelWeights": true,
				"channelWeights": []any{
					map[string]any{"channelID": env.chanHigh, "weight": 80},
					map[string]any{"channelID": env.chanLow, "weight": 20},
				},
			},
		},
	})

	require.Equal(t, fmt.Sprintf("gid://axonhub/APIKey/%d", env.targetID), resp.Data.UpdateAPIKeyProfiles.ID)
	require.Equal(t, "Weighted", resp.Data.UpdateAPIKeyProfiles.Profiles.ActiveProfile)
	require.Len(t, resp.Data.UpdateAPIKeyProfiles.Profiles.Profiles, 1)

	got := resp.Data.UpdateAPIKeyProfiles.Profiles.Profiles[0]
	require.Equal(t, "Weighted", got.Name)
	require.True(t, got.IndependentChannelWeights)
	require.Equal(t, []int{env.chanHigh}, got.ChannelIDs)
	require.Equal(t, []string{"canary"}, got.ChannelTags)
	require.Equal(t, []channelWeightJSON{
		{ChannelID: env.chanHigh, Weight: 80},
		{ChannelID: env.chanLow, Weight: 20},
	}, got.weights(t))
}

// The input is a full replacement: a client that does not send the new fields
// turns independent mode off, because objects.APIKeyProfile is decoded from
// scratch on every update. This pins that behavior — it is intended, not a bug:
// the alternative (merge semantics) would make "turn the mode off" inexpressible.
func TestE2E_UpdateAPIKeyProfiles_ChannelWeights_ResetByLegacyInput(t *testing.T) {
	env := setupE2E(t)

	seeded := updateProfiles(t, env, map[string]any{
		"activeProfile": "Weighted",
		"profiles": []any{
			map[string]any{
				"name":                      "Weighted",
				"independentChannelWeights": true,
				"channelWeights": []any{
					map[string]any{"channelID": env.chanHigh, "weight": 80},
					map[string]any{"channelID": env.chanLow, "weight": 20},
				},
			},
		},
	})
	require.True(t, seeded.Data.UpdateAPIKeyProfiles.Profiles.Profiles[0].IndependentChannelWeights,
		"precondition: independent mode is on before the legacy update")

	// Old-style input: neither new field present, exactly what a pre-existing
	// OpenAPI client sends.
	legacy := updateProfiles(t, env, map[string]any{
		"activeProfile": "Weighted",
		"profiles": []any{
			map[string]any{
				"name": "Weighted",
			},
		},
	})

	got := legacy.Data.UpdateAPIKeyProfiles.Profiles.Profiles[0]
	require.False(t, got.IndependentChannelWeights, "omitting the mode must reset it to false")
	require.JSONEq(t, "null", string(got.ChannelWeights), "omitting the weights must clear them")
}
