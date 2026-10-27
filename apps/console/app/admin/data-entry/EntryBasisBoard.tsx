"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { putBrowserCommand } from "@nzi/api-client";
import { ENTRY_BASES, ENTRY_BASIS_LABEL, scopeMeta, type EntryBasis, type EntryBasisDefaultRow } from "@nzi/contracts";

/**
 * The default basis per category (D1, R4), grouped by scope. Choosing one saves it at once — versioned per category and audited
 * (admin.entryBasis.update). A category with no setting shows its seed, marked as such.
 */
export function EntryBasisBoard({ rows, editing }: { rows: EntryBasisDefaultRow[]; editing: { allowed: true } | { allowed: false; reason: string } }) {
  const router = useRouter();
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const keys = useRef(new Map<string, string>());
  const readOnly = !editing.allowed;

  async function choose(row: EntryBasisDefaultRow, basis: EntryBasis) {
    if (saving || readOnly || (row.setting ?? row.seed) === basis) return;
    setSaving(row.categoryCode); setError(null); setNotice(null);
    const attempt = `${row.categoryCode}:${basis}:${row.version ?? 0}`;
    if (!keys.current.has(attempt)) keys.current.set(attempt, crypto.randomUUID());
    try {
      const result = await putBrowserCommand("/api/isolated/entry-basis-defaults",
        { categoryCode: row.categoryCode, defaultBasis: basis, expectedVersion: row.version }, keys.current.get(attempt)!);
      if (result.state !== "success") {
        setError(result.state === "validation_failed" ? result.issues.map((issue) => issue.message).join(" ")
          : result.state === "conflict" ? "This setting changed since the page loaded. Reload to see the latest." : result.message);
        return;
      }
      keys.current.delete(attempt);
      setNotice(`${row.name} now opens on ${ENTRY_BASIS_LABEL[basis]}.`);
      router.refresh();
    } finally { setSaving(null); }
  }

  return <section className="nz-a-card nz-a-basis" aria-labelledby="basis-title">
    <div className="nz-a-panel-title">
      <h2 id="basis-title">Default basis by category</h2>
      <span className="nz-a-hint">Seed: PG&amp;S = Spend · every other category = Activity</span>
    </div>
    {error ? <div className="nz-a-error" role="alert">{error}</div> : null}
    {notice ? <div className="nz-a-notice" role="status">{notice}</div> : null}
    {readOnly ? <p className="nz-a-hint nz-a-basis-ro">{editing.reason}</p> : null}
    {(["1", "2", "3"] as const).map((scope) => (
      <div key={scope} className="nz-a-basis-group">
        <div className="nz-a-basis-scope">{scopeMeta[scope].label}</div>
        {rows.filter((row) => row.scope === scope).map((row) => {
          const current = row.setting ?? row.seed;
          return <div key={row.categoryCode} className="nz-a-basis-row" data-category={row.categoryCode}>
            <div className="nz-a-basis-name"><b>{row.name}</b><span className="nz-a-mono">{row.categoryCode}</span></div>
            <div className="nz-a-basis-state">{row.setting ? `Set · v${row.version}` : "Seed"}</div>
            <div className="nz-a-seg" role="radiogroup" aria-label={`${row.name} opens on`}>
              {ENTRY_BASES.map((basis) => (
                <button key={basis} type="button" role="radio" aria-checked={current === basis} className={current === basis ? "on" : undefined}
                  disabled={readOnly || saving !== null} onClick={() => void choose(row, basis)}>{ENTRY_BASIS_LABEL[basis]}</button>
              ))}
            </div>
          </div>;
        })}
      </div>
    ))}
  </section>;
}
