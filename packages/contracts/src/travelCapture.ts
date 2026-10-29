// Data entry D5 (R2–R5) — Business Travel capture, pure (BUILD-dataentry-D5-business-travel).
//
// - **One controlled mode list (R2).** The ground modes are commuting's own — one list, read by both — and travel adds air, rail
//   abroad, coach, taxi, ferry, hotel and grey fleet. A trip's mode is one of these values, never free text.
// - **Air by haul and cabin class (R3).** Read from the factor library's own labels ("Business travel- air - Flights - Long-haul,
//   to/from UK - Business class"), so the haul and class on offer are the dataset's: nothing is renamed or invented.
// - **The basis follows the mode (R4).** Distance for air, rail and road; nights for a hotel. The chosen factor's unit governs.
// - **Grey fleet keeps no plate (R5).** A personal car is found through the vehicle lookup, as a company vehicle is, but the plate is
//   the lookup's alone: a travel detail is stored as exactly its own fields, so no registration can ride along in it.
import { parseVehicleFactorLabel } from "./vehicleCapture";

export const BUSINESS_TRAVEL_CODE = "3.6";

/** The ground modes travel shares with commuting — the same labels, in the same order. */
export const GROUND_MODES = [
  { value: "car-petrol", label: "Car — petrol" },
  { value: "car-diesel", label: "Car — diesel" },
  { value: "car-hybrid", label: "Car — hybrid" },
  { value: "car-plug-in-hybrid", label: "Car — plug-in hybrid" },
  { value: "car-battery-electric", label: "Car — battery electric" },
  { value: "motorcycle", label: "Motorcycle" },
  { value: "bus", label: "Bus" },
  { value: "rail", label: "Rail" },
  { value: "underground-tram", label: "Underground / tram" },
] as const;

/** Employee commuting's controlled modes: the ground modes, then the two that emit nothing. */
export const COMMUTE_MODES: readonly string[] = [...GROUND_MODES.map((mode) => mode.label), "Cycle", "Walk"];

export type TravelModeGroup = "air" | "rail" | "road" | "sea" | "hotel";
export type TravelBasis = "distance" | "nights";
export type TravelModeValue = (typeof GROUND_MODES)[number]["value"]
  | "air" | "rail-international" | "coach" | "taxi" | "ferry" | "grey-fleet" | "hotel";

type TravelModeDef = { value: TravelModeValue; label: string; group: TravelModeGroup; basis: TravelBasis };
const groupOf = (value: string): TravelModeGroup => value === "rail" || value === "underground-tram" ? "rail" : "road";

/** Business travel's controlled modes (R2): air first, then commuting's ground modes, then the travel-only ones. */
export const TRAVEL_MODES: readonly TravelModeDef[] = [
  { value: "air", label: "Air", group: "air", basis: "distance" },
  ...GROUND_MODES.map((mode) => ({ ...mode, group: groupOf(mode.value), basis: "distance" as const })),
  { value: "rail-international", label: "Rail — international", group: "rail", basis: "distance" },
  { value: "coach", label: "Coach", group: "road", basis: "distance" },
  { value: "taxi", label: "Taxi / private hire", group: "road", basis: "distance" },
  { value: "grey-fleet", label: "Grey fleet — own car", group: "road", basis: "distance" },
  { value: "ferry", label: "Ferry", group: "sea", basis: "distance" },
  { value: "hotel", label: "Hotel", group: "hotel", basis: "nights" },
];
export const TRAVEL_MODE_GROUP_LABEL: Record<TravelModeGroup, string> = { air: "Air", rail: "Rail", road: "Road", sea: "Sea", hotel: "Hotel" };
export const travelModeDef = (value: string | null | undefined): TravelModeDef | null => TRAVEL_MODES.find((mode) => mode.value === value) ?? null;

export type AirHaul = "domestic" | "short-haul" | "long-haul" | "international";
export type CabinClass = "average" | "economy" | "premium-economy" | "business" | "first";
export const AIR_HAULS: ReadonlyArray<{ value: AirHaul; label: string }> = [
  { value: "domestic", label: "Domestic" }, { value: "short-haul", label: "Short haul" },
  { value: "long-haul", label: "Long haul" }, { value: "international", label: "International (not to/from UK)" },
];
export const CABIN_CLASSES: ReadonlyArray<{ value: CabinClass; label: string }> = [
  { value: "average", label: "Average passenger" }, { value: "economy", label: "Economy" },
  { value: "premium-economy", label: "Premium economy" }, { value: "business", label: "Business" }, { value: "first", label: "First" },
];

