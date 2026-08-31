// S1.2 — pure helpers for the Company Vehicles bulk-paste grid (NZC-036 / NZC-037).
// Deterministic and side-effect-free so they can be unit-tested without a browser.
// Mirrors commutingBulk.ts.

export type VehicleRow = {
  registration: string;
  make: string;
  model: string;
  fuel: string;
  activity: number | null;
  activityUnit: string; // litres | km | mi | kWh | kg
};

export const VEHICLE_FUELS = ["Petrol", "Diesel", "Hybrid", "Plug-in hybrid", "Battery electric", "LPG", "CNG", "Hydrogen", "Unknown"];

const HEADER_HINTS = ["reg", "plate", "vehicle", "make", "manufacturer", "model", "fuel", "energy", "mileage", "distance", "litre", "liter", "fuel used", "volume", "kwh", "unit", "amount", "quantity"];
const num = (raw: string): number | null => {
  const cleaned = raw.replace(/[,\s]/g, "").replace(/(l|litres?|liters?|km|mi|miles?|kwh|kg)$/i, "");
  if (cleaned === "" || Number.isNaN(Number(cleaned))) return null;
  return Number(cleaned);
};

function splitRow(row: string): string[] {
  if (row.includes("\t")) return row.split("\t").map((cell) => cell.trim());
  if (row.includes(",")) return row.split(",").map((cell) => cell.trim());
  return row.split(/\s{2,}/).map((cell) => cell.trim());
}

/** Match free-text fuel to one of the controlled VEHICLE_FUELS, or null. */
export function matchFuel(raw: string): string | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  const exact = VEHICLE_FUELS.find((fuel) => fuel.toLowerCase() === text);
  if (exact) return exact;
  if (/plug/.test(text)) return "Plug-in hybrid";
  if (/hybrid/.test(text)) return "Hybrid";
  if (/electric|\bev\b|\bbev\b|battery/.test(text)) return "Battery electric";
  if (/diesel/.test(text)) return "Diesel";
  if (/petrol|gasoline|unleaded/.test(text)) return "Petrol";
  if (/lpg|autogas/.test(text)) return "LPG";
  if (/cng|compressed natural/.test(text)) return "CNG";
  if (/hydrogen|fcev/.test(text)) return "Hydrogen";
  return null;
}

const unitOf = (raw: string): string => {
  const text = raw.trim().toLowerCase();
  if (/litre|liter|\bl\b/.test(text)) return "litres";
  if (/kwh/.test(text)) return "kWh";
  if (/\bkg\b/.test(text)) return "kg";
  if (/mile|\bmi\b/.test(text)) return "mi";
  if (/km/.test(text)) return "km";
  return "";
};

/**
 * Parse pasted vehicle rows. Columns may be tab-, comma-, or wide-space-
 * separated. A header row maps columns by name; otherwise the order is
 * registration, make, model, fuel, activity value, activity unit.
 */
export function parseVehicleLedger(text: string): VehicleRow[] {
  const rows = text.split(/\r?\n/).filter((row) => row.trim() !== "");
  if (rows.length === 0) return [];

  const first = splitRow(rows[0]!).map((cell) => cell.toLowerCase());
  const looksLikeHeader = first.filter((cell) => HEADER_HINTS.some((hint) => cell.includes(hint))).length >= 2;

  const index = { registration: 0, make: 1, model: 2, fuel: 3, activity: 4, unit: 5 };
  if (looksLikeHeader) {
    first.forEach((cell, position) => {
      if (/reg|plate/.test(cell)) index.registration = position;
      else if (/make|manufacturer/.test(cell)) index.make = position;
      else if (/model/.test(cell)) index.model = position;
      else if (/fuel|energy/.test(cell) && !/used|volume|amount|litre|liter/.test(cell)) index.fuel = position;
      else if (/mileage|distance|litre|liter|volume|kwh|amount|quantity|fuel used|energy used/.test(cell) && !/unit/.test(cell)) index.activity = position;
      else if (/unit/.test(cell)) index.unit = position;
    });
  }

  return rows
    .slice(looksLikeHeader ? 1 : 0)
    .map((row) => {
      const cells = splitRow(row);
      return {
        registration: cells[index.registration]?.trim().toUpperCase().replace(/\s+/g, "") ?? "",
        make: cells[index.make]?.trim() ?? "",
        model: cells[index.model]?.trim() ?? "",
        fuel: matchFuel(cells[index.fuel] ?? "") ?? "",
        activity: cells[index.activity] !== undefined ? num(cells[index.activity]!) : null,
        activityUnit: unitOf(cells[index.unit] ?? "") || unitOf(cells[index.activity] ?? "") || "litres",
      };
    })
    .filter((line) => line.registration !== "" || line.activity !== null);
}

/** A downloadable .csv template for the domain (no identity block — CSV is import-only, S1.2). */
export function vehicleTemplateCsv(): string {
  return [
    "Registration,Make,Model,Fuel,Activity per year,Unit",
    "AB12CDE,Ford,Transit,Diesel,3200,litres",
    "FG34HIJ,Nissan,Leaf,Battery electric,9800,kWh",
  ].join("\r\n");
}
