package orchestrator

import (
	"context"

	"github.com/looplj/axonhub/internal/log"
	"github.com/looplj/axonhub/llm"
)

// ProfileChannelWeightsSelector restricts candidates to the channels listed in an
// API key profile's independent channel weights and replaces each candidate's
// channel OrderingWeight with the profile-scoped weight, so the existing load
// balancing strategies score them with the profile's weights instead of the
// global ones. It is a hard boundary: candidates outside the list are dropped
// and nothing downstream (sticky, quota routing, retry) can re-add them.
type ProfileChannelWeightsSelector struct {
	wrapped CandidateSelector
	weights map[int]int // channelID → weight
}

// WithProfileChannelWeightsSelector creates a selector that keeps only the
// channels present in weights and overrides their ordering weight.
func WithProfileChannelWeightsSelector(wrapped CandidateSelector, weights map[int]int) *ProfileChannelWeightsSelector {
	return &ProfileChannelWeightsSelector{
		wrapped: wrapped,
		weights: weights,
	}
}

func (s *ProfileChannelWeightsSelector) Select(ctx context.Context, req *llm.Request) ([]*ChannelModelsCandidate, error) {
	candidates, err := s.wrapped.Select(ctx, req)
	if err != nil {
		return nil, err
	}

	if len(s.weights) == 0 {
		log.Warn(ctx, "independent channel weights enabled with no channels, denying all candidates",
			log.String("model", req.Model))

		return []*ChannelModelsCandidate{}, nil
	}

	filtered := make([]*ChannelModelsCandidate, 0, len(candidates))
	for _, candidate := range candidates {
		if candidate == nil || candidate.Channel == nil {
			continue
		}

		weight, ok := s.weights[candidate.Channel.ID]
		if !ok {
			continue
		}

		withProfileChannelWeight(candidate, weight)

		filtered = append(filtered, candidate)
	}

	return filtered, nil
}

// withProfileChannelWeight swaps the candidate's channel for a shallow copy whose
// OrderingWeight is the profile-scoped weight. The copy keeps every pointer
// (outbounds, HTTP client, caches) of the original so behavior is otherwise
// unchanged; only weight-based scoring observes the override.
func withProfileChannelWeight(c *ChannelModelsCandidate, weight int) {
	if c == nil || c.Channel == nil || c.Channel.Channel == nil {
		return
	}

	entCopy := *c.Channel.Channel
	entCopy.OrderingWeight = weight

	bizCopy := *c.Channel
	bizCopy.Channel = &entCopy

	c.Channel = &bizCopy
}