/** What a factor's label says it is, for travel: its mode, and for a flight its haul, class and whether it carries the RF uplift. */
export type TravelFactorRead = { mode: TravelModeValue; haul: AirHaul | null; cabinClass: CabinClass | null; withRf: boolean | null; car: boolean };

const haulOf = (text: string): AirHaul | null =>
  /to\/from non-uk|international,|non-uk/.test(text) ? "international"
    : /long-?\s?haul/.test(text) ? "long-haul" : /short-?\s?haul/.test(text) ? "short-haul" : /domestic/.test(text) ? "domestic" : null;
const classOf = (text: string): CabinClass | null =>
  /premium economy/.test(text) ? "premium-economy" : /economy/.test(text) ? "economy" : /business class/.test(text) ? "business"
    : /first class/.test(text) ? "first" : /average passenger/.test(text) ? "average" : null;
const CAR_FUEL_MODE: Record<string, TravelModeValue> = {
  Petrol: "car-petrol", Diesel: "car-diesel", Hybrid: "car-hybrid", "Plug-in hybrid": "car-plug-in-hybrid", "Battery electric": "car-battery-electric",
};

/**
 * A factor's label read for travel (R2, R3), in the library's own words, or null when it is no travel factor. A car factor is read as
 * its fuel's car mode (a hire or pool car) and is also what grey fleet picks from; `car` says so.
 */
export function readTravelFactorLabel(label: string): TravelFactorRead | null {
  const text = label.toLowerCase();
  // D5-air (R4): a well-to-tank factor ("WTT- business travel- air - WTT- flights - …") is the fuel's upstream, filed under 3.3 — never
  // the trip itself, so it is no travel mode's factor, or a flight would resolve to its WTT wherever both are offered.
  if (/^\s*wtt-/.test(text)) return null;
  const read = (mode: TravelModeValue, extra: Partial<TravelFactorRead> = {}): TravelFactorRead => ({ mode, haul: null, cabinClass: null, withRf: null, car: false, ...extra });
  if (/\bflights?\b|business travel- ?air|\baviation\b/.test(text)) {
    return read("air", { haul: haulOf(text), cabinClass: classOf(text), withRf: /without rf/.test(text) ? false : /with rf/.test(text) ? true : null });
  }
  if (/\bhotel/.test(text)) return read("hotel");
  if (/\bferry\b/.test(text)) return read("ferry");
  if (/international rail|eurostar/.test(text)) return read("rail-international");
  if (/underground|light rail|\btram\b|\bmetro\b/.test(text)) return read("underground-tram");
  if (/\brail\b|\btrain\b/.test(text)) return read("rail");
  if (/\bcoach\b/.test(text)) return read("coach");
  if (/\bbus\b/.test(text)) return read("bus");
  if (/\btaxis?\b|black cab/.test(text)) return read("taxi");
  const vehicle = parseVehicleFactorLabel(label);
  if (vehicle?.type === "motorbike") return read("motorcycle");
  if (vehicle?.type === "car") return read(CAR_FUEL_MODE[vehicle.fuel ?? ""] ?? "grey-fleet", { car: true });
  return null;
}

type Option = { id: string; label: string; unit?: string | null };

/** Whether a factor serves a mode: its own mode's factors, and for grey fleet any car's (picked by type · size · fuel). */
export function factorServesTravelMode(label: string, mode: string, air?: { haul?: string | null; cabinClass?: string | null }): boolean {
  const read = readTravelFactorLabel(label);
  if (!read) return false;
  if (mode === "grey-fleet") return read.car;
  if (read.mode !== mode) return false;
  if (mode !== "air" || !air) return true;
  return (!air.haul || read.haul === air.haul) && (!air.cabinClass || read.cabinClass === air.cabinClass);
}

/** The factors a mode may use, in the library's order (R2). */
export function travelFactorsForMode<T extends Option>(options: readonly T[], mode: string): T[] {
  return options.filter((option) => factorServesTravelMode(option.label, mode));
}

/** R3 — the hauls the library offers for air, and the cabin classes it offers for the haul chosen; in the fixed order. */
export function airChoices<T extends Option>(options: readonly T[], haul: AirHaul | null) {
  const flights = options.flatMap((option) => { const read = readTravelFactorLabel(option.label); return read?.mode === "air" ? [read] : []; });
  return {
    hauls: AIR_HAULS.filter((entry) => flights.some((read) => read.haul === entry.value)),
    classes: CABIN_CLASSES.filter((entry) => flights.some((read) => read.haul === haul && read.cabinClass === entry.value)),
  };
}

