// Data entry D5 (R6) — the Business Travel bulk template and its import, pure (BUILD-dataentry-D5-business-travel).
//
// Columns as ruled — Mode · From · To · Distance · Unit · Nights · Spend · Passengers · Date · Site — then the three a trip needs to be
// priced without a guess: Haul (air) and Cabin class (air) for a flight (R3), and Registration (grey fleet), which goes to the
// lookup and nowhere else (R5). Headers only — no example rows (D4 R5's discipline); named by the universal convention.
//
// Each row is resolved by its mode (+ haul and class for air) against the job's own factors, never guessed: a mode with several
// factors takes the library's "average" one where there is exactly one, else the row says so. Trips are filed as Scope 3.6 travel
// sources, grouped by mode and factor — one roll-up row each, composing the category's total (ruled 28 Oct).
import {
  AIR_HAULS, airFactorFor, isCurrencyUnit, matchCabinClass, matchTravelMode, readTravelFactorLabel, travelFactorsForMode, travelModeDef, travelModeLabel,
  utcDay, type AirHaul, type CabinClass, type TravelModeValue,
} from "@nzi/contracts";
import { parseDelimited } from "./csvReader";

export const TRAVEL_TEMPLATE_COLUMNS = ["Mode", "From", "To", "Distance", "Unit", "Nights", "Spend", "Passengers", "Date", "Site", "Haul (air)", "Cabin class (air)", "Registration (grey fleet)"] as const;

/** A row of headers, ready to fill — no example rows, so nothing invented is ever imported by being left in. */
export const travelTemplateCsv = () => TRAVEL_TEMPLATE_COLUMNS.map((header) => `"${header}"`).join(",") + "\r\n";

export type TravelTemplateRow = {
  rowNumber: number; mode: string; from: string; to: string; distance: number | null; unit: string; nights: number | null; spend: number | null;
  passengers: number | null; date: string; site: string; haul: string; cabinClass: string; registration: string;
};

