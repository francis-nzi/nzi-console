// Data entry D4 (R1, R3, R4) — Company Vehicles capture, pure (BUILD-dataentry-D4-company-vehicles).
//
// - **Which category holds a plate (R1).** Only a company vehicle keeps its registration — sealed by the write under the client's
//   key. Business travel and commuting use the DVLA lookup too, but the plate is read transiently and never kept.
// - **The manual fallback (R4).** No registration, or no factor matched → pick **type → size → fuel** from the factor library
//   itself: the library's own labels, read into those three parts.
// - **The basis (R3).** A vehicle is measured in **miles** by default, **km** where the library publishes the same vehicle in km,
//   and **litres** of its fuel where a fuel factor for it is offered. The unit is always the chosen factor's — choosing one
//   chooses the factor.

export const COMPANY_VEHICLES_CODE = "1.company-vehicles";

/** A registration as it is compared (never stored this way): letters and digits, upper case — "ab12 cde" and "AB12CDE" are one. */
export const normaliseVehicleRegistration = (value: string | null | undefined): string => String(value ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();

export type VehicleType = "car" | "van" | "hgv" | "motorbike";
export const VEHICLE_TYPE_LABEL: Record<VehicleType, string> = { car: "Car", van: "Van", hgv: "HGV", motorbike: "Motorbike" };
const VEHICLE_TYPE_ORDER: readonly VehicleType[] = ["car", "van", "hgv", "motorbike"];

const FUELS: ReadonlyArray<[RegExp, string]> = [
  [/plug-?in hybrid/i, "Plug-in hybrid"], [/\bhybrid\b/i, "Hybrid"], [/battery electric|\bbev\b|\belectric\b/i, "Battery electric"],
  [/\bdiesel\b/i, "Diesel"], [/\bpetrol\b/i, "Petrol"], [/\blpg\b/i, "LPG"], [/\bcng\b/i, "CNG"], [/\bunknown\b/i, "Unknown fuel"],
];
const fuelOf = (text: string): string | null => FUELS.find(([pattern]) => pattern.test(text))?.[1] ?? null;

/**
 * A per-distance vehicle factor's label, read into type, size and fuel — "Passenger vehicles - Cars (by size) - Small car -
 * Diesel" is car · Small car · Diesel; "Delivery vehicles - Vans - Class III (1.74 to 3.5 tonnes) - Diesel" is van · Class III
 * (1.74 to 3.5 tonnes) · Diesel. The library's own words, so nothing is renamed. Null when the label is not a vehicle's.
 */
export function parseVehicleFactorLabel(label: string): { type: VehicleType; size: string | null; fuel: string | null } | null {
  const text = label.toLowerCase();
  const type: VehicleType | null = /\bhgvs?\b|heavy goods|\brigid\b|articul/.test(text) ? "hgv"
    : /\bvans?\b|light goods|\blgv\b/.test(text) ? "van"
    : /motorbike|motorcycle/.test(text) ? "motorbike"
    : /\bcars?\b/.test(text) ? "car" : null;
  if (!type) return null;
  const parts = label.split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  const fuel = fuelOf(last);
  // Group · type · size · fuel: the size is the part before the fuel, when there is one between it and the type.
  const size = fuel && parts.length >= 4 ? parts[parts.length - 2]! : !fuel && parts.length >= 3 ? last : null;
  return { type, size, fuel };
}

type Option = { id: string; label: string; unit?: string | null };

/** R4 — the manual fallback's choices, from the factors on offer: the types, then a type's sizes, then a type and size's fuels. */
export function vehicleChoices<T extends Option>(options: readonly T[], picked: { type?: VehicleType | null; size?: string | null }) {
  const parsed = options.flatMap((option) => { const read = parseVehicleFactorLabel(option.label); return read ? [{ option, ...read }] : []; });
  const unique = (values: Array<string | null>) => [...new Set(values.filter((value): value is string => value !== null))];
  const types = VEHICLE_TYPE_ORDER.filter((type) => parsed.some((entry) => entry.type === type));
  const ofType = parsed.filter((entry) => entry.type === picked.type);
  const sizes = unique(ofType.map((entry) => entry.size));
  const fuels = unique(ofType.filter((entry) => (entry.size ?? null) === (picked.size ?? null)).map((entry) => entry.fuel));
  return { types, sizes, fuels };
}

const UNIT_ORDER = ["miles", "km", "litres"];
const unitKind = (unit: string | null | undefined): "miles" | "km" | "litres" | null => {
  const text = (unit ?? "").trim().toLowerCase();
  if (/^(mi|mile|miles|vehicle[- ]miles?)$/.test(text)) return "miles";
  if (/^(km|kms|kilomet(re|er)s?|vehicle[- ]km)$/.test(text)) return "km";
  if (/^(l|litre|litres|liter|liters)$/.test(text)) return "litres";
  return null;
};
export const VEHICLE_UNIT_LABEL = { miles: "Miles", km: "Km", litres: "Litres of fuel" } as const;

/**
 * R3 — how a chosen vehicle can be measured: the same vehicle (type · size · fuel) in each distance unit the library publishes it
 * in, and litres of its fuel where a fuel factor for that fuel is offered. Miles first — the default — then km, then litres. Empty
 * when the chosen factor is not a vehicle's.
 */
export function vehicleUnitOptions<T extends Option>(options: readonly T[], chosen: { type: VehicleType; size: string | null; fuel: string | null })
  : Array<{ kind: "miles" | "km" | "litres"; option: T }> {
  const out = new Map<"miles" | "km" | "litres", T>();
  for (const option of options) {
    const kind = unitKind(option.unit);
    if (!kind || out.has(kind)) continue;
    const read = parseVehicleFactorLabel(option.label);
    if (kind !== "litres" && read && read.type === chosen.type && (read.size ?? null) === (chosen.size ?? null) && (read.fuel ?? null) === (chosen.fuel ?? null)) out.set(kind, option);
    // A fuel factor: priced per litre, naming the vehicle's fuel and no vehicle.
    if (kind === "litres" && !read && chosen.fuel && fuelOf(option.label) === chosen.fuel) out.set(kind, option);
  }
  return UNIT_ORDER.flatMap((kind) => out.has(kind as never) ? [{ kind: kind as "miles" | "km" | "litres", option: out.get(kind as never)! }] : []);
}

/** The option to open on for a chosen vehicle: its miles factor when there is one (R3's default), else the one chosen. */
export function preferMiles<T extends Option>(options: readonly T[], chosen: T): T {
  const read = parseVehicleFactorLabel(chosen.label);
  if (!read) return chosen;
  return vehicleUnitOptions(options, read).find((entry) => entry.kind === "miles")?.option ?? chosen;
}
