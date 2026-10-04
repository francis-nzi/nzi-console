import "server-only";
import { geocodingConfig, locateClient, locateSite, type PoolLike } from "@nzi/isolated-backend";
import type { CommandContext } from "@nzi/contracts";

/**
 * CLIENT-04 — locate a client or a site after its save has committed: best effort and non-blocking. Whatever happens —
 * the switch off, no postcode, no match, the geocoder down, an error here — the save stands and its response carries
 * what happened, so the screen can say so and offer a retry. It never turns a successful save into a failure.
 */
export type LocationState = "located" | "already" | "disabled" | "no-address" | "not-found" | "failed" | "stale";

export async function afterSaveLocate(kind: "site" | "client", pool: PoolLike, id: string, context: CommandContext): Promise<LocationState> {
  try {
    const outcome = kind === "site" ? await locateSite(pool, id, context, geocodingConfig()) : await locateClient(pool, id, context, geocodingConfig());
    return outcome.state;
  } catch {
    return "failed";
  }
}
