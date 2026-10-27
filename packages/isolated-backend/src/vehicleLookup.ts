// UX1 — DVLA vehicle-registration lookup (ported from nzi_pro
// `services/vehicle_lookup.py` + `vehicle_categorization.py`). A **real
// service**: when `DVLA_VES_API_KEY` is set it calls the live DVLA Vehicle
// Enquiry Service; on isolated staging (no key) it returns a deterministic
// stub so the two-step flow (look up → confirm → enter) is exercisable without
// a real key or a real plate. Shared by Company Vehicles, Business Travel and
// Employee Commuting, each with a manual-entry fallback.
//
// The registration number is **transient** — used only to build the request,
// never persisted, never logged. The response never echoes it back.
import type { Queryable } from "./postgres";

const VES_URL = "https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles";

export type VehicleSpec = {
  make: string | null;
  fuelType: string | null;
  engineCapacity: number | null;
  revenueWeight: number | null;
  co2Emissions: number | null;
  wheelplan: string | null;
  typeApproval: string | null;
  yearOfManufacture: number | null;
};

export type ResolvedVehicleFactor = {
  factorId: string;
  datasetId: string;
  label: string;
  unit: string;
  scope: "1";
  vehicleClass: string;
  /** The size band the matched label names: the vehicle's own, "average" when v7's fallback answered, null when unbanded. */
  band: VehicleBand | null;
};

export type VehicleLookupResult =
  | { ok: true; source: "dvla" | "stub"; vehicle: VehicleSpec; suggestedClass: string | null }
  | { ok: false; status: 400 | 404 | 429 | 503; message: string };

export type VehicleLookupConfig = {
  apiKey?: string | null;
  /** Return a deterministic stub when no api key is configured (isolated staging). */
  allowStub?: boolean;
  /** Inject a fetch for tests. */
  fetchImpl?: typeof fetch;
};

