export const PROFILE_CHANNEL_WEIGHT_MIN = 0;
export const PROFILE_CHANNEL_WEIGHT_MAX = 100;

export interface ProfileChannelWeight {
  channelID: number;
  weight: number;
}

export type ChannelWeightsIssue = 'empty' | 'duplicate' | 'invalidChannel' | 'invalidWeight';

/**
 * Validates independent channel weights. Returns null when valid or when the
 * mode is disabled (inactive lists are preserved but never validated).
 */
export function validateChannelWeights(
  enabled: boolean | null | undefined,
  weights: ProfileChannelWeight[] | null | undefined
): { issue: ChannelWeightsIssue; index?: number } | null {
  if (enabled !== true) {
    return null;
  }

  if (!weights || weights.length === 0) {
    return { issue: 'empty' };
  }

  const seenChannelIDs = new Set<number>();

  for (let index = 0; index < weights.length; index += 1) {
    const { channelID, weight } = weights[index];

    if (!Number.isInteger(channelID) || channelID <= 0) {
      return { issue: 'invalidChannel', index };
    }

    if (!Number.isInteger(weight) || weight < PROFILE_CHANNEL_WEIGHT_MIN || weight > PROFILE_CHANNEL_WEIGHT_MAX) {
      return { issue: 'invalidWeight', index };
    }

    if (seenChannelIDs.has(channelID)) {
      return { issue: 'duplicate', index };
    }

    seenChannelIDs.add(channelID);
  }

  return null;
}
