import type { ReactNode } from "react";

/**
 * Governance rendered as UI (docs/design/admin-design-notes.md): where a record came from, whether it is live, which
 * capability governs it, which environment the screen writes to, and that a change is audited. Each is a small,
 * labelled element — meaning is carried by text, never by colour alone.
 *
 * These render under the admin section's `.nz-admin` root (NZC-167) and use its tokens.
 */

/** Where a record came from: imported from v7, added in the console, or seeded from a reference source. */
export type Provenance = "v7" | "added" | "seeded";
const PROVENANCE_LABEL: Record<Provenance, string> = { v7: "Imported · v7", added: "Added here", seeded: "Seeded" };

export function ProvenanceBadge({ provenance }: { provenance: Provenance }) {
  return <span className="nz-a-prov">{PROVENANCE_LABEL[provenance]}</span>;
}

/** Active or inactive — a deactivated record is kept, never deleted, and still resolves where it is used. */
export function StatusBadge({ active }: { active: boolean }) {
  return <span className={`nz-a-badge ${active ? "ok" : "off"}`}><i aria-hidden="true" />{active ? "Active" : "Inactive"}</span>;
}

/** The capability that governs the screen's writes, shown by the title (e.g. `admin.lookups`). */
export function CapabilityChip({ capability }: { capability: string }) {
  return <span className="nz-a-cap" title={`Changes here need the ${capability} capability`}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 6v5c0 4 3 7 7 9 4-2 7-5 7-9V6z" /></svg>
    <span className="nz-sr-only">Governed by </span>{capability}
  </span>;
}

/**
 * The environment the screen reads and writes. `label` comes from the service's own health report, never a constant,
 * so the badge cannot say "Staging" on a service that is not.
 */
export function EnvBadge({ label, detail }: { label: string; detail?: string }) {
  return <span className="nz-a-env" title={detail}><i aria-hidden="true" />{label}</span>;
}

/** The drawer footer's reminder that a change is recorded, with the record's current version where it has one. */
export function AuditLine({ version, children }: { version?: number | "new"; children?: ReactNode }) {
  const suffix = version === undefined ? "" : version === "new" ? " · new" : ` · v${version}`;
  return <div className="nz-a-audit">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 6v5c0 4 3 7 7 9 4-2 7-5 7-9V6z" /></svg>
    <span>{children ?? "Every change is recorded in the audit log"}{suffix}</span>
  </div>;
}
