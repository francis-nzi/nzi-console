import { ISO_3166 } from "./iso3166";

/**
 * The country a v7 row belongs to (REFERENCE_DATA_DESIGN §5). v7 names countries in words — "United Kingdom", "Antigua
 * and Barbuda", "Tanzania_United Republic of" — or, for IEA, in the code itself ("Puerto Rico"). The console stores an
 * ISO 3166-1 alpha-2 code, `GLOBAL` for a worldwide dataset, and `ROW` for CEDA's "Rest of World" (kept distinct from
 * GLOBAL so it is never auto-selected beside a job's own country and doubling every code). A name that is not matched is
 * refused, never guessed.
 */

/** Lower-case, "&" → "and", "St." → "saint", underscores and punctuation to spaces, accents folded. */
export const normaliseCountryName = (name: string): string =>
  name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/\bst\.?\s/g, "saint ").replace(/[_,.()'’-]/g, " ").replace(/\s+/g, " ").trim();

/** v7's spellings that the short names do not cover. Extended, not guessed, when a load reports an unknown name. */
const ALIASES: Readonly<Record<string, string>> = {
  uk: "GB", "great britain": "GB", "united kingdom of great britain and northern ireland": "GB",
  usa: "US", us: "US", "united states of america": "US",
  "rest of world": "ROW", "rest of the world": "ROW", global: "GLOBAL", world: "GLOBAL",
  "tanzania united republic of": "TZ", "united republic of tanzania": "TZ",
  "korea republic of": "KR", "republic of korea": "KR", "korea democratic people s republic of": "KP",
  "russian federation": "RU", "iran islamic republic of": "IR", "viet nam": "VN",
  "lao people s democratic republic": "LA", "bolivia plurinational state of": "BO",
  "venezuela bolivarian republic of": "VE", "syrian arab republic": "SY", "moldova republic of": "MD",
  "czech republic": "CZ", macedonia: "MK", "north macedonia": "MK", "the former yugoslav republic of macedonia": "MK",
  turkey: "TR", "cote d ivoire": "CI", "ivory coast": "CI", "congo democratic republic of the": "CD",
  "democratic republic of the congo": "CD", "congo the democratic republic of the": "CD", "republic of the congo": "CG",
  "brunei darussalam": "BN", "micronesia federated states of": "FM", "taiwan province of china": "TW",
  macau: "MO", macao: "MO", "palestine state of": "PS", "cape verde": "CV", "cabo verde": "CV", swaziland: "SZ",
  "hong kong sar china": "HK", "macao sar china": "MO",
  myanmar: "MM", burma: "MM",
  // From the full extract's 151 distinct regions (25 Sep 2026), each checked against the ISO3 in CEDA's file name.
  congo: "CG", "hong kong china": "HK", "lao people s democratic rep": "LA",
  "macedonia the former yugoslav republic of": "MK", "slovak republic": "SK", "chinese taipei": "TW",
  "saint vincent and the grenadines": "VC",
  // IEA names its grid countries in the code; this one is not a region anywhere.
  "taiwan chinese taipei": "TW",
};

const BY_NAME: ReadonlyMap<string, string> = new Map([
  ...ISO_3166.map(([code, name]) => [normaliseCountryName(name), code] as const),
  ...Object.entries(ALIASES),
]);
const CODES: ReadonlySet<string> = new Set(ISO_3166.map(([code]) => code));

/** An ISO code, GLOBAL or ROW for a country named in words or already coded; null when it cannot be matched. */
export function countryCodeFor(nameOrCode: string): string | null {
  const trimmed = nameOrCode.trim();
  if (/^[A-Z]{2}$/.test(trimmed) && CODES.has(trimmed)) return trimmed;
  if (/^(GLOBAL|ROW)$/.test(trimmed)) return trimmed;
  return BY_NAME.get(normaliseCountryName(trimmed)) ?? null;
}
