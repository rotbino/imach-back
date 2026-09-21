/**
 * Geographic base for the matching engine:
 *   same city > same province > same country > elsewhere
 * All seeded/demo cities are inside Iran; unknown cities fall back
 * to city-equality only. Country lives on Business ("IR" default).
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
  "همدان",
  "کرمانشاه",
  "ارومیه",
  "قزوین",
  "زنجان",
  "سنندج",
  "یزد",
  "کرمان",
  "اهواز",
] as const;

const CITY_PROVINCE: Record<string, string> = {
  تهران: "تهران",
  کرج: "البرز",
  قم: "قم",
  اصفهان: "اصفهان",
  شیراز: "فارس",
  مشهد: "خراسان رضوی",
  تبریز: "آذربایجان شرقی",
  اردبیل: "اردبیل",
  رشت: "گیلان",
  همدان: "همدان",
  کرمانشاه: "کرمانشاه",
  ارومیه: "آذربایجان غربی",
  قزوین: "قزوین",
  زنجان: "زنجان",
  سنندج: "کردستان",
  یزد: "یزد",
  کرمان: "کرمان",
  اهواز: "خوزستان",
};

/** Province of a city — null for cities outside the known map. */
export function provinceOf(city: string): string | null {
  return CITY_PROVINCE[city] ?? null;
}

export type Proximity = "same" | "near" | "far";

/** same city > same province > elsewhere */
export function proximity(a: string, b: string): Proximity {
  if (a === b) return "same";
  const pa = CITY_PROVINCE[a];
  if (pa && pa === CITY_PROVINCE[b]) return "near";
  return "far";
}

/**
 * Matching score (0–100):
 *   45 base (same good is a precondition) + proximity bonus + order-size fit.
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