export function normaliseRegistration(registration: string): string {
  return String(registration ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
const numOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * DVLA type approval + revenue weight → a vehicle class, as v7 decides it (`services/vehicle_categorization.py`,
 * JW-11): M1 a car, N1 a van, N2/N3 an HGV. Without a recognised approval — DVLA often leaves it blank — a revenue
 * weight is a goods-vehicle plating figure, so it decides van (≤ 3,500 kg) or HGV; a real motorbike never has one, so
 * only a weightless vehicle of 2,500 cc or less is a motorbike. Anything else is unclassified (null), not a guess.
 */
export function vehicleClassOf(vehicle: VehicleSpec): "car" | "van" | "hgv" | "motorbike" | null {
  const approval = (vehicle.typeApproval ?? "").trim().toUpperCase();
  if (approval === "M1") return "car";
  if (approval === "N1") return "van";
  if (approval === "N2" || approval === "N3") return "hgv";
  const weight = vehicle.revenueWeight ?? 0;
  if (weight > 0) return weight <= 3500 ? "van" : "hgv";
  const cc = vehicle.engineCapacity;
  if (cc !== null && cc > 0 && cc <= 2500) return "motorbike";
  return null;
}

export function fuelKeyword(fuelType: string | null): string | null {
  const text = (fuelType ?? "").trim().toUpperCase();
  if (!text) return null;
  if (text.includes("ELECTRIC") && !text.includes("HYBRID")) return "electric";
  if (text.includes("HYBRID")) return "hybrid";
  if (text.includes("DIESEL")) return "diesel";
  // LPG before petrol: "LIQUID PETROLEUM GAS" contains "PETROL", and v7 prices it as LPG.
  if (text.includes("LPG") || text.includes("LIQUID PETROLEUM")) return "lpg";
  // v7's map: a gas/petrol or gas bi-fuel vehicle is priced as petrol; plain "GAS" is CNG.
  if (text.includes("PETROL") || text === "GAS BI-FUEL") return "petrol";
  if (text === "GAS" || text.includes("CNG") || text.includes("COMPRESSED NATURAL")) return "cng";
  return null;
}

/**
 * v7's size and weight bands (JW-11, ruled 6 Oct): each upper bound inclusive, as v7's `_band` reads them. A car's
 * band is its engine size — diesel engines run larger for the same class, so diesel has its own small limit — and a
 * van's its revenue weight. No measurement, no band: v7 then uses its "Average" row, and so do we.
 */
export type VehicleBand = "small" | "medium" | "large" | "class-i" | "class-ii" | "class-iii" | "average";

const CAR_BANDS_PETROL: ReadonlyArray<[number, VehicleBand]> = [[1400, "small"], [2000, "medium"], [Infinity, "large"]];
const CAR_BANDS_DIESEL: ReadonlyArray<[number, VehicleBand]> = [[1700, "small"], [2000, "medium"], [Infinity, "large"]];
const VAN_BANDS: ReadonlyArray<[number, VehicleBand]> = [[1305, "class-i"], [1740, "class-ii"], [3500, "class-iii"]];

const bandOf = (value: number | null, bands: ReadonlyArray<[number, VehicleBand]>): VehicleBand | null => {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  for (const [limit, band] of bands) if (value <= limit) return band;
  return null;
};

const BAND_LABEL: Record<VehicleBand, string> = {
  small: "Small", medium: "Medium", large: "Large", average: "Average",
  "class-i": "Class I (up to 1.305 tonnes)", "class-ii": "Class II (1.305 to 1.74 tonnes)", "class-iii": "Class III (1.74 to 3.5 tonnes)",
};
const FUEL_LABEL: Record<string, string> = { petrol: "Petrol", diesel: "Diesel", hybrid: "Hybrid", lpg: "LPG", cng: "CNG", electric: "Battery electric", unknown: "Unknown fuel" };

/**
 * What a looked-up car or van **is**, in the terms the per-distance factors are published in (JW-11):
 *
 * - `category`: `class|band|fuel`, e.g. `car|small|petrol` or `van|class-ii|diesel`, which a declared rule matches;
 * - `fallbackCategory`: the same vehicle at v7's "Average" band (`car|average|petrol`), which a rule may answer when
 *   the band's own factor is not in the job's datasets (v7's fallback, as a rule rather than a code path);
 * - `label`: "Small car · Petrol", "Van, Class II (1.305 to 1.74 tonnes) · Diesel", for the person confirming it.
 *
 * Only cars and vans are banded (the ruled scope); an HGV, a motorbike or an unclassified vehicle has none and is
 * left to a person. A missing fuel is v7's "Unknown", which the library publishes for every car and van band.
 * **No registration appears in any of these values**: the argument is a `VehicleSpec`, which never carries one.
 */
export type VehicleClassification = { category: string | null; fallbackCategory: string | null; label: string | null };

export function classifyVehicle(vehicle: VehicleSpec): VehicleClassification {
  const vehicleClass = vehicleClassOf(vehicle);
  const fuel = fuelKeyword(vehicle.fuelType) ?? "unknown";
  if (vehicleClass !== "car" && vehicleClass !== "van") return { category: null, fallbackCategory: null, label: null };
  const band = vehicleClass === "car"
    ? bandOf(vehicle.engineCapacity, fuel === "diesel" ? CAR_BANDS_DIESEL : CAR_BANDS_PETROL) ?? "average"
    : bandOf(vehicle.revenueWeight, VAN_BANDS) ?? "average";
  const label = vehicleClass === "car"
    ? `${BAND_LABEL[band]} car · ${FUEL_LABEL[fuel] ?? fuel}`
    : `Van, ${band === "average" ? "Average (up to 3.5 tonnes)" : BAND_LABEL[band]} · ${FUEL_LABEL[fuel] ?? fuel}`;
  return { category: `${vehicleClass}|${band}|${fuel}`, fallbackCategory: `${vehicleClass}|average|${fuel}`, label };
}

/**
 * What the size band was read from, for the person confirming it (DVLA lookup fix, 27 Oct): "Size read from its 1,995 cc
 * engine", "… its 3,100 kg revenue weight", or that the DVLA gave neither and the Average band stands. Null when unbanded.
 */
export function vehicleSizeBasis(vehicle: VehicleSpec): string | null {
  const vehicleClass = vehicleClassOf(vehicle);
  const count = (value: number) => value.toLocaleString("en-GB");
  if (vehicleClass === "car") {
    return bandOf(vehicle.engineCapacity, CAR_BANDS_PETROL)
      ? `Size read from its ${count(vehicle.engineCapacity!)} cc engine` : "No engine size from the DVLA, so the Average band";
  }
  if (vehicleClass === "van") {
    return bandOf(vehicle.revenueWeight, VAN_BANDS)
      ? `Size read from its ${count(vehicle.revenueWeight!)} kg revenue weight` : "No revenue weight from the DVLA, so the Average band";
  }
  return null;
}

/**
 * Each band as a factor label names it, in the library's own words ("Medium car", "Class II (1.305 to 1.74 tonnes)",
 * "Average (up to 3.5 tonnes)"): case-insensitive whole-word patterns, so Class I never matches Class II.
 */
const BAND_PATTERNS: Record<"car" | "van", Partial<Record<VehicleBand, string>>> = {
  car: { small: "\\msmall car\\M", medium: "\\mmedium car\\M", large: "\\mlarge car\\M", average: "\\maverage car\\M" },
  van: { "class-i": "\\mclass i\\M", "class-ii": "\\mclass ii\\M", "class-iii": "\\mclass iii\\M", average: "\\maverage\\M" },
};

const STUB_VEHICLES: readonly Omit<VehicleSpec, "yearOfManufacture">[] = [
  { make: "Ford", fuelType: "DIESEL", engineCapacity: 1995, revenueWeight: 3100, co2Emissions: 158, wheelplan: "2 AXLE RIGID BODY", typeApproval: "N1" },
  { make: "Volkswagen", fuelType: "PETROL", engineCapacity: 1390, revenueWeight: null, co2Emissions: 121, wheelplan: "2 AXLE RIGID BODY", typeApproval: "M1" },
  { make: "Tesla", fuelType: "ELECTRICITY", engineCapacity: null, revenueWeight: null, co2Emissions: 0, wheelplan: "2 AXLE RIGID BODY", typeApproval: "M1" },
  { make: "Nissan", fuelType: "HYBRID ELECTRIC", engineCapacity: 1598, revenueWeight: null, co2Emissions: 99, wheelplan: "2 AXLE RIGID BODY", typeApproval: "M1" },
];

function stubVehicle(plate: string): VehicleSpec {
  const seed = [...plate].reduce((sum, char) => sum + char.charCodeAt(0), plate.length);
  const base = STUB_VEHICLES[seed % STUB_VEHICLES.length]!;
  return { ...base, yearOfManufacture: 2018 + (seed % 7) };
}

/**
 * A looked-up vehicle as the attributes a declared `enriched` rule matches on (NZC-151).
 *
 * The bridge between this module and the spec's factor rules, and deliberately a thin one: it reuses
 * `fuelKeyword` and `vehicleClassOf` rather than deriving fuel or class a second time, so a rule that
 * says `fuel = diesel` means exactly what the lookup flow has always meant by diesel. Two derivations
 * would be two answers to the same question, and the one in the spec would be the one nobody tested.
 *
 * **No registration appears here.** The argument is a `VehicleSpec`, which never carries one, so the
 * plate cannot reach the resolver through this path (NZC-103).
 */
export function vehicleAttributes(vehicle: VehicleSpec): Record<string, string | null> {
  const banded = classifyVehicle(vehicle);
  return {
    fuel: fuelKeyword(vehicle.fuelType),
    class: vehicleClassOf(vehicle),
    make: vehicle.make,
    // JW-11: the banded category a per-distance rule matches, and v7's Average-band fallback.
    category: banded.category,
    fallback: banded.fallbackCategory,
  };
}

export async function lookupVehicleByRegistration(
  registration: string,
  config: VehicleLookupConfig,
): Promise<VehicleLookupResult> {
  const plate = normaliseRegistration(registration);
  if (plate.length < 2 || plate.length > 8) {
    return { ok: false, status: 400, message: "That doesn't look like a valid UK registration number." };
  }
  const apiKey = config.apiKey?.trim();
  if (!apiKey) {
    if (config.allowStub) {
      const vehicle = stubVehicle(plate);
      return { ok: true, source: "stub", vehicle, suggestedClass: vehicleClassOf(vehicle) };
    }
    return { ok: false, status: 503, message: "Vehicle lookup is not configured." };
  }

  const doFetch = config.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(VES_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ registrationNumber: plate }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, status: 503, message: "Vehicle lookup failed — please try again or enter it manually." };
  }
  if (response.status === 404) return { ok: false, status: 404, message: "No vehicle found for that registration." };
  if (response.status === 429) return { ok: false, status: 429, message: "Too many lookups right now — please try again shortly." };
  if (!response.ok) return { ok: false, status: 503, message: "Vehicle lookup failed — please try again or enter it manually." };

  const payload = (await response.json()) as Record<string, unknown>;
  const vehicle: VehicleSpec = {
    make: str(payload.make),
    fuelType: str(payload.fuelType),
    engineCapacity: numOrNull(payload.engineCapacity),
    revenueWeight: numOrNull(payload.revenueWeight),
    co2Emissions: numOrNull(payload.co2Emissions),
    wheelplan: str(payload.wheelplan),
    typeApproval: str(payload.typeApproval),
    yearOfManufacture: numOrNull(payload.yearOfManufacture),
  };
  return { ok: true, source: "dvla", vehicle, suggestedClass: vehicleClassOf(vehicle) };
}

