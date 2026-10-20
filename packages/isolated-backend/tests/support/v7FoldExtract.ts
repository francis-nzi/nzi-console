import type { ExtractRow } from "../../src/v7ReferenceImport";

/**
 * Dedup slice 4: a synthetic v7 extract shaped like J000663's factors (NZC-020 — invented rows; the codes and labels are DESNZ's
 * shapes as staging holds them). Each base sits beside its NZI category copies, at the same value, in one DESNZ GB 2025 dataset,
 * plus every case the fold must leave alone.
 */
const at = (dbId: number, code: string, factor: string, uom: string, scope: string, category: string, columnText: string, reportLabel: string,
  levels: [string, string, string, string] = ["", "", "", ""]): ExtractRow => ({
  db_id: String(dbId), original_id: code, dataset_id: "8", year: "2025", factor, currency: uom === "GBP" ? "GBP" : "",
  valid_from: "2025-01-01", valid_to: "2025-12-31", scope, category, level_1: levels[0], level_2: levels[1], level_3: levels[2], level_4: levels[3],
  column_text: columnText, report_label: reportLabel, uom, ghg_unit: "kgCO2e", method: "Activity", region: "", source: "DESNZ",
});

export const FOLD_EXTRACT: ExtractRow[] = [
  // J000663's commuting: NZI's -c copy of a DESNZ business-travel car — same value (written "0.261870": `numeric`-equal, not
  // string-equal), a different curated label.
  at(501, "25_301_3070_9_1", "0.26187", "miles", "Scope 3", "Business Travel", "Business travel- land - Cars (by size) - Average car - Petrol", "Business Travel: Average Car Petrol", ["Business travel- land", "Cars (by size)", "Average car", "Petrol"]),
  at(502, "25_301_3070_9_1-c", "0.261870", "miles", "Scope 3", "Employee Commuting", "Employee commuting- land - Cars (by size) - Average car - Petrol", "Employee Commuting: Average Car Petrol", ["Employee commuting- land", "Cars (by size)", "Average car", "Petrol"]),
  // J000663's spend variants: the same labels as their base.
  at(503, "SPEND-SIC-49.3-5", "0.57488070034094", "GBP", "Scope 3", "Purchased Goods and Services", "Land transport services", "Spend: Land Transport"),
  at(504, "SPEND-SIC-49.3-5-b", "0.57488070034094", "GBP", "Scope 3", "Business Travel", "Land transport services", "Spend: Land Transport"),
  at(505, "SPEND-SIC-49.3-5-u", "0.57488070034094", "GBP", "Scope 3", "Upstream Transportation and Distribution", "Land transport services", "Spend: Land Transport"),
  at(506, "SPEND-SIC-49.3-5-d", "0.57488070034094", "GBP", "Scope 3", "Downstream Transportation and Distribution", "Land transport services", "Spend: Land Transport"),
  // The DESNZ freight case: one container-ship factor, upstream natively and downstream by its -d copy.
  at(507, "27_320_3235_14_1", "0.01612", "tonne.km", "Scope 3", "Freighting goods", "Freighting goods - Cargo ship - Container ship", "Freight: Container Ship"),
  at(508, "27_320_3235_14_1-d", "0.01612", "tonne.km", "Scope 3", "Downstream Transportation and Distribution", "Freighting goods - Cargo ship - Container ship", "Freight: Container Ship"),
  // A copy with no curated report label: the pair is labelled NULL, never the base's.
  at(509, "SPEND-SIC-49.3-5-p", "0.57488070034094", "GBP", "Scope 3", "Purchased Goods and Services", "Land transport services (purchased)", "NaN"),

  // ── Left alone by the fold ──
  // A Scope 1 company car with a Scope 3 business-travel petrol-car copy (staging's 8 -bcp rows): same value, different scopes.
  at(510, "4_301_3070_4_1", "0.16272", "km", "Scope 1", "Company Vehicles", "Passenger vehicles - Large car - Diesel", "Company Vehicles: Large Car Diesel"),
  at(511, "4_301_3070_4_1-bcp", "0.16272", "km", "Scope 3", "Business Travel", "Business travel - Large car - Diesel", "Business Travel: Large Car Diesel"),
  // A category copy whose base is not in the dataset.
  at(512, "77_700_7000_1_1-b", "0.09", "km", "Scope 3", "Business Travel", "Business travel - Taxi", "Business Travel: Taxi"),
  // Genuinely different numbers carry their own ids — well-to-tank, and the same car per mile — and are no variant of anything.
  at(513, "WTT-25_301_3070_9_1", "0.06181", "miles", "Scope 3", "Fuel- and Energy-Related Activities", "WTT- business travel - Average car - Petrol", "WTT: Average Car Petrol"),
  at(514, "25_301_3070_4_1", "0.16272", "km", "Scope 3", "Business Travel", "Business travel- land - Cars (by size) - Average car - Petrol (km)", "Business Travel: Average Car Petrol (km)"),
];

/** A category copy at a different number from its base: 0170's guard refuses it on either path. Its own dataset (2027). */
export const DIVERGENT_EXTRACT: ExtractRow[] = [
  { ...at(601, "26_400_4000_1_1", "0.5", "km", "Scope 3", "Freighting goods", "Van freight", "Freight: Van"), dataset_id: "9", year: "2027", valid_from: "2027-01-01", valid_to: "2027-12-31" },
  { ...at(602, "26_400_4000_1_1-u", "0.6", "km", "Scope 3", "Upstream Transportation and Distribution", "Van freight", "Freight: Van"), dataset_id: "9", year: "2027", valid_from: "2027-01-01", valid_to: "2027-12-31" },
];

/** The ids the fold takes: every same-value, same-unit, same-scope copy under an active suffix. */
export const FOLDED_IDS = ["uk-ghg-25_301_3070_9_1-c", "uk-ghg-SPEND-SIC-49.3-5-b", "uk-ghg-SPEND-SIC-49.3-5-d", "uk-ghg-SPEND-SIC-49.3-5-p",
  "uk-ghg-SPEND-SIC-49.3-5-u", "uk-ghg-27_320_3235_14_1-d"].sort();
