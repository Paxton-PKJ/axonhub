package objects

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestAPIKeyProfile_Clone_ChannelWeights(t *testing.T) {
	original := &APIKeyProfile{
		Name:                      "production",
		IndependentChannelWeights: true,
		ChannelWeights: []ProfileChannelWeight{
			{ChannelID: 1, Weight: 80},
			{ChannelID: 2, Weight: 20},
		},
	}

	clone := original.Clone()
	require.NotSame(t, original, clone)
	require.Equal(t, original.ChannelWeights, clone.ChannelWeights)

	clone.ChannelWeights[0].Weight = 1
	clone.IndependentChannelWeights = false

	require.Equal(t, 80, original.ChannelWeights[0].Weight)
	require.True(t, original.IndependentChannelWeights)
	require.Equal(t, 1, clone.ChannelWeights[0].Weight)

	t.Run("nil list stays nil", func(t *testing.T) {
		cloned := (&APIKeyProfile{Name: "legacy"}).Clone()
		require.Nil(t, cloned.ChannelWeights)
		require.Nil(t, (*APIKeyProfile)(nil).Clone())
	})
}

func TestAPIKeyProfile_ChannelWeightMap(t *testing.T) {
	t.Run("first occurrence wins", func(t *testing.T) {
		profile := &APIKeyProfile{
			ChannelWeights: []ProfileChannelWeight{
				{ChannelID: 7, Weight: 30},
				{ChannelID: 8, Weight: 10},
				{ChannelID: 7, Weight: 90},
			},
		}

		weights := profile.ChannelWeightMap()
		require.Equal(t, map[int]int{7: 30, 8: 10}, weights)
	})

	t.Run("nil profile returns empty non-nil map", func(t *testing.T) {
		weights := (*APIKeyProfile)(nil).ChannelWeightMap()
		require.NotNil(t, weights)
		require.Empty(t, weights)
	})

	t.Run("empty list returns empty non-nil map", func(t *testing.T) {
		weights := (&APIKeyProfile{}).ChannelWeightMap()
		require.NotNil(t, weights)
		require.Empty(t, weights)
	})
}

func TestAPIKeyProfile_UsesIndependentChannelWeights(t *testing.T) {
	require.False(t, (*APIKeyProfile)(nil).UsesIndependentChannelWeights())
	require.False(t, (&APIKeyProfile{}).UsesIndependentChannelWeights())
	require.True(t, (&APIKeyProfile{IndependentChannelWeights: true}).UsesIndependentChannelWeights())
}
