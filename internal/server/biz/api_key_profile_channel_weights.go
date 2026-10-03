package biz

import (
	"fmt"

	"github.com/looplj/axonhub/internal/objects"
)

// validateProfileChannelWeights validates the independent channel weight
// configuration of every profile. Profiles with the mode disabled are skipped
// so legacy data and preserved-but-inactive lists never fail validation.
func validateProfileChannelWeights(profiles []objects.APIKeyProfile) error {
	for _, profile := range profiles {
		if !profile.UsesIndependentChannelWeights() {
			continue
		}

		if len(profile.ChannelWeights) == 0 {
			return fmt.Errorf("profile '%s' independent channel weights requires at least one channel", profile.Name)
		}

		seen := make(map[int]bool, len(profile.ChannelWeights))
		for _, cw := range profile.ChannelWeights {
			if cw.ChannelID <= 0 {
				return fmt.Errorf("profile '%s' channelWeights channelID must be positive", profile.Name)
			}

			if seen[cw.ChannelID] {
				return fmt.Errorf("profile '%s' channelWeights contains duplicate channel %d", profile.Name, cw.ChannelID)
			}

			seen[cw.ChannelID] = true

			if cw.Weight < objects.ProfileChannelWeightMin || cw.Weight > objects.ProfileChannelWeightMax {
				return fmt.Errorf(
					"profile '%s' channelWeights weight for channel %d must be between %d and %d",
					profile.Name, cw.ChannelID, objects.ProfileChannelWeightMin, objects.ProfileChannelWeightMax,
				)
			}
		}
	}

	return nil
}
