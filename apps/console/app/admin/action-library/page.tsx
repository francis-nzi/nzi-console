import { listLevers, listLibraryStrategies, withTenantRead } from "@nzi/isolated-backend";
import type { Lever, LibraryStrategy } from "@nzi/contracts";
import { serviceEnvironment } from "../../lib/environment";
import { isolatedPool } from "../../lib/isolatedDatabase";
import { adminAccess, holds } from "../adminAccess";
import { ActionLibraryBoard } from "./ActionLibraryBoard";

export const dynamic = "force-dynamic";

/**
 * Action library (Actions A1, R1): the shared, admin-owned catalogue every client's plan draws from — the reduction
 * strategies, and the levers (themes) they are allocated to. Versioned on every edit, withdrawn rather than deleted, so
 * a plan already holding a strategy keeps it. A short list (dozens, not thousands), so it is read whole.
 */
export default async function ActionLibraryPage() {
  const access = await adminAccess();
  if (access.state !== "allowed") return null; // The layout states why; nothing is read.

  let data: { strategies: LibraryStrategy[]; levers: Lever[]; heldBy: Map<string, number> } | null = null;
  try {
    data = await withTenantRead(isolatedPool(), access.organisationId, async (db) => ({
      strategies: await listLibraryStrategies(db),
      levers: await listLevers(db),
      // How many live client plans hold each strategy — what withdrawing it would leave un-offerable.
      heldBy: new Map((await db.query<{ strategy_id: string; held: number }>(
        `SELECT strategy_id, count(*)::int AS held FROM nzi_console.client_strategies WHERE active AND strategy_id IS NOT NULL GROUP BY strategy_id`,
      )).rows.map((row) => [row.strategy_id, row.held])),
    }));
  } catch {
    data = null;
  }
  if (data === null) {
    return <section className="nz-a-state" role="alert"><h1>The action library could not be read</h1><p>It is unavailable just now. Nothing is shown rather than a library that might be incomplete.</p></section>;
  }

  const editing = !holds(access.capabilities, "admin.lookups") ? { allowed: false as const, reason: "Your role can see the library but not change it — that needs admin.lookups." }
    : serviceEnvironment().writes !== "enabled" ? { allowed: false as const, reason: "Writes are switched off in this environment, so the library is read-only here." }
    : { allowed: true as const };
  return <ActionLibraryBoard strategies={data.strategies} levers={data.levers} heldBy={Object.fromEntries(data.heldBy)} editing={editing} />;
}
