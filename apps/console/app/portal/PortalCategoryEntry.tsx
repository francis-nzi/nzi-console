"use client";
// UX1d-2 — one client-portal accordion section's non-spend entry surface, built
// on the shared `EmissionEntryForm` (audience `portal`). Constrained to one
// authorised bucket grant at a time; factor + unit come from the bucket's
// authorised set; entries are drafts that submit to NZI review.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PortalDataEntryRecord } from "@nzi/isolated-backend";
import { EmissionEntryForm } from "../jobs/EmissionEntryForm";
import {
  emissionEntryDraftToPortalRecord,
  type EmissionEntryDraft,
  type RegistrationLookupOutcome,
} from "../jobs/emissionEntryModel";
import type { PortalAccordionSection, PortalBucket } from "./portalEntryGrouping";
import { redirectIfPortalSessionEnded } from "./portalSessionClient";

export function PortalCategoryEntry({
  jobId,
  section,
  buckets,
  reportingMonths,
}: {
  jobId: string;
  section: PortalAccordionSection;
  buckets: PortalBucket[];
  reportingMonths: string[];
}) {
  const [bucketId, setBucketId] = useState(buckets[0]?.bucketGrantId ?? "");
  const bucket = useMemo(() => buckets.find(item => item.bucketGrantId === bucketId) ?? buckets[0], [buckets, bucketId]);
  const [records, setRecords] = useState<PortalDataEntryRecord[] | null>(null);
  const [factorId, setFactorId] = useState(bucket?.factors[0]?.id ?? "");
  const [siteId, setSiteId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/portal/jobs/${jobId}/data-entry-records`, { cache: "no-store" });
      if (await redirectIfPortalSessionEnded(response)) return;
      const body = await response.json();
      if (!response.ok || !Array.isArray(body.records)) throw new Error(body.message ?? "Your entries are unavailable.");
      const codes = new Set(buckets.map(item => item.bucketGrantId));
      setRecords((body.records as PortalDataEntryRecord[]).filter(record => codes.has(record.bucketGrantId)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Your entries are unavailable.");
      setRecords(null);
    }
  }, [jobId, buckets]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setFactorId(bucket?.factors[0]?.id ?? ""); }, [bucket]);

  if (!bucket) return null;

  const portalLookup = async (registration: string): Promise<RegistrationLookupOutcome> => {
    try {
      const response = await fetch(`/api/portal/jobs/${jobId}/vehicle-lookup`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ registration }),
      });
      const body = await response.json();
      if (!response.ok) return { ok: false, message: body.message ?? "Vehicle lookup failed — enter it manually." };
      return {
        ok: true,
        make: body.vehicle?.make ?? null,
        fuelType: body.vehicle?.fuelType ?? null,
        suggestedClass: body.suggestedClass ?? "vehicle",
        year: body.vehicle?.yearOfManufacture ?? null,
      };
    } catch {
      return { ok: false, message: "Vehicle lookup failed — enter it manually." };
    }
  };

  const submitDraft = async (draft: EmissionEntryDraft, andSubmit: boolean) => {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    const mapped = emissionEntryDraftToPortalRecord({ ...draft, factorId: factorId || draft.factorId }, bucket, { id: siteId || null });
    if ("error" in mapped) { setBusy(false); setError(mapped.error); return; }
    try {
      const response = await fetch(`/api/portal/jobs/${jobId}/data-entry-records`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(mapped),
      });
      if (await redirectIfPortalSessionEnded(response)) return;
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "The draft could not be saved.");
      if (andSubmit && typeof body.recordId === "string" && typeof body.version === "number") {
        const submit = await fetch(`/api/portal/jobs/${jobId}/data-entry-records`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "submit", recordId: body.recordId, expectedVersion: body.version }),
        });
        if (!submit.ok) { await load(); throw new Error("Saved as a draft, but it could not be submitted. Submit it from the list below."); }
      }
      setNotice(andSubmit ? "Submitted to NZI for review. It is not counted as emissions until a reviewer accepts it." : "Saved as a draft. Submit it below when you are ready.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The draft outcome could not be verified.");
    } finally {
      setBusy(false);
    }
  };

  const act = async (record: PortalDataEntryRecord, action: "submit" | "delete") => {
    if (action === "delete" && !window.confirm("Delete this draft?")) return;
    setPending(`${action}:${record.recordId}`); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/portal/jobs/${jobId}/data-entry-records`, {
        method: action === "delete" ? "DELETE" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, recordId: record.recordId, expectedVersion: record.version }),
      });
      if (await redirectIfPortalSessionEnded(response)) return;
      if (response.status === 409) { await load(); throw new Error("This draft changed elsewhere. The latest version has been loaded."); }
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? `The draft could not be ${action}ed.`);
      setNotice(action === "submit" ? "Submitted to NZI for review." : "Draft deleted.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The entry outcome could not be verified.");
    } finally {
      setPending("");
    }
  };

  return (
    <div style={{ marginTop: 10 }}>
      {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}
      {notice ? <div className="nz-banner ok" role="status">{notice}</div> : null}
      {buckets.length > 1 ? (
        <label className="nz-fl">Authorised source
          <select className="nz-sel" value={bucket.bucketGrantId} onChange={event => setBucketId(event.target.value)}>
            {buckets.map(item => <option key={item.bucketGrantId} value={item.bucketGrantId}>{item.sourceLabel}</option>)}
          </select>
        </label>
      ) : <p className="nz-hint">Providing data for <b>{bucket.sourceLabel}</b>.</p>}
      {bucket.factors.length > 1 ? (
        <label className="nz-fl">Authorised factor
          <select className="nz-sel" value={factorId} onChange={event => setFactorId(event.target.value)}>
            {bucket.factors.map(option => <option key={option.id} value={option.id}>{option.label} · {option.unit}</option>)}
          </select>
        </label>
      ) : null}
      {bucket.sites.length ? (
        <label className="nz-fl">Site
          <select className="nz-sel" value={siteId} onChange={event => setSiteId(event.target.value)}>
            <option value="">No site</option>
            {bucket.sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}
          </select>
        </label>
      ) : null}
      <EmissionEntryForm
        key={bucket.bucketGrantId}
        category={section.category}
        audience="portal"
        site={{ id: siteId || null, label: bucket.sites.find(site => site.id === siteId)?.name ?? "No site" }}
        factors={bucket.factors.map(option => ({ id: option.id, label: option.label, unit: option.unit }))}
        units={bucket.units}
        reportingMonths={reportingMonths}
        spendCategories={bucket.pgsCategories}
        busy={busy}
        onCancel={() => undefined}
        onSubmit={draft => submitDraft(draft, true)}
        onSaveDraft={draft => submitDraft(draft, false)}
        onLookupRegistration={portalLookup}
      />
      <div className="nz-panel" style={{ marginTop: 12, padding: 0 }}>
        <table className="nz-tbl">
          <thead><tr><th>Entry</th><th className="num">Amount</th><th>Status</th><th /></tr></thead>
          <tbody>
            {records?.map(record => (
              <tr key={record.recordId}>
                <td><b>{record.note || "Entry"}</b></td>
                <td className="num">{record.detail?.netValue ?? record.quantity} {record.unit}</td>
                <td><span className={`nz-st ${record.status === "submitted" ? "est" : "need"}`}>{record.status === "submitted" ? "With NZI" : "Draft"}</span></td>
                <td style={{ textAlign: "right" }}>{record.status === "draft" ? (
                  <>
                    <button className="nz-btn" disabled={pending !== ""} onClick={() => void act(record, "delete")}>Delete</button>{" "}
                    <button className="nz-btn pri" disabled={pending !== ""} onClick={() => void act(record, "submit")}>Submit for review</button>
                  </>
                ) : <span className="muted">Awaiting NZI review</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {records === null ? <div className="nz-table-empty">Your entries are unavailable.</div> : records.length === 0 ? <div className="nz-table-empty">No entries yet.</div> : null}
      </div>
    </div>
  );
}
