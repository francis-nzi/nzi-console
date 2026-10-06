// Dataset currency (ruled 6 Oct, DATASET-CURRENCY-kickoff §1) — where an emission-factor dataset comes from, said once.
//
// A dataset belongs to a **series**: one source family in one country, published as yearly editions. The reference load
// mints every edition's id as `<family>-<country>-<year>` (REFERENCE_DATA_DESIGN; v7ReferenceImport's slug), with a
// `-original` / `-edition-<n>` tail when two v7 uploads of a year were kept apart. So the series is the id without its
// edition tail, and the family is the id's registered prefix. Nothing here reads a dataset's imported `name`: those are
// upload file names (`tmpai4mgnde.csv`; the 2019–2025 DESNZ and NZI sets share one).
//
// Which source is **preferred** is a property of this registry — read by the automatic selection's ordering and by the
// factor picker — never a string check where it is used. DESNZ is primary for the UK (Francis: "primary, others still
// selected"): every country-specific edition stays selected; the preferred one is ordered first and pre-picked on a tie.

export type DatasetSource = {
  /** The id prefix the reference load gives this family's editions. */
  family: string;
  /** How a person knows the source — the label shown wherever a dataset is named. */
  label: string;
  /** Countries for which this source is the preferred one, where several are selected. */
  preferredFor: readonly string[];
};

export const DATASET_SOURCES: readonly DatasetSource[] = [
  { family: "uk-ghg", label: "DESNZ", preferredFor: ["GB"] },
  { family: "nzi", label: "NZI", preferredFor: [] },
  { family: "ceda", label: "CEDA", preferredFor: [] },
  { family: "ice", label: "ICE", preferredFor: [] },
  { family: "iea", label: "IEA", preferredFor: [] },
  { family: "swc", label: "Small World Consulting", preferredFor: [] },
];

/**
 * An edition's tail on its id: the year, and the reference load's `-original` / `-edition-<n>` when two uploads of a year
 * were kept apart. One pattern, used by the selection SQL (`regexp_replace`) and here, so the two cannot disagree.
 */
export const DATASET_EDITION_SUFFIX = "-[0-9]{4}(-(original|edition-.+))?$";
const EDITION_SUFFIX = new RegExp(DATASET_EDITION_SUFFIX);

/** The series an edition belongs to: its id without the edition tail (`uk-ghg-gb-2025` → `uk-ghg-gb`). */
export const datasetSeriesKey = (datasetId: string): string => datasetId.replace(EDITION_SUFFIX, "");

/** The registered source of a dataset, from its id's family prefix — longest prefix first — or null if none is registered. */
export function datasetSourceOf(datasetId: string): DatasetSource | null {
  const matches = DATASET_SOURCES.filter((source) => datasetId.startsWith(`${source.family}-`));
  return matches.sort((a, b) => b.family.length - a.family.length)[0] ?? null;
}

/** Whether a dataset is the preferred source for a job of this country (DESNZ for GB). */
export const isPreferredDataset = (datasetId: string | null, countryCode: string): boolean =>
  datasetId !== null && (datasetSourceOf(datasetId)?.preferredFor.includes(countryCode) ?? false);

/** Sort key: the preferred source first, then the other registered sources in registry order, then anything else. */
export function datasetPreferenceRank(datasetId: string | null, countryCode: string): number {
  if (datasetId === null) return DATASET_SOURCES.length + 1;
  if (isPreferredDataset(datasetId, countryCode)) return 0;
  const source = datasetSourceOf(datasetId);
  return source ? 1 + DATASET_SOURCES.indexOf(source) : DATASET_SOURCES.length + 1;
}
