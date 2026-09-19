import type { EntryExtractionModel, ExtractionOutcome, ExtractionRequest } from "@nzi/contracts";
import type { Queryable } from "./postgres";

/**
 * A deterministic extractor, standing in for a model that has not been chosen (NZC-111).
 *
 * It contains no intelligence and is not meant to. Its job is to make the loop above it — propose,
 * confirm, commit — provable end to end without a network call, so the thing that actually matters
 * (that nothing reaches the store without a human confirming) is tested against real behaviour
 * rather than a mock of it.
 *
 * **Same seam as the real one.** When a provider is chosen it satisfies `EntryExtractionModel` and
 * nothing above changes. The adapter for it will hold no rules, take its key as an argument rather
 * than reading the environment, and accept an injected `fetch` — the shape `answerModel.ts`
 * already established for the staff help system.
 *
 * **It cannot reach the network.** There is no `fetch` here and no client to configure. A test can
 * assert that structurally, which is a stronger statement than an unset key: this does not decline
 * to call out, it has nothing to call out with.
 *
 * ## The factor it proposes is the job's own
 *
 * Even a stub must not invent a factor. It reads the datasets the job has actually selected and
 * proposes a row from those, so a proposal is tenant-scoped by construction and a confirmation
 * cannot smuggle in a factor the job never chose — the ordinary command would refuse it anyway,
 * and agreeing with that refusal in advance is what makes the proposal honest.
 */

/** Words that suggest a category, in the order they are tried. Deliberately trivial. */
const HINTS: Array<{ match: RegExp; categoryCode: string; scope: string; unit: string; factorHint: RegExp }> = [
  { match: /electric|kwh|grid|power/i, categoryCode: "2.purchased-electricity", scope: "2", unit: "kWh", factorHint: /electric|grid/i },
  { match: /diesel|petrol|van|car|fleet|vehicle|mile/i, categoryCode: "1.company-vehicles", scope: "1", unit: "litres", factorHint: /diesel|petrol|vehicle/i },
];

const NUMBER = /(-?\d[\d,]*(?:\.\d+)?)/;

export function entryExtractionStub(db: Queryable): EntryExtractionModel {
  return {
    async propose(request: ExtractionRequest): Promise<ExtractionOutcome> {
      const text = String(request.text ?? "");
      // Whatever the text says, it is only ever read for these patterns. There is no branch in
      // which its content becomes an instruction, which is the property the real model's output is
      // held to as well — it can propose, and a person disposes.
      const hint = HINTS.find((candidate) => candidate.match.test(text));
      if (!hint) {
        return { kind: "abstained", reason: "Nothing in that describes an activity I can place." };
      }

      const quantity = (() => {
        const found = NUMBER.exec(text);
        if (!found) return null;
        const parsed = Number(found[1]!.replace(/,/g, ""));
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
      })();

      // The job's own datasets, never the whole catalogue.
      const { rows } = await db.query<{ dataset_id: string; factor_id: string; label: string; activity_unit: string }>(
        `SELECT f.dataset_id, f.factor_id, f.label, f.activity_unit
           FROM nzi_console.emission_factors f
           JOIN nzi_console.job_dataset_selections s
             ON (s.organisation_id,s.dataset_id)=(f.organisation_id,f.dataset_id)
          WHERE s.job_id=$1 AND f.active=true
          ORDER BY f.factor_id`, [request.jobId]);
      const factor = rows.find((row) => hint.factorHint.test(row.label)) ?? null;

      const proposal = {
        categoryCode: hint.categoryCode,
        scope: hint.scope,
        sourceLabel: factor?.label ?? null,
        quantity,
        unit: factor?.activity_unit ?? hint.unit,
        datasetId: factor?.dataset_id ?? null,
        factorId: factor?.factor_id ?? null,
        gaps: [] as string[],
      };
      // What it could not determine, named — so a surface can ask about exactly those rather than
      // presenting a confident blank.
      proposal.gaps = (["quantity", "datasetId", "factorId", "sourceLabel"] as const)
        .filter((field) => proposal[field] === null);

      return { kind: "proposal", proposal };
    },
  };
}
