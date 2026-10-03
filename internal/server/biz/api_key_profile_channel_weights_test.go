package biz

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/looplj/axonhub/internal/objects"
)

func TestValidateProfileChannelWeights(t *testing.T) {
	tests := []struct {
		name        string
		profiles    []objects.APIKeyProfile
		errContains string
	}{
		{
			name:     "no profiles",
			profiles: nil,
		},
		{
			name: "disabled mode ignores dirty data",
			profiles: []objects.APIKeyProfile{
				{
					Name:                      "empty",
					IndependentChannelWeights: false,
				},
				{
					Name:                      "duplicate",
					IndependentChannelWeights: false,
					ChannelWeights: []objects.ProfileChannelWeight{
						{ChannelID: 1, Weight: 10},
						{ChannelID: 1, Weight: 20},
					},
				},
				{
					Name:                      "out of range",
					IndependentChannelWeights: false,
					ChannelWeights: []objects.ProfileChannelWeight{
						{ChannelID: 1, Weight: -1},
						{ChannelID: 2, Weight: 101},
					},
				},
				{
					Name:                      "invalid channel id",
					IndependentChannelWeights: false,
					ChannelWeights: []objects.ProfileChannelWeight{
						{ChannelID: 0, Weight: 50},
					},
				},
			},
		},
		{
			name: "enabled with valid weights",
			profiles: []objects.APIKeyProfile{
				{
					Name:                      "production",
					IndependentChannelWeights: true,
					ChannelWeights: []objects.ProfileChannelWeight{
						{ChannelID: 1, Weight: 100},
						{ChannelID: 2, Weight: 0},
					},
				},
			},
		},
		{
			name: "enabled with empty list",
			profiles: []objects.APIKeyProfile{
				{
					Name:                      "production",
					IndependentChannelWeights: true,
				},
			},
			errContains: "independent channel weights requires at least one channel",
		},
		{
			name: "enabled with nil list",
			profiles: []objects.APIKeyProfile{
				{
					Name:                      "production",
					IndependentChannelWeights: true,
					ChannelWeights:            nil,
				},
			},
			errContains: "independent channel weights requires at least one channel",
		},
		{
			name: "enabled with non-positive channel id",
			profiles: []objects.APIKeyProfile{
				{
					Name:                      "production",
					IndependentChannelWeights: true,
					ChannelWeights: []objects.ProfileChannelWeight{
						{ChannelID: 1, Weight: 50},
						{ChannelID: 0, Weight: 50},
					},
				},
			},
			errContains: "channelWeights channelID must be positive",
		},
		{
			name: "enabled with duplicate channel",
			profiles: []objects.APIKeyProfile{
				{
					Name:                      "production",
					IndependentChannelWeights: true,
					ChannelWeights: []objects.ProfileChannelWeight{
						{ChannelID: 3, Weight: 50},
						{ChannelID: 3, Weight: 60},
					},
				},
			},
			errContains: "channelWeights contains duplicate channel 3",
		},
		{
			name: "enabled with weight below minimum",
			profiles: []objects.APIKeyProfile{
				{
					Name:                      "production",
					IndependentChannelWeights: true,
					ChannelWeights: []objects.ProfileChannelWeight{
						{ChannelID: 1, Weight: -1},
					},
				},
			},
			errContains: "must be between 0 and 100",
		},
		{
			name: "enabled with weight above maximum",
			profiles: []objects.APIKeyProfile{
				{
					Name:                      "production",
					IndependentChannelWeights: true,
					ChannelWeights: []objects.ProfileChannelWeight{
						{ChannelID: 1, Weight: 101},
					},
				},
			},
			errContains: "must be between 0 and 100",
		},
		{
			name: "invalid profile reported by name",
			profiles: []objects.APIKeyProfile{
				{
					Name: "legacy",
				},
				{
					Name:                      "broken",
					IndependentChannelWeights: true,
				},
			},
			errContains: "profile 'broken'",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateProfileChannelWeights(tt.profiles)
			if tt.errContains == "" {
				require.NoError(t, err)
				return
			}

			require.Error(t, err)
			require.Contains(t, err.Error(), tt.errContains)
		})
	}
}