const number = (raw: string | undefined): number | null => {
  const text = String(raw ?? "").replace(/[,\s£€$]/g, "");
  if (text === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
};

/** The filled template, row by row; headers matched by name, in any order. A file without a Mode column is not the template. */
export function parseTravelTemplate(text: string): { rows: TravelTemplateRow[]; missing: string[] } {
  const table = parseDelimited(text);
  const at = (...names: string[]) => table.headers.findIndex((header) => names.some((name) => header.trim().toLowerCase() === name.toLowerCase()));
  const column = {
    mode: at("Mode"), from: at("From"), to: at("To"), distance: at("Distance"), unit: at("Unit"), nights: at("Nights"), spend: at("Spend"),
    passengers: at("Passengers"), date: at("Date"), site: at("Site"), haul: at("Haul (air)", "Haul"), cabinClass: at("Cabin class (air)", "Cabin class", "Class"),
    registration: at("Registration (grey fleet)", "Registration"),
  };
  const missing = (["mode", "distance", "nights", "spend"] as const).filter((key) => column[key] < 0).map((key) => ({ mode: "Mode", distance: "Distance", nights: "Nights", spend: "Spend" })[key]);
  const cell = (row: string[], index: number) => (index >= 0 ? row[index]?.trim() ?? "" : "");
  const rows = table.rows.map((row, position) => ({
    rowNumber: position + 2, mode: cell(row, column.mode), from: cell(row, column.from), to: cell(row, column.to), distance: number(cell(row, column.distance)),
    unit: cell(row, column.unit), nights: number(cell(row, column.nights)), spend: number(cell(row, column.spend)), passengers: number(cell(row, column.passengers)),
    date: cell(row, column.date), site: cell(row, column.site), haul: cell(row, column.haul), cabinClass: cell(row, column.cabinClass), registration: cell(row, column.registration),
  })).filter((row) => [row.mode, row.from, row.to, row.site, row.haul, row.cabinClass, row.registration, row.date].some(Boolean) || [row.distance, row.nights, row.spend].some((value) => value !== null));
  return { rows, missing };
}

type Option = { id: string; label: string; unit?: string | null };
export type ResolvedTravelRow = {
  mode: TravelModeValue | null; haul: AirHaul | null; cabinClass: CabinClass | null;
  /** The factor the trip is priced with; null when nothing matches (or the lookup has yet to find it). */
  option: Option | null;
  basis: "distance" | "nights" | "spend";
  /** In the factor's unit — distance converted, × passengers where the factor is per passenger. */
  quantity: number | null;
  /** A grey-fleet row with a registration: resolved by the vehicle lookup, as the drawer does. The plate is the lookup's alone. */
  needsLookup: boolean;
  siteId: string | null; tripDate: string | null;
  /** What stops the row. */
  issues: string[];
  /** What was done to the figure, said — never blocking. */
  notes: string[];
};

const KM_PER_MILE = 1.609344;
const distanceKind = (unit: string | null | undefined): "km" | "miles" | null => {
  const text = (unit ?? "").trim().toLowerCase();
  if (/mile|^mi$/.test(text)) return "miles";
  if (/km|kilomet/.test(text)) return "km";
  return null;
};
const haulOf = (raw: string): AirHaul | null => {
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  return AIR_HAULS.find((entry) => entry.label.toLowerCase() === text || entry.value === text)?.value
    ?? (/long/.test(text) ? "long-haul" : /short/.test(text) ? "short-haul" : /domestic/.test(text) ? "domestic" : /international|non-uk/.test(text) ? "international" : null);
};
const isoDate = (raw: string): string | null => {
  const text = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const uk = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  const [y, m, d] = iso ? [iso[1]!, iso[2]!, iso[3]!] : uk ? [uk[3]!, uk[2]!.padStart(2, "0"), uk[1]!.padStart(2, "0")] : [];
  if (!y) return null;
  const date = new Date(`${y}-${m}-${d}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || utcDay(date) !== `${y}-${m}-${d}` ? null : `${y}-${m}-${d}`;
};

/** Several factors for a mode: the library's one "average" factor where it has exactly one — else none, and the row says so. */
function oneFactor<T extends Option>(candidates: readonly T[]): T | "several" | null {
  if (candidates.length <= 1) return candidates[0] ?? null;
  const average = candidates.filter((option) => /\baverage\b/i.test(option.label));
  return average.length === 1 ? average[0]! : "several";
}

/** One template row, resolved against the category's factors and the job's sites. Never a guess: what does not match is said. */
export function resolveTravelTemplateRow(row: TravelTemplateRow, options: readonly Option[], sites: ReadonlyArray<{ id: string; name: string }>,
  /** Grey fleet, once the lookup has named the car: its factor. */ lookedUp?: Option | null): ResolvedTravelRow {
  const issues: string[] = [], notes: string[] = [];
  const matched = matchTravelMode(row.mode);
  const mode = matched?.mode ?? null;
  const def = travelModeDef(mode);
  if (!row.mode) issues.push("Give the trip's mode.");
  else if (!mode) issues.push(`Mode "${row.mode}" is not one of the travel modes.`);
  const haul = mode === "air" ? haulOf(row.haul) ?? matched?.haul ?? null : null;
  const cabinClass = mode === "air" ? matchCabinClass(row.cabinClass) : null;
  const spendOnly = row.spend !== null && row.distance === null && row.nights === null;
  const basis: ResolvedTravelRow["basis"] = spendOnly ? "spend" : def?.basis ?? "distance";
  const activity = options.filter((option) => !isCurrencyUnit(option.unit ?? undefined));
  let option: Option | null = null, quantity: number | null = null, needsLookup = false;
  if (mode && basis === "spend") {
    // R4: spend is the fallback where only the cost is known — priced by the job's business-travel spend factor.
    const spendFactors = options.filter((candidate) => isCurrencyUnit(candidate.unit ?? undefined) && /travel|air|flight|hotel|rail|taxi/i.test(candidate.label));
    const wanted = def?.group === "air" ? /air|flight/i : def?.group === "hotel" ? /hotel|accommodation/i : def?.group === "rail" ? /rail|train/i : null;
    const narrowed = spendFactors.length > 1 && wanted ? spendFactors.filter((candidate) => wanted.test(candidate.label)) : spendFactors;
    const picked = oneFactor(narrowed);
    if (picked === "several") issues.push("Several business-travel spend factors — enter this trip in the drawer to choose one.");
    else if (!picked) issues.push("No business-travel spend factor is in this job's datasets.");
    else { option = picked; quantity = row.spend; notes.push(`Spend, in ${picked.unit}.`); }
  } else if (mode === "air") {
    if (!haul) issues.push("Say the flight's haul: domestic, short haul, long haul or international.");
    if (!cabinClass) issues.push("Say the flight's cabin class.");
    if (haul && cabinClass) {
      option = airFactorFor(activity, haul, cabinClass);
      if (!option) issues.push(`No factor for ${travelModeLabel({ travelMode: "air", airHaul: haul, cabinClass })} in this job's datasets.`);
    }
  } else if (mode === "grey-fleet") {
    // R5: a personal car is found by its registration — looked up, never kept — or entered by fuel as a car mode.
    if (lookedUp) option = lookedUp;
    else if (row.registration) needsLookup = true;
    else issues.push("Grey fleet needs the car's registration (looked up, never kept) — or give the car's mode by fuel (Car — diesel…).");
  } else if (mode) {
    let candidates = travelFactorsForMode(activity, mode);
    // A hotel stay is priced by its country where the library publishes several: the To column names it.
    if (mode === "hotel" && candidates.length > 1 && row.to) {
      const country = candidates.filter((candidate) => candidate.label.toLowerCase().includes(row.to.trim().toLowerCase()));
      if (country.length) candidates = country;
    }
    const picked = oneFactor(candidates);
    if (picked === "several") issues.push(`Several ${def!.label} factors — enter this trip in the drawer to choose one.`);
    else if (!picked) issues.push(`No ${def!.label} factor is in this job's datasets.`);
    else option = picked;
  }
  // The figure, in the factor's unit.
  if (basis === "nights") {
    if (row.nights === null) issues.push("Give the number of nights.");
    else if (row.nights < 0) issues.push("Nights cannot be negative.");
    else quantity = row.nights;
  } else if (basis === "distance") {
    const given = distanceKind(row.unit || "km");
    if (!given) issues.push(`Unit "${row.unit}" is not km or miles.`);
    if (row.distance === null) issues.push("Give the distance (or the spend, where only the cost is known).");
    else if (row.distance < 0) issues.push("The distance cannot be negative.");
    else if (given) {
      const factorUnit = option?.unit ?? null, wanted = distanceKind(factorUnit) ?? given;
      let value = row.distance;
      if (wanted !== given) { value = given === "miles" ? value * KM_PER_MILE : value / KM_PER_MILE; notes.push(`Converted from ${given} to ${wanted}.`); }
      const passengers = row.passengers ?? 1;
      if (/passenger/i.test(factorUnit ?? "") && passengers !== 1) { value *= passengers; notes.push(`× ${passengers} passengers.`); }
      quantity = Math.round(value * 1000) / 1000;
    }
  }
  if (row.passengers !== null && (row.passengers < 1 || !Number.isInteger(row.passengers))) issues.push("Passengers is a whole number, one or more.");
  const site = row.site ? sites.find((entry) => entry.name.trim().toLowerCase() === row.site.trim().toLowerCase()) ?? null : null;
  if (row.site && !site) issues.push(`Site "${row.site}" is not one of this job's sites.`);
  const tripDate = row.date ? isoDate(row.date) : null;
  if (row.date && !tripDate) issues.push(`Date "${row.date}" is not a date (YYYY-MM-DD or DD/MM/YYYY).`);
  return { mode, haul, cabinClass, option, basis, quantity, needsLookup, siteId: site?.id ?? null, tripDate, issues, notes };
}

/** A grey-fleet row's car, once the lookup has named it: the job's business-travel car factor of the same size and fuel. */
export function greyFleetFactorFor<T extends Option>(options: readonly T[], lookedUpLabel: string): T | null {
  const read = readTravelFactorLabel(lookedUpLabel);
  if (!read?.car) return null;
  const size = lookedUpLabel.split(/\s+-\s+/).slice(-2, -1)[0]?.trim().toLowerCase();
  const cars = travelFactorsForMode(options, "grey-fleet").filter((option) => readTravelFactorLabel(option.label)?.mode === read.mode
    && option.label.split(/\s+-\s+/).slice(-2, -1)[0]?.trim().toLowerCase() === size);
  return cars.find((option) => /mile/i.test(option.unit ?? "")) ?? cars[0] ?? null;
}

/** A trip's source name — the leg, else the mode. Never a person's name, never a registration. */
export const travelSourceName = (row: Pick<TravelTemplateRow, "from" | "to">, resolved: Pick<ResolvedTravelRow, "mode" | "haul" | "cabinClass">) =>
  row.from && row.to ? `${row.from} → ${row.to}` : travelModeLabel({ travelMode: resolved.mode, airHaul: resolved.haul, cabinClass: resolved.cabinClass }) || "Business trip";
