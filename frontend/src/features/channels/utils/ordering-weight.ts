export const ORDERING_WEIGHT_MIN = 0;
export const ORDERING_WEIGHT_MAX = 100;

export function parseOrderingWeightInput(rawValue: string, min: number, max: number): number | null {
  if (rawValue.trim() === '') {
    return null;
  }

  const value = Number(rawValue);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    return null;
  }

  return value;
}

export function clampOrderingWeight(value: number): number {
  return Math.round(Math.min(ORDERING_WEIGHT_MAX, Math.max(ORDERING_WEIGHT_MIN, value)));
}

export function calculateRelativeWeight(prev?: number, next?: number): number {
  if (prev == null && next == null) {
    return clampOrderingWeight(1);
  }
  if (prev == null) {
    return clampOrderingWeight((next ?? 0) + 1);
  }
  if (next == null) {
    return clampOrderingWeight(prev - 1);
  }
  if (prev === next) {
    return clampOrderingWeight(prev);
  }
  return clampOrderingWeight(Math.floor((prev + next) / 2));
}
