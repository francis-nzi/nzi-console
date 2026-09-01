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
};

export type VehicleLookupResult =
  | { ok: true; source: "dvla" | "stub"; vehicle: VehicleSpec; suggestedClass: string }
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

/** DVLA type approval + weight → a coarse vehicle class for factor matching. */
export function vehicleClassOf(vehicle: VehicleSpec): string {
  const approval = (vehicle.typeApproval ?? "").toUpperCase();
  const weight = vehicle.revenueWeight ?? 0;
  if (approval === "N1" || (weight > 0 && weight <= 3500)) return "van";
  if (approval === "N2" || approval === "N3" || weight > 3500) return "hgv";
  if (approval === "L1" || approval === "L3" || (!weight && (vehicle.engineCapacity ?? 0) > 0 && (vehicle.engineCapacity ?? 0) <= 1500 && !approval)) return "motorbike";
  return "car";
}

export function fuelKeyword(fuelType: string | null): string | null {
  const text = (fuelType ?? "").toUpperCase();
  if (!text) return null;
  if (text.includes("ELECTRIC") && !text.includes("HYBRID")) return "electric";
  if (text.includes("HYBRID")) return "hybrid";
  if (text.includes("DIESEL")) return "diesel";
  if (text.includes("PETROL") || text.includes("GAS/PETROL")) return "petrol";
  if (text.includes("LPG") || text.includes("LIQUID PETROLEUM")) return "lpg";
  if (text.includes("CNG") || text.includes("COMPRESSED NATURAL")) return "cng";
  return null;
}

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
 */
export async function resolveVehicleFactor(
  db: Queryable,
  jobId: string,
  vehicle: VehicleSpec,
): Promise<ResolvedVehicleFactor | null> {
  const fuel = fuelKeyword(vehicle.fuelType);
  if (!fuel) return null;
  const vehicleClass = vehicleClassOf(vehicle);
  const classTerms: Record<string, string[]> = {
    car: ["car"],
    van: ["van", "light goods", "lgv"],
    hgv: ["hgv", "heavy goods", "rigid", "articul"],
    motorbike: ["motorbike", "motorcycle"],
  };
  const terms = classTerms[vehicleClass] ?? ["car"];
  const { rows } = await db.query<{ factor_id: string; dataset_id: string; label: string; activity_unit: string }>(
    `SELECT f.factor_id, f.dataset_id, f.label, f.activity_unit
       FROM nzi_console.job_dataset_selections s
       JOIN nzi_console.emission_factors f ON (f.organisation_id,f.dataset_id)=(s.organisation_id,s.dataset_id)
      WHERE s.job_id=$1 AND f.active=true AND '1'=ANY(f.scopes)
        AND f.label ILIKE '%'||$2||'%'
        AND (${terms.map((_, index) => `f.label ILIKE '%'||$${index + 3}||'%'`).join(" OR ")})
      ORDER BY length(f.label)
      LIMIT 1`,
    [jobId, fuel, ...terms],
  );
  const row = rows[0];
  return row
    ? { factorId: row.factor_id, datasetId: row.dataset_id, label: row.label, unit: row.activity_unit, scope: "1", vehicleClass }
    : null;
}
