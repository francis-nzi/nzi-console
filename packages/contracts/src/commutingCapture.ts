/**
 * Data entry D6 (R1, R2a) — employee commuting holds no personal identifier (ruled 28 Oct: minimise, don't seal).
 *
 * A commuter is not a data subject here (the subject registry admits trainees, client contacts, portal users and memberships), so
 * there is no key to seal a name under — and the calculation needs none: the mode prices the trip, the distance and the WFH days
 * and hours size it. So a commuting source keeps neither the commuter's name nor a vehicle registration, anywhere: not in its
 * detail, not as its asset identifier, and its label says which commuter it is by number and mode, never by name.
 */

type CommutingDetailInput = {
  commuteMode?: unknown; distanceUnit?: unknown; wfhDaysPerYear?: unknown; wfhHoursPerDay?: unknown;
};

const textOrNull = (value: unknown, max = 240): string | null => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
const numberOrNull = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * A commuting detail as it is stored: exactly its own fields, and nothing else — the mirror of D5's `normaliseTravelDetail`. A name
 * or a registration a caller sends (an older client, a pasted object) is not kept.
 */
export function normaliseCommutingDetail(detail: CommutingDetailInput) {
  return {
    kind: "commuting" as const,
    commuteMode: String(detail.commuteMode ?? ""),
    distanceUnit: textOrNull(detail.distanceUnit, 16) ?? "km",
    wfhDaysPerYear: numberOrNull(detail.wfhDaysPerYear),
    wfhHoursPerDay: numberOrNull(detail.wfhHoursPerDay),
  };
}

/** The keys a commuting detail held before D6 that name a person or a vehicle — what the one-off clear removes. */
export const COMMUTING_IDENTIFYING_DETAIL_KEYS = ["employeeName", "vehicleRegistration"] as const;

/** R2a — a commuting source's label: which commuter by number, and the mode. Never a name. */
export const commuterLabel = (ordinal: number, mode: string | null | undefined) =>
  `Commuter ${ordinal}${mode && mode.trim() ? ` · ${mode.trim()}` : ""}`;
