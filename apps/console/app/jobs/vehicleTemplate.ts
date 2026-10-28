// Data entry D4 (R5) — the Company Vehicles bulk template and its import, pure (BUILD-dataentry-D4-company-vehicles).
//
// Columns (confirmed): Registration (optional), Vehicle name, Type, Size, Fuel, Annual mileage, Unit, Site, and one column per
// reporting month. Named by the universal convention `[job no] · [client name] · [job name] · [file contents] · [reporting year
// from–to]`. On import each vehicle's factor is resolved **by type · size · fuel** from the factor library's own labels — the
// D4 (A) parser — and its unit (miles by default, km, or litres of its fuel). A row with only a registration is resolved by the
// DVLA lookup, as the drawer does; the plate itself goes only to the sealed identifier. Registration is optional: a vehicle can be
// listed by name alone, and an opted-out client's are.
import { normaliseVehicleRegistration, parseVehicleFactorLabel, vehicleUnitOptions, type VehicleType } from "@nzi/contracts";
import { parseDelimited } from "./csvReader";

export const VEHICLE_TEMPLATE_COLUMNS = ["Registration (optional)", "Vehicle name", "Type", "Size", "Fuel", "Annual mileage", "Unit", "Site"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A reporting month ("2025-01") as its column header ("Jan 2025"). */
export const monthHeader = (month: string) => `${MONTHS[Number(month.slice(5, 7)) - 1] ?? month.slice(5, 7)} ${month.slice(0, 4)}`;

export const vehicleTemplateHeaders = (months: readonly string[]) => [...VEHICLE_TEMPLATE_COLUMNS, ...months.map(monthHeader)];

/** A row of headers, ready to fill — no example rows, so nothing invented is ever imported by being left in. */
export const vehicleTemplateCsv = (months: readonly string[]) => vehicleTemplateHeaders(months).map((header) => `"${header}"`).join(",") + "\r\n";

/**
 * The universal template file name: `J000663 · Harbourside Foods Ltd · Carbon Reduction Plan FY2025 · Company Vehicles ·
 * 01-01-2025–31-12-2025.csv`. Characters a file system refuses are dropped; the period is the job's own, as days.
 */
export function templateFileName(parts: { jobNumber: string; clientName: string; jobName: string; contents: string; from: string | null; to: string | null }): string {
  const clean = (value: string) => value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim();
  const day = (iso: string) => iso.split("-").reverse().join("-");
  const period = parts.from && parts.to ? `${day(parts.from)}–${day(parts.to)}` : "period not set";
  return `${[parts.jobNumber, parts.clientName, parts.jobName, parts.contents, period].map(clean).join(" · ")}.csv`;
}

export type VehicleTemplateRow = {
  rowNumber: number; registration: string; name: string; type: string; size: string; fuel: string;
  annual: number | null; unit: string; site: string; monthly: Array<{ month: string; quantity: number | null }>;
};

const number = (raw: string | undefined): number | null => {
  const text = String(raw ?? "").replace(/[,\s£]/g, "");
  if (text === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
};

/** The filled template, row by row; headers matched by name (any order), month columns by "Jan 2025" or "2025-01". */
export function parseVehicleTemplate(text: string, months: readonly string[]): { rows: VehicleTemplateRow[]; missing: string[] } {
  const table = parseDelimited(text);
  const at = (...names: string[]) => table.headers.findIndex((header) => names.some((name) => header.trim().toLowerCase() === name.toLowerCase()));
  const column = {
    registration: at("Registration (optional)", "Registration", "Reg"), name: at("Vehicle name", "Name", "Fleet number"),
    type: at("Type"), size: at("Size"), fuel: at("Fuel"), annual: at("Annual mileage", "Annual"), unit: at("Unit"), site: at("Site"),
  };
  const missing = (["type", "size", "fuel", "unit"] as const).filter((key) => column[key] < 0).map((key) => ({ type: "Type", size: "Size", fuel: "Fuel", unit: "Unit" })[key]);
  const monthColumns = months.map((month) => ({ month, index: at(monthHeader(month), month) }));
  const cell = (row: string[], index: number) => (index >= 0 ? row[index]?.trim() ?? "" : "");
  const rows = table.rows.map((row, position) => ({
    rowNumber: position + 2,
    registration: cell(row, column.registration), name: cell(row, column.name), type: cell(row, column.type), size: cell(row, column.size),
    fuel: cell(row, column.fuel), annual: number(cell(row, column.annual)), unit: cell(row, column.unit), site: cell(row, column.site),
    monthly: monthColumns.map(({ month, index }) => ({ month, quantity: index >= 0 ? number(row[index]) : null })),
  })).filter((row) => [row.registration, row.name, row.type, row.size, row.fuel, row.site].some(Boolean) || row.annual !== null || row.monthly.some((slot) => slot.quantity !== null));
  return { rows, missing };
}

type Option = { id: string; label: string; unit?: string | null };
const TYPES: Record<string, VehicleType> = { car: "car", cars: "car", van: "van", vans: "van", hgv: "hgv", lorry: "hgv", truck: "hgv", motorbike: "motorbike", motorcycle: "motorbike" };
const unitKindOf = (raw: string): "miles" | "km" | "litres" | null => {
  const text = raw.trim().toLowerCase();
  if (text === "" || /^mi(les?)?$/.test(text)) return "miles";
  if (/^(km|kms|kilomet(re|er)s?)$/.test(text)) return "km";
  if (/^(l|litres?|liters?)$/.test(text)) return "litres";
  return null;
};
const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

export type ResolvedVehicleRow = {
  /** The factor the vehicle is priced with, by type · size · fuel and unit; null when nothing matches. */
  option: Option | null;
  /** A row with a registration and no type · size · fuel: resolved by the DVLA lookup, as the drawer does. */
  needsLookup: boolean;
  siteId: string | null;
  quantity: number | null;
  monthly: Array<{ month: string; quantity: number | null }>;
  issues: string[];
};

/** One template row, resolved against the category's factors and the job's sites. Never a guess: what does not match is said. */
export function resolveVehicleTemplateRow(row: VehicleTemplateRow, options: readonly Option[], sites: ReadonlyArray<{ id: string; name: string }>, optedOut: boolean): ResolvedVehicleRow {
  const issues: string[] = [];
  const type = TYPES[row.type.trim().toLowerCase()] ?? null;
  const unit = unitKindOf(row.unit);
  if (!unit) issues.push(`Unit "${row.unit}" is not miles, km or litres.`);
  const hasVehicle = Boolean(row.type || row.size || row.fuel);
  const needsLookup = !hasVehicle && Boolean(row.registration) && !optedOut;
  let option: Option | null = null;
  if (hasVehicle) {
    if (!type) issues.push(`Type "${row.type}" is not a car, van, HGV or motorbike.`);
    const match = options.find((candidate) => { const read = parseVehicleFactorLabel(candidate.label); return read && read.type === type && same(read.size, row.size) && same(read.fuel, row.fuel); });
    const read = match ? parseVehicleFactorLabel(match.label) : null;
    option = read && unit ? vehicleUnitOptions(options, read).find((entry) => entry.kind === unit)?.option ?? null : null;
    if (!match) issues.push(`No factor for ${[row.type, row.size, row.fuel].filter(Boolean).join(" · ") || "this vehicle"} — check the type, size and fuel.`);
    else if (unit && !option) issues.push(`This vehicle is not published in ${unit}.`);
  } else if (!needsLookup) issues.push(optedOut && row.registration ? "This client holds no registrations: give the vehicle's type, size and fuel." : "Give the vehicle's type, size and fuel, or its registration.");
  if (!row.name && !row.registration) issues.push("Give a vehicle name (or its registration) so it can be told apart.");
  if (row.registration && !optedOut && normaliseVehicleRegistration(row.registration).length < 2) issues.push("That registration is too short.");
  const site = row.site ? sites.find((entry) => same(entry.name, row.site)) ?? null : null;
  if (row.site && !site) issues.push(`Site "${row.site}" is not one of this job's sites.`);
  const monthlyTotal = row.monthly.some((slot) => slot.quantity !== null) ? row.monthly.reduce((sum, slot) => sum + (slot.quantity ?? 0), 0) : null;
  const quantity = monthlyTotal ?? row.annual;
  if (quantity === null) issues.push("Give the annual mileage, or the months.");
  else if (quantity < 0) issues.push("The mileage cannot be negative.");
  if (monthlyTotal !== null && row.annual !== null && Math.abs(monthlyTotal - row.annual) > 0.5) issues.push(`The months add up to ${monthlyTotal}, not the annual ${row.annual}: the months are used.`);
  return { option, needsLookup, siteId: site?.id ?? null, quantity, monthly: monthlyTotal !== null ? row.monthly : [], issues };
}

/** A row is importable when it has a factor (or a lookup to find one), a quantity, a way to tell it apart, and no blocking issue. */
export const vehicleRowBlocking = (resolved: ResolvedVehicleRow) => resolved.issues.filter((issue) => !issue.startsWith("The months add up"));
