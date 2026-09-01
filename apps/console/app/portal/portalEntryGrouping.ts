// UX1d — grouping the client's authorised data-entry buckets into the
// scope→category accordion (NZC-046 / DATA_ENTRY_UX.md §1, §5). The portal is a
// constrained mirror: it shows only the categories the client's bucket grants
// authorise, never the full 15. Pure — the component renders these sections.
import { emissionCategoryTaxonomy, scopeMeta, type EmissionCategory, type EmissionCategoryKind } from "@nzi/contracts";

export type PortalBucket = {
  bucketGrantId: string;
  scopeRowId: string;
  scope: string;
  categoryCode: string | null;
  sourceLabel: string;
  entryKind: "manual_activity" | "spend" | "commuting" | "vehicle";
  factors: Array<{ id: string; label: string; unit: string }>;
  sites: Array<{ id: string; name: string }>;
  units: string[];
  pgsCategories: Array<{ id: string; name: string }>;
};

export type PortalAccordionSection = {
  code: string;
  name: string;
  scope: "1" | "2" | "3";
  kind: EmissionCategoryKind;
  /** The category the shared `EmissionEntryForm` renders against. */
  category: EmissionCategory;
  buckets: PortalBucket[];
  spendBuckets: PortalBucket[];
  otherBuckets: PortalBucket[];
};

const TAXONOMY = new Map(emissionCategoryTaxonomy.map(category => [category.code, category]));
const TAXONOMY_ORDER = new Map(emissionCategoryTaxonomy.map((category, index) => [category.code, index]));

/** The category a bucket belongs to — its scope row's stamped code, else its scope string. */
export function portalBucketCode(bucket: PortalBucket): string {
  const code = (bucket.categoryCode && bucket.categoryCode.trim()) || bucket.scope;
  return TAXONOMY.has(code) ? code : bucket.scope.split(".")[0] || bucket.scope;
}

const kindFor = (buckets: PortalBucket[]): EmissionCategoryKind => {
  if (buckets.some(bucket => bucket.entryKind === "spend")) return "spend";
  if (buckets.some(bucket => bucket.entryKind === "vehicle")) return "vehicle";
  if (buckets.some(bucket => bucket.entryKind === "commuting")) return "commuting";
  return "manual";
};

export function buildPortalDataEntryAccordion(buckets: PortalBucket[]): PortalAccordionSection[] {
  const byCode = new Map<string, PortalBucket[]>();
  for (const bucket of buckets) {
    const code = portalBucketCode(bucket);
    const list = byCode.get(code);
    if (list) list.push(bucket);
    else byCode.set(code, [bucket]);
  }

  const sections = [...byCode.entries()].map<PortalAccordionSection>(([code, list]) => {
    const taxonomy = TAXONOMY.get(code);
    const scope = (taxonomy?.scope ?? ((code.split(".")[0] as "1" | "2" | "3") || "3"));
    const name = taxonomy?.name ?? `${scopeMeta[scope]?.label ?? `Scope ${scope}`} — authorised`;
    const kind = taxonomy?.kind ?? kindFor(list);
    return {
      code,
      name,
      scope,
      kind,
      category: taxonomy ?? { scope, code, name, kind },
      buckets: list,
      spendBuckets: list.filter(bucket => bucket.entryKind === "spend"),
      otherBuckets: list.filter(bucket => bucket.entryKind !== "spend"),
    };
  });

  const rank = (section: PortalAccordionSection) => TAXONOMY_ORDER.get(section.code) ?? 1000 + Number(section.scope);
  return sections.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
