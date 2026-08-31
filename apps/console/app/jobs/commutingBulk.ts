// S1.1 — pure helpers for the Employee Commuting bulk-paste grid (NZC-036).
// Parsing and mode matching are deterministic and side-effect-free so they can be
// unit-tested without a browser. Mirrors the B2 spendLedger parser.

export type CommutingRow = {
  employee: string;
  mode: string;
  distance: number | null;
  distanceUnit: "km" | "mi";
  wfhDaysPerYear: number | null;
  wfhHoursPerDay: number | null;
};

export const COMMUTE_MODES = [
  "Car — petrol", "Car — diesel", "Car — hybrid", "Car — plug-in hybrid", "Car — battery electric",
  "Motorcycle", "Bus", "Rail", "Underground / tram", "Cycle", "Walk",
];

const HEADER_HINTS = ["employee", "name", "staff", "mode", "transport", "method", "distance", "km", "mile", "commute", "wfh", "home", "days", "hours"];
const num = (raw: string): number | null => {
  const cleaned = raw.replace(/[,\s]/g, "").replace(/(km|mi|miles|mile)$/i, "");
  if (cleaned === "" || Number.isNaN(Number(cleaned))) return null;
  return Number(cleaned);
};

function splitRow(row: string): string[] {
  if (row.includes("\t")) return row.split("\t").map((cell) => cell.trim());
  if (row.includes(",")) return row.split(",").map((cell) => cell.trim());
  return row.split(/\s{2,}/).map((cell) => cell.trim());
}

/** Match a free-text mode to one of the controlled COMMUTE_MODES, or null. */
export function matchCommuteMode(raw: string): string | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  const exact = COMMUTE_MODES.find((mode) => mode.toLowerCase() === text);
  if (exact) return exact;
  if (/electric|\bev\b|bev/.test(text) && /car|van/.test(text)) return "Car — battery electric";
  if (/plug/.test(text) && /car|van/.test(text)) return "Car — plug-in hybrid";
  if (/hybrid/.test(text) && /car|van/.test(text)) return "Car — hybrid";
  if (/diesel/.test(text)) return "Car — diesel";
  if (/petrol|gasoline|unleaded/.test(text)) return "Car — petrol";
  if (/\bcar\b|drive|driving/.test(text)) return "Car — petrol";
  if (/motorbike|motorcycle|scooter/.test(text)) return "Motorcycle";
  if (/\bbus\b|coach/.test(text)) return "Bus";
  if (/train|rail/.test(text)) return "Rail";
  if (/tube|underground|metro|tram/.test(text)) return "Underground / tram";
  if (/cycl|bike|bicycle/.test(text)) return "Cycle";
  if (/walk|foot/.test(text)) return "Walk";
  return null;
}

/**
 * Parse pasted commuting rows. Columns may be tab-, comma-, or wide-space-
 * separated. A header row maps columns by name; otherwise the order is
 * employee, mode, distance, distance unit, WFH days/year, WFH hours/day.
 */
export function parseCommutingLedger(text: string): CommutingRow[] {
  const rows = text.split(/\r?\n/).filter((row) => row.trim() !== "");
  if (rows.length === 0) return [];

  const first = splitRow(rows[0]!).map((cell) => cell.toLowerCase());
  const looksLikeHeader = first.filter((cell) => HEADER_HINTS.some((hint) => cell.includes(hint))).length >= 2;

  const index = { employee: 0, mode: 1, distance: 2, unit: 3, wfhDays: 4, wfhHours: 5 };
  if (looksLikeHeader) {
    first.forEach((cell, position) => {
      if (/employ|name|staff/.test(cell)) index.employee = position;
      else if (/mode|transport|method|commute/.test(cell) && !/distance/.test(cell)) index.mode = position;
      else if (/distance|km|mile/.test(cell) && !/unit/.test(cell)) index.distance = position;
      else if (/unit/.test(cell)) index.unit = position;
      else if (/day/.test(cell)) index.wfhDays = position;
      else if (/hour/.test(cell)) index.wfhHours = position;
    });
  }

  return rows
    .slice(looksLikeHeader ? 1 : 0)
    .map((row) => {
      const cells = splitRow(row);
      const unitCell = (cells[index.unit] ?? "").toLowerCase();
      const distanceUnit: "km" | "mi" = /mi|mile/.test(unitCell) || /mi|mile/.test((cells[index.distance] ?? "").toLowerCase()) ? "mi" : "km";
      return {
        employee: cells[index.employee]?.trim() ?? "",
        mode: matchCommuteMode(cells[index.mode] ?? "") ?? (cells[index.mode]?.trim() ?? ""),
        distance: cells[index.distance] !== undefined ? num(cells[index.distance]!) : null,
        distanceUnit,
        wfhDaysPerYear: cells[index.wfhDays] !== undefined ? num(cells[index.wfhDays]!) : null,
        wfhHoursPerDay: cells[index.wfhHours] !== undefined ? num(cells[index.wfhHours]!) : null,
      };
    })
    .filter((line) => line.employee !== "" || line.distance !== null);
}

/** A downloadable .csv template for the domain (no identity block — CSV is import-only, S1.1). */
export function commutingTemplateCsv(): string {
  return [
    "Employee,Commute mode,Distance per year,Distance unit,WFH days per year,WFH hours per day",
    "A. Example,Car — petrol,7500,km,52,7.5",
    "B. Example,Rail,3200,km,104,7.5",
  ].join("\r\n");
}