/**
 * R3 — the factor for a haul and class: the one the library publishes for both. Where it publishes the flight with and without the
 * radiative-forcing uplift, the one with it (DESNZ's recommended basis for reporting aviation). Null when it publishes neither.
 */
export function airFactorFor<T extends Option>(options: readonly T[], haul: AirHaul, cabinClass: CabinClass): T | null {
  const matching = options.filter((option) => { const read = readTravelFactorLabel(option.label); return read?.mode === "air" && read.haul === haul && read.cabinClass === cabinClass; });
  return matching.find((option) => readTravelFactorLabel(option.label)!.withRf === true)
    ?? matching.find((option) => readTravelFactorLabel(option.label)!.withRf === null) ?? matching[0] ?? null;
}

/** A mode written in a file or a past entry, matched to a controlled one — or null; never a guess between two. */
export function matchTravelMode(raw: string | null | undefined): { mode: TravelModeValue; haul: AirHaul | null } | null {
  const text = String(raw ?? "").trim().toLowerCase();
  if (!text) return null;
  const exact = TRAVEL_MODES.find((mode) => mode.label.toLowerCase() === text || mode.value === text);
  if (exact) return { mode: exact.value, haul: null };
  if (/\b(air|flight|fly|plane)\b/.test(text)) return { mode: "air", haul: haulOf(text) };
  if (/grey fleet|own car|personal car|private car/.test(text)) return { mode: "grey-fleet", haul: null };
  if (/hotel|night/.test(text)) return { mode: "hotel", haul: null };
  if (/ferry/.test(text)) return { mode: "ferry", haul: null };
  if (/eurostar|international rail|rail.{0,4}international/.test(text)) return { mode: "rail-international", haul: null };
  if (/underground|tube|metro|tram/.test(text)) return { mode: "underground-tram", haul: null };
  if (/\b(rail|train)\b/.test(text)) return { mode: "rail", haul: null };
  if (/coach/.test(text)) return { mode: "coach", haul: null };
  if (/\bbus\b/.test(text)) return { mode: "bus", haul: null };
  if (/taxi|cab|private hire|uber/.test(text)) return { mode: "taxi", haul: null };
  if (/motorbike|motorcycle/.test(text)) return { mode: "motorcycle", haul: null };
  const car = /\bcar\b/.test(text);
  if (car && /plug/.test(text)) return { mode: "car-plug-in-hybrid", haul: null };
  if (car && /hybrid/.test(text)) return { mode: "car-hybrid", haul: null };
  if (car && /electric|\bev\b/.test(text)) return { mode: "car-battery-electric", haul: null };
  if (car && /diesel/.test(text)) return { mode: "car-diesel", haul: null };
  if (car && /petrol|unleaded/.test(text)) return { mode: "car-petrol", haul: null };
  return null;
}

export function matchCabinClass(raw: string | null | undefined): CabinClass | null {
  const text = String(raw ?? "").trim().toLowerCase();
  if (!text) return null;
  return CABIN_CLASSES.find((entry) => entry.label.toLowerCase() === text || entry.value === text)?.value ?? classOf(text)
    ?? (/^business$/.test(text) ? "business" : /^first$/.test(text) ? "first" : /^average$/.test(text) ? "average" : null);
}

/** How a stored mode reads: its controlled label, or — for an entry from before the list — the words it was saved with. */
export function travelModeLabel(detail: { travelMode?: string | null; airHaul?: string | null; cabinClass?: string | null }): string {
  const mode = travelModeDef(detail.travelMode);
  if (!mode) return String(detail.travelMode ?? "");
  if (mode.value !== "air") return mode.label;
  const haul = AIR_HAULS.find((entry) => entry.value === detail.airHaul)?.label;
  const cabin = CABIN_CLASSES.find((entry) => entry.value === detail.cabinClass)?.label;
  return ["Air", haul, cabin].filter(Boolean).join(" · ");
}

/** The travel mode group a trip is reported under (R7): its mode's, else what its factor's label says, else null. */
export function travelModeGroupOf(input: { travelMode?: string | null; factorLabel?: string | null }): TravelModeGroup | null {
  const mode = travelModeDef(input.travelMode) ?? travelModeDef(matchTravelMode(input.travelMode)?.mode);
  if (mode) return mode.group;
  const read = input.factorLabel ? readTravelFactorLabel(input.factorLabel) : null;
  return read ? travelModeDef(read.mode)!.group : null;
}

