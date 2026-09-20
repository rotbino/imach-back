/**
 * Geographic proximity graph used by the matching engine.
 */

export const CITIES = [
  "تهران",
  "کرج",
  "قم",
  "اصفهان",
  "شیراز",
  "مشهد",
  "تبریز",
  "اردبیل",
  "رشت",
] as const;

const NEIGHBORS: Record<string, readonly string[]> = {
  تهران: ["کرج", "قم"],
  کرج: ["تهران", "قم"],
  قم: ["تهران", "کرج", "اصفهان"],
  اصفهان: ["قم", "شیراز"],
  شیراز: ["اصفهان"],
  مشهد: [],
  تبریز: ["اردبیل"],
  اردبیل: ["تبریز", "رشت"],
  رشت: ["اردبیل"],
};

export type Proximity = "same" | "near" | "far";

export function proximity(a: string, b: string): Proximity {
  if (a === b) return "same";
  if (NEIGHBORS[a]?.includes(b)) return "near";
  return "far";
}

/**
 * Matching score (0–100):
 *   45 base (same good is a precondition) + city proximity bonus + order-size fit.
 */
export function matchScore(
  myCity: string,
  theirCity: string,
  myVolume: number,
  theirMinOrder: number
): number {
  const p = proximity(myCity, theirCity);
  let s = 45 + (p === "same" ? 38 : p === "near" ? 22 : 6);
  if (theirMinOrder > 0 && myVolume >= theirMinOrder) s += 9;
  else if (theirMinOrder > myVolume * 2) s -= 7;
  return Math.max(42, Math.min(98, Math.round(s)));
}
