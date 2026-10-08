"use client";

// Phase 3b (0162, ruled 8 Oct 2026) — the client's reporting template, offered where data capture starts. A CRP job is
// seeded from it on creation when the client has one; this is the manual seed for a job that gains a template later, or
// to fill the gaps a newer version adds (a line already on the job is never duplicated). It replaces JW-6's "Add rows from
// template" search and "Reuse Previous Year Rows" blocks: the rows are already there from the template.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { postBrowserCommand } from "@nzi/api-client";
import type { JobTemplateSeedingReadModel, TemplateSeedResult } from "@nzi/contracts";
import { formatDate } from "../lib/formatDate";
import { seedOutcomeText } from "./jobTemplateSeedingText";

type Notice = (notice: { kind: "ok" | "warn"; text: string }) => void;

export function JobTemplateSeeding({ jobId, notice }: { jobId: string; notice: Notice }) {
  const router = useRouter();
  const [state, setState] = useState<{ kind: "loading" } | { kind: "failed" } | { kind: "ready"; seeding: JobTemplateSeedingReadModel | null }>({ kind: "loading" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotency = useRef<string | null>(null);
  const path = `/api/isolated/jobs/${encodeURIComponent(jobId)}/template-seeding`;

  const load = useCallback(async () => {
    try {
      const response = await fetch(path, { cache: "no-store" });
      const body = await response.json() as { seeding?: JobTemplateSeedingReadModel | null };
      if (!response.ok) throw new Error();
      setState({ kind: "ready", seeding: body.seeding ?? null });
    } catch { setState({ kind: "failed" }); }
  }, [path]);
  useEffect(() => { void load(); }, [load]);

  // A failed read says so; it never pretends there is no template.
  if (state.kind === "loading") return null;
  if (state.kind === "failed") return <div className="nz-seed-template" role="status"><p className="sub">The reporting template could not be read. <button type="button" className="nz-btn sm" onClick={() => void load()}>Retry</button></p></div>;
  const seeding = state.seeding;
  if (!seeding || seeding.templateVersion === null) return null;

  async function seed(version: number) {
    setPending(true); setError(null);
    idempotency.current ??= crypto.randomUUID();
    const result = await postBrowserCommand<TemplateSeedResult>(path, { expectedTemplateVersion: version }, idempotency.current);
    setPending(false);
    idempotency.current = null;
    if (result.state === "success") {
      notice({ kind: result.data.seeded > 0 ? "ok" : "warn", text: seedOutcomeText(result.data) });
      await load();
      router.refresh();
    } else if (result.state === "conflict") {
      setError("The template changed since this page loaded — it has been re-read; seed again to use the new version.");
      await load();
    } else setError(result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.message);
  }

  const current = seeding.seededTemplateVersion === seeding.templateVersion;
  return (
    <div className="nz-seed-template" aria-label="Reporting template">
      <div>
        <b>Reporting template v{seeding.templateVersion}</b> · {seeding.lineCount} line{seeding.lineCount === 1 ? "" : "s"}
        <p className="sub">
          {!seeding.configured ? "Set the job's reporting period first — the template is seeded once the job has one."
            : seeding.seededTemplateVersion === null ? "Not yet seeded: the template's lines become this job's entries, ready for their figures."
            : current ? `Seeded from v${seeding.seededTemplateVersion}${seeding.seededAt ? ` on ${formatDate(seeding.seededAt.slice(0, 10))}` : ""}. Lines added to the template since, or removed here, can be filled in again.`
            : `Seeded from v${seeding.seededTemplateVersion}; the client's template is now v${seeding.templateVersion}. Fill the gaps to add its new lines — nothing already here is duplicated.`}
        </p>
        {error ? <p className="nz-hint bad" role="alert">{error}</p> : null}
      </div>
      {seeding.configured ? (
        <button type="button" className={`nz-btn${seeding.seededTemplateVersion === null ? " pri" : ""}`} disabled={pending} onClick={() => void seed(seeding.templateVersion!)}>
          {pending ? "Seeding…" : seeding.seededTemplateVersion === null ? "Seed from template" : "Fill gaps from template"}
        </button>
      ) : null}
    </div>
  );
}
