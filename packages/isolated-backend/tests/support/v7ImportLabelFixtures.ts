import type { V7ImportLabelContext } from "../../src/v7ImportLabel";

/**
 * The label rule's shared fixtures (R-1): the TypeScript mirror is checked against `expected` here, and the SQL in the view
 * set against the TypeScript, row for row, in the real-DB suite. Every value is invented.
 */
const ROW: V7ImportLabelContext = { personLinked: false, factorLabel: null, base: "Fuels", siteId: "11" };
const COMMUTING: V7ImportLabelContext = { personLinked: true, factorLabel: "Average car", base: "Business travel- land", siteId: "11" };

export type LabelFixture = { why: string; value: string | null; allowed: boolean; context: V7ImportLabelContext; expected: string | null };

export const LABEL_FIXTURES: LabelFixture[] = [
  { why: "allow-listed taxonomy text is kept", value: "Natural gas", allowed: true, context: ROW, expected: "Natural gas" },
  { why: "allow-listed, with the spaces btrim takes", value: "  Natural gas ", allowed: true, context: ROW, expected: "  Natural gas " },
  { why: "empty stays empty: the planner's fallbacks fill it", value: null, allowed: false, context: ROW, expected: null },
  { why: "blank stays blank", value: "   ", allowed: false, context: ROW, expected: "   " },
  { why: "free text is replaced, never edited", value: "Diesel — Leeds depot van", allowed: false, context: ROW, expected: "Fuels — site 11" },
  { why: "a plate in free text", value: "Van ZZ12 ABC", allowed: false, context: ROW, expected: "Fuels — site 11" },
  { why: "a titled name in free text", value: "Fuel card Mr Smith", allowed: false, context: ROW, expected: "Fuels — site 11" },
  { why: "no site: the category alone", value: "Leeds depot", allowed: false, context: { ...ROW, siteId: null }, expected: "Fuels" },
  { why: "person-linked: the factor's own text", value: "Commute — J. Example", allowed: false, context: COMMUTING, expected: "Average car" },
  { why: "person-linked, allow-listed text is still kept", value: "Cars (by size)", allowed: true, context: COMMUTING, expected: "Cars (by size)" },
  { why: "person-linked with no factor text: scrubbed", value: "Grey fleet — J. Example", allowed: false, context: { ...COMMUTING, factorLabel: null }, expected: "Business travel- land — site 11" },
  { why: "belt and braces: an allow-listed value with a postcode in it is not kept", value: "Depot EX1 1AA", allowed: true, context: ROW, expected: "Fuels — site 11" },
  { why: "belt and braces: a factor text with an email in it is not used", value: "Commute", allowed: false, context: { ...COMMUTING, factorLabel: "car a@b.example" }, expected: "Business travel- land — site 11" },
  { why: "belt and braces: a site id that reads as an account number leaves the category", value: "Leeds depot", allowed: false, context: { ...ROW, siteId: "12345678" }, expected: "Fuels" },
];

/** Pattern fixtures: value → whether it carries PII. */
export const PII_FIXTURES: Array<{ value: string; pii: boolean }> = [
  { value: "someone@example.invalid", pii: true }, { value: "EX1 1AA", pii: true }, { value: "ex11aa", pii: true }, { value: "ZZ12 ABC", pii: true },
  { value: "A123 BCD", pii: true }, { value: "ABC 123D", pii: true }, { value: "Account 12345678", pii: true }, { value: "Sort 12-34-56", pii: true },
  { value: "Call 01632 960001", pii: true }, { value: "+44 7700 900123", pii: true }, { value: "Dr Example", pii: true },
  { value: "Natural gas", pii: false }, { value: "Cars (by size)", pii: false }, { value: "Electricity: UK", pii: false }, { value: "Scope 3", pii: false },
  { value: "Fuels — site 11", pii: false }, { value: "HGV (all diesel) 3.5 - 7.5 tonnes", pii: false }, { value: "2023", pii: false }, { value: "R-404A", pii: false },
];
