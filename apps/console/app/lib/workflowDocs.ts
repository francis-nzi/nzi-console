/**
 * The workflow docs the "WF" pills open (BRIEF-console-wf-pills-and-header). They are generic process docs — no client data —
 * served as static files from `public/workflows/<slug>.html`, same-origin. A pill binds to the stored `category_code` (or the scope
 * string for a scope header), never to a display label, so a rename cannot break a link. A code with no entry here has no doc, and
 * its header renders no pill rather than a guessed or broken link.
 */
const CATEGORY_DOCS: Readonly<Record<string, string>> = {
  "1.natural-gas": "WF-1-natural-gas",
  "1.other-stationary-fuels": "WF-1-other-stationary-fuels",
  "1.company-vehicles": "WF-1-company-vehicles",
  "1.refrigerants": "WF-1-refrigerants",
  "2.purchased-electricity": "WF-2-purchased-electricity",
  "2.renewable-electricity": "WF-2-renewable-electricity",
  "3.1": "WF-3.1-purchased-goods-and-services",
  "3.2": "WF-3.2-capital-goods",
  "3.3": "WF-3.3-fuel-and-energy-related",
  "3.4": "WF-3.4-upstream-transport-distribution",
  "3.5": "WF-3.5-waste-in-operations",
  "3.6": "WF-3.6-business-travel",
  "3.7": "WF-3.7-employee-commuting",
  "3.8": "WF-3.8-upstream-leased-assets",
  "3.9": "WF-3.9-downstream-transport-distribution",
  "3.10": "WF-3.10-processing-of-sold-products",
  "3.11": "WF-3.11-use-of-sold-products",
  "3.12": "WF-3.12-end-of-life-sold-products",
  "3.13": "WF-3.13-downstream-leased-assets",
  "3.14": "WF-3.14-franchises",
  "3.15": "WF-3.15-investments",
};
const SCOPE_DOCS: Readonly<Record<string, string>> = { "1": "WF-scope-1-overview", "2": "WF-scope-2-overview", "3": "WF-scope-3-overview" };

const own = (table: Readonly<Record<string, string>>, key: string | null | undefined): string | null =>
  key != null && Object.prototype.hasOwnProperty.call(table, key) ? table[key]! : null;

const hrefOf = (slug: string | null): string | null => (slug === null ? null : `/workflows/${slug}.html`);

/** The doc for a category's stored `category_code`, or null when it has none. */
export const categoryWorkflowHref = (categoryCode: string | null | undefined): string | null => hrefOf(own(CATEGORY_DOCS, categoryCode));
/** The doc for a scope band header ("1" | "2" | "3"), or null when it has none. */
export const scopeWorkflowHref = (scope: string | null | undefined): string | null => hrefOf(own(SCOPE_DOCS, scope));
export const workflowCategoryCodes: readonly string[] = Object.keys(CATEGORY_DOCS);
