import { parseFlatFile, type FlatDocument, type StoredFactor } from "../../src/v7Desnz2019";

/** A small flat file: one real row for each shape the plan must handle (the numbers are the real 2019 ones where the ruling names them). */
const row = (scope: string, l1: string, l2: string, l3: string, l4: string, columnText: string, simple: string, uom: string, ghg: string, value: number | string) =>
  [scope, l1, l2, l3, l4, columnText, simple, uom, ghg, l3, value];
export const FLAT_ROWS: Array<Array<string | number>> = [
  row("Scope 1", "Fuels", "Liquid fuels", "Diesel (average biofuel blend)", "", "Volume", "litres", "litres", "kg CO2e", 2.59411),
  row("Scope 1", "Fuels", "Liquid fuels", "Diesel (average biofuel blend)", "", "Volume", "litres", "litres", "kg CO2", 2.5),
  row("Scope 1", "Fuels", "Gaseous fuels", "Natural gas", "", "Energy - Gross CV", "kWh", "kWh (Gross CV)", "kg CO2e", 0.18385),
  row("Scope 1", "Fuels", "Gaseous fuels", "Natural gas", "", "Energy - Net CV", "kWh", "kWh (Net CV)", "kg CO2e", 0.20428),
  row("Scope 2", "UK electricity", "Electricity generated", "Electricity: UK", "", "", "kWh", "kWh", "kg CO2e", 0.2556),
  row("Scope 3", "Business travel- land", "Rail", "National rail", "", "", "passenger.km", "passenger.km", "kg CO2e", 0.04115),
  row("Scope 3", "Business travel- air", "Flights", "Domestic, to/from UK", "Average passenger", "With RF", "passenger.km", "passenger.km", "kg CO2e", 0.25493),
  row("Scope 3", "Business travel- air", "Flights", "Domestic, to/from UK", "Average passenger", "Without RF", "passenger.km", "passenger.km", "kg CO2e", 0.13483),
  row("Scope 3", "Waste disposal", "Refuse", "Municipal waste", "", "Combustion", "tonnes", "tonnes", "kg CO2e", 21.3538),
  row("Scope 3", "Materials", "Thing", "Twin", "", "Variant A", "kg", "kg", "kg CO2e", 1),
  row("Scope 3", "Materials", "Thing", "Twin", "", "Variant B", "kg", "kg", "kg CO2e", 2),
  row("Scope 3", "Materials", "Thing", "Lubricant", "", "Volume", "litres", "litres", "kg CO2e", ""),
];
export const FLAT_DOC: FlatDocument = {
  source: { file: "conversion-factors-2019-flat-file-v01-02.xls", sheet: "Factors by Category", sha256: "f".repeat(64), sheetDataRows: FLAT_ROWS.length,
    header: ["Scope", "Level 1", "Level 2", "Level 3", "Level 4", "Column Text", "UOM (simple)", "UOM", "GHG", "Lookup", "GHG Conversion Factor 2019"] },
  rows: FLAT_ROWS,
};
export const flatFile = () => parseFlatFile(FLAT_DOC);

const stored = (datasetId: string, factorId: string, label: string, activityUnit: string, value: string, scope: string, sourceLevels: string[], usedRows = 0): StoredFactor =>
  ({ datasetId, factorId, label, activityUnit, value, scopes: [scope], active: true, sourceLevels, usedRows });
export const UK_2019 = "uk-ghg-gb-2019";
/** The stored copy-of-2020 factors, one per shape. */
export const STORED: StoredFactor[] = [
  stored(UK_2019, "uk-ghg-1_101_1011_8_1", "Fuels - Liquid fuels - Diesel (average biofuel blend)", "litres", "2.54603", "1", ["Fuels", "Liquid fuels", "Diesel (average biofuel blend)"], 1),
  stored(UK_2019, "uk-ghg-1_100_1004_6_1", "Fuels - Gaseous fuels - Natural gas — kWh (Gross CV)", "kWh", "0.18387", "1", ["Fuels", "Gaseous fuels", "Natural gas"], 1),
  stored(UK_2019, "uk-ghg-7_400_4000_5_1", "UK electricity - Electricity generated - Electricity: UK - kWh", "kWh", "0.2556", "2", ["UK electricity", "Electricity generated", "Electricity: UK"], 1),
  stored(UK_2019, "uk-ghg-25_315_3147_11_1", "Business travel- land - Rail - National rail", "passenger.km", "0.03694", "3", ["Business travel- land", "Rail", "National rail"], 1),
  stored(UK_2019, "uk-ghg-21_316_3160_11_1", "Business travel- air - Flights - Domestic, to/from UK - Average passenger", "passenger.km", "0.2443", "3", ["Business travel- air", "Flights", "Domestic, to/from UK", "Average passenger"]),
  stored(UK_2019, "uk-ghg-20_507_5283_15_1", "Waste disposal - Refuse - Household residual waste - Incineration with Energy Recovery", "tonnes", "21.3167", "3", ["Waste disposal", "Refuse", "Household residual waste", "Combustion"], 1),
  stored(UK_2019, "uk-ghg-twin", "Materials - Thing - Twin", "kg", "1.5", "3", ["Materials", "Thing", "Twin"]),
  stored(UK_2019, "uk-ghg-lube", "Materials - Thing - Lubricant", "litres", "3", "3", ["Materials", "Thing", "Lubricant"]),
  stored(UK_2019, "uk-ghg-SPEND-SIC-50", "Water transport services", "GBP", "1.68944", "3", ["Water transport services"]),
  stored("nzi-gb-2019", "nzi-99_316_3160_11_2", "Business travel- land - Walking", "miles", "0", "3", ["Business travel- land", "Walking"], 1),
];
