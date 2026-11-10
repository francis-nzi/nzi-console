import {
  getSrsFramework, listSrsFrameworkHistory, listSrsFrameworkSnapshots, listSrsFrameworkStates, srsWorkingDefinitionId, withTenantRead,
  type SrsFrameworkHistoryEntry, type SrsFrameworkSnapshot, type SrsFrameworkState,
} from "@nzi/isolated-backend";
import type { SrsFramework } from "@nzi/contracts";
import { serviceEnvironment } from "../../lib/environment";
import { isolatedPool } from "../../lib/isolatedDatabase";
import { adminAccess, holds } from "../adminAccess";
import { SrsFrameworkBoard } from "./SrsFrameworkBoard";

export const dynamic = "force-dynamic";

/**
 * SRS frameworks (SRS S1, R1; framework rework, Phase B): UK SRS S2 — Climate and S1 — General, each locked or unlocked.
 * An unlocked framework is edited in the working definition; locking it makes the next snapshot, which never changes, so
 * every assessment keeps meaning what it meant. Every edit, lock and unlock is in the history. Read whole: two frameworks,
 * a few dozen requirements, a history of hundreds.
 */
export default async function SrsFrameworkPage() {
  const access = await adminAccess();
  if (access.state !== "allowed") return null; // The layout states why; nothing is read.

  let data: { frameworks: SrsFrameworkState[]; snapshots: SrsFrameworkSnapshot[]; history: SrsFrameworkHistoryEntry[]; active: SrsFramework | null; working: SrsFramework | null } | null = null;
  try {
    data = await withTenantRead(isolatedPool(), access.organisationId, async (db) => {
      const frameworks = await listSrsFrameworkStates(db);
      const snapshots = await listSrsFrameworkSnapshots(db);
      const history = await listSrsFrameworkHistory(db);
      const workingId = await srsWorkingDefinitionId(db);
      return { frameworks, snapshots, history, active: await getSrsFramework(db), working: workingId ? await getSrsFramework(db, workingId) : null };
    });
  } catch {
    data = null;
  }
  if (data === null) {
    return <section className="nz-a-state" role="alert"><h1>The SRS frameworks could not be read</h1><p>They are unavailable just now. Nothing is shown rather than a framework that might be incomplete.</p></section>;
  }

  const editing = !holds(access.capabilities, "admin.lookups") ? { allowed: false as const, reason: "Your role can see the frameworks but not change them — that needs admin.lookups." }
    : serviceEnvironment().writes !== "enabled" ? { allowed: false as const, reason: "Writes are switched off in this environment, so the frameworks are read-only here." }
    : { allowed: true as const };
  return <SrsFrameworkBoard {...data} editing={editing} />;
}