/**
 * Best-effort match of a looked-up vehicle to a Scope 1 factor already selected
 * for the job — fuel keyword + a vehicle-class term in the factor label. Returns
 * null when nothing matches (the UI falls back to the manual factor picker).
 *
 * The size band (DVLA lookup fix, 27 Oct): a banded car or van matches the label naming its own band first, then the
 * Average band's (v7's fallback, as 0160 declares it), then a label naming no band at all — never another band's, so a
 * medium diesel car is not given the small car because its label is shorter. An HGV, a motorbike or an unclassified
 * vehicle has no band and matches as it always has.
 */
export async function resolveVehicleFactor(
  db: Queryable,
  jobId: string,
  vehicle: VehicleSpec,
): Promise<ResolvedVehicleFactor | null> {
  const fuel = fuelKeyword(vehicle.fuelType);
  if (!fuel) return null;
  // The label match predates the banding; an unclassified vehicle is matched as a car, as it always was.
  const vehicleClass = vehicleClassOf(vehicle) ?? "car";
  const classTerms: Record<string, string[]> = {
    car: ["car"],
    van: ["van", "light goods", "lgv"],
    hgv: ["hgv", "heavy goods", "rigid", "articul"],
    motorbike: ["motorbike", "motorcycle"],
  };
  const terms = classTerms[vehicleClass] ?? ["car"];
  const category = classifyVehicle(vehicle).category;
  const band = (category?.split("|")[1] ?? null) as VehicleBand | null;
  const patterns = band && (vehicleClass === "car" || vehicleClass === "van") ? BAND_PATTERNS[vehicleClass] : {};
  const own = band ? patterns[band] ?? null : null;
  const others = Object.entries(patterns).filter(([key]) => key !== band && key !== "average").map(([, pattern]) => pattern);
  const at = terms.length + 3;
  const { rows } = await db.query<{ factor_id: string; dataset_id: string; label: string; activity_unit: string; fit: number }>(
    `SELECT f.factor_id, f.dataset_id, f.label, f.activity_unit,
            CASE WHEN f.label ~* $${at} THEN 0 WHEN f.label ~* $${at + 1} THEN 1 ELSE 2 END AS fit
       FROM nzi_console.job_dataset_selections s
       JOIN nzi_console.emission_factors f ON (f.organisation_id,f.dataset_id)=(s.organisation_id,s.dataset_id)
      WHERE s.job_id=$1 AND f.active=true AND '1'=ANY(f.scopes)
        AND f.label ILIKE '%'||$2||'%'
        AND (${terms.map((_, index) => `f.label ILIKE '%'||$${index + 3}||'%'`).join(" OR ")})
        AND NOT (f.label ~* ANY($${at + 2}::text[]))
      ORDER BY fit, length(f.label)
      LIMIT 1`,
    [jobId, fuel, ...terms, own, patterns.average ?? null, others],
  );
  const row = rows[0];
  const fit = Number(row?.fit);
  return row
    ? { factorId: row.factor_id, datasetId: row.dataset_id, label: row.label, unit: row.activity_unit, scope: "1", vehicleClass,
      band: fit === 0 ? band : fit === 1 ? "average" : null }
    : null;
}