/**
 * D5 (R7, R8) — a travel factor's pattern: its mode, and for a flight its haul and class. What a year carries forward (structure, the
 * figures zeroed) and what the import groups trips by, with the factor — one roll-up row per mode and factor, composing 3.6's total.
 * Null for a factor that is no travel mode's (a spend factor).
 */
export function travelPatternOf(factorLabel: string | null | undefined): { key: string; label: string; group: TravelModeGroup } | null {
  const read = factorLabel ? readTravelFactorLabel(factorLabel) : null;
  if (!read) return null;
  const label = travelModeLabel({ travelMode: read.mode, airHaul: read.haul, cabinClass: read.cabinClass });
  return { key: read.mode === "air" ? `air:${read.haul ?? "-"}:${read.cabinClass ?? "-"}` : read.mode, label, group: travelModeDef(read.mode)!.group };
}

/** The roll-up group a mode and factor's trips are filed in: "Business travel · Air · Long haul · Business". */
export const travelGroupName = (patternLabel: string) => `Business travel · ${patternLabel}`;

type TravelDetailInput = {
  travelMode?: unknown; airHaul?: unknown; cabinClass?: unknown; nights?: unknown; tripDate?: unknown;
  origin?: unknown; destination?: unknown; carrier?: unknown; distanceUnit?: unknown; passengers?: unknown;
};
type Issue = { field: string; code: "INVALID" | "REQUIRED"; message: string };
const isNumberOrNull = (value: unknown, min: number) => value === null || value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= min);

/** R2–R4 — what a travel detail must say: a controlled mode; for air, a haul and a cabin class; numbers that are numbers. */
export function travelDetailIssues(detail: TravelDetailInput): Issue[] {
  const issues: Issue[] = [];
  const mode = travelModeDef(typeof detail.travelMode === "string" ? detail.travelMode : null);
  if (!mode) issues.push({ field: "detail.travelMode", code: "INVALID", message: "Pick the travel mode from the list — a mode is never free text." });
  if (mode?.value === "air") {
    if (!AIR_HAULS.some((entry) => entry.value === detail.airHaul)) issues.push({ field: "detail.airHaul", code: "REQUIRED", message: "Say whether the flight is domestic, short haul, long haul or international." });
    if (!CABIN_CLASSES.some((entry) => entry.value === detail.cabinClass)) issues.push({ field: "detail.cabinClass", code: "REQUIRED", message: "Say the flight's cabin class." });
  } else if (mode && (detail.airHaul != null || detail.cabinClass != null)) {
    issues.push({ field: "detail.cabinClass", code: "INVALID", message: "Only a flight has a haul and a cabin class." });
  }
  if (!isNumberOrNull(detail.nights, 0)) issues.push({ field: "detail.nights", code: "INVALID", message: "Nights must be zero or more." });
  if (!isNumberOrNull(detail.passengers, 1) || (typeof detail.passengers === "number" && !Number.isInteger(detail.passengers))) issues.push({ field: "detail.passengers", code: "INVALID", message: "Passengers must be a whole number, one or more." });
  if (detail.tripDate != null && (typeof detail.tripDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(detail.tripDate))) issues.push({ field: "detail.tripDate", code: "INVALID", message: "A trip date is a date (YYYY-MM-DD)." });
  return issues;
}

const textOrNull = (value: unknown, max = 240): string | null => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
const numberOrNull = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * A travel detail as it is stored: exactly its own fields, and nothing else (R5). Whatever else a caller sends — a registration a
 * grey-fleet lookup used, above all — is not kept.
 */
export function normaliseTravelDetail(detail: TravelDetailInput) {
  const air = detail.travelMode === "air";
  return {
    kind: "travel" as const,
    travelMode: String(detail.travelMode ?? ""),
    airHaul: air ? (textOrNull(detail.airHaul) as AirHaul | null) : null,
    cabinClass: air ? (textOrNull(detail.cabinClass) as CabinClass | null) : null,
    nights: numberOrNull(detail.nights),
    tripDate: textOrNull(detail.tripDate, 10),
    origin: textOrNull(detail.origin),
    destination: textOrNull(detail.destination),
    carrier: textOrNull(detail.carrier),
    distanceUnit: textOrNull(detail.distanceUnit, 16) ?? "km",
    passengers: numberOrNull(detail.passengers),
  };
}
