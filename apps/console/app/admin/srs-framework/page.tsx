import { getSrsFramework, listSrsFrameworkVersions, withTenantRead, type SrsFrameworkVersion } from "@nzi/isolated-backend";
import type { SrsFramework } from "@nzi/contracts";
import { serviceEnvironment } from "../../lib/environment";
import { isolatedPool } from "../../lib/isolatedDatabase";
import { adminAccess, holds } from "../adminAccess";
import { SrsFrameworkBoard } from "./SrsFrameworkBoard";

export const dynamic = "force-dynamic";

/**
 * SRS framework (SRS S1, R1): the UK SRS standards, pillars, requirements, weights and maturity ladder as versions an
 * Admin manages — a draft copied from the version in force, edited, then published to supersede it. A published version
 * never changes, so every assessment keeps meaning what it meant. Read whole: one framework, a few dozen requirements.
 */
export default async function SrsFrameworkPage() {
  const access = await adminAccess();
  if (access.state !== "allowed") return null; // The layout states why; nothing is read.

  let data: { versions: SrsFrameworkVersion[]; active: SrsFramework | null; draft: SrsFramework | null } | null = null;
  try {
    data = await withTenantRead(isolatedPool(), access.organisationId, async (db) => {
      const versions = await listSrsFrameworkVersions(db);
      const draftId = versions.find((version) => version.status === "draft")?.frameworkId ?? null;
      return { versions, active: await getSrsFramework(db), draft: draftId ? await getSrsFramework(db, draftId) : null };
    });
  } catch {
    data = null;
  }
  if (data === null) {
    return <section className="nz-a-state" role="alert"><h1>The SRS framework could not be read</h1><p>It is unavailable just now. Nothing is shown rather than a framework that might be incomplete.</p></section>;
  }

  const editing = !holds(access.capabilities, "admin.lookups") ? { allowed: false as const, reason: "Your role can see the framework but not change it — that needs admin.lookups." }
    : serviceEnvironment().writes !== "enabled" ? { allowed: false as const, reason: "Writes are switched off in this environment, so the framework is read-only here." }
    : { allowed: true as const };
  return <SrsFrameworkBoard versions={data.versions} active={data.active} draft={data.draft} editing={editing} />;
}
