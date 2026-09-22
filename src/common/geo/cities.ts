/**
 * Geographic base for the matching engine — the user's three location
 * factors (country / province / city) as a 4-tier proximity:
 *   same city > same province > same country > elsewhere
 *
 * Iran's full city→province dataset is generated from the frontend's
 * lacal-data/Iran-provice.ts (src/common/geo/iran.ts — do not hand-edit).
 * Unknown cities (free-text, non-Iran) fall back to city-equality and the
 * country factor. Province was derived at business-write time and stored;
 * for legacy rows it is recomputed here on the fly.
 */

import { IRAN_CITY_PROVINCE } from "./iran";

/** Province of a city — null outside the known Iran dataset. */
export function provinceOf(city: string): string | null {
  return IRAN_CITY_PROVINCE[city] ?? null;
}

export type Proximity = "same-city" | "same-province" | "same-country" | "far";

export interface GeoSpot {
  city: string;
  province?: string | null;
  country?: string | null;
}

/** same city > same province > same country > far */
export function proximity(a: GeoSpot, b: GeoSpot): Proximity {
  if (a.city && a.city === b.city) return "same-city";
  const pa = a.province ?? provinceOf(a.city);
  const pb = b.province ?? provinceOf(b.city);
  if (pa && pb && pa === pb) return "same-province";
  const ca = a.country ?? "IR";
  const cb = b.country ?? "IR";
  if (ca === cb) return "same-country";
  return "far";
}

/**
 * Matching score (0–100):
 *   45 base (same good is a precondition) + proximity bonus + order-size fit.
 */
export function matchScore(
  mine: GeoSpot,
  theirs: GeoSpot,
  myVolume: number,
  theirMinOrder: number
): number {
  const p = proximity(mine, theirs);
  const bonus =
    p === "same-city" ? 38 : p === "same-province" ? 26 : p === "same-country" ? 12 : 4;
  let s = 45 + bonus;
  if (theirMinOrder > 0 && myVolume >= theirMinOrder) s += 9;
  else if (theirMinOrder > myVolume * 2) s -= 7;
  return Math.max(42, Math.min(98, Math.round(s)));
}
