import { calculateRelativeWeight, clampOrderingWeight } from '../../channels/utils/ordering-weight';
import type { ProfileChannelWeight } from './channel-weights';

/** Same semantics as @dnd-kit/sortable's arrayMove, kept local so this module stays dependency free. */
function moveItem<T>(items: T[], from: number, to: number): T[] {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Stable sort by weight DESC (JS sort is stable). Returns a new array. */
export function sortChannelWeights(list: ProfileChannelWeight[]): ProfileChannelWeight[] {
  return [...list].sort((a, b) => b.weight - a.weight);
}

/** Move item from→to, then recompute the moved item's weight from its new neighbours
 *  with calculateRelativeWeight (same as the channel bulk ordering dialog). */
export function moveChannelWeight(list: ProfileChannelWeight[], from: number, to: number): ProfileChannelWeight[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) {
    return [...list];
  }

  const next = moveItem(list, from, to);
  const prevWeight = next[to - 1]?.weight;
  const nextWeight = next[to + 1]?.weight;

  next[to] = { ...next[to], weight: calculateRelativeWeight(prevWeight, nextWeight) };

  return next;
}

/** Set weight (clamped) for channelID, then sortChannelWeights. */
export function setChannelWeight(list: ProfileChannelWeight[], channelID: number, weight: number): ProfileChannelWeight[] {
  const clampedWeight = clampOrderingWeight(weight);
  const next = list.map((item) => (item.channelID === channelID ? { ...item, weight: clampedWeight } : item));

  return sortChannelWeights(next);
}

/** Append channelID with the given default weight (clamped), then sort. No-op if already present. */
export function addChannelWeight(list: ProfileChannelWeight[], channelID: number, defaultWeight: number): ProfileChannelWeight[] {
  if (list.some((item) => item.channelID === channelID)) {
    return [...list];
  }

  return sortChannelWeights([...list, { channelID, weight: clampOrderingWeight(defaultWeight) }]);
}

export function removeChannelWeight(list: ProfileChannelWeight[], channelID: number): ProfileChannelWeight[] {
  return list.filter((item) => item.channelID !== channelID);
}

/** Seed list used when the switch is turned on with an empty list: the given channel IDs
 *  with their global ordering weights (unknown channels get 0), sorted. */
export function seedChannelWeights(channelIDs: number[], globalWeightOf: (id: number) => number | undefined): ProfileChannelWeight[] {
  const seeded = channelIDs.map((channelID) => ({
    channelID,
    weight: clampOrderingWeight(globalWeightOf(channelID) ?? 0),
  }));

  return sortChannelWeights(seeded);
}
