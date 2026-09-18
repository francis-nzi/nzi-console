import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderInputSpec, type InputSpecCategory } from "@nzi/contracts";
import { emissionEntryActions, type EntryAudience, type EntryMode } from "../../app/jobs/emissionEntryModel";

/**
 * Every render the **live** path can produce, as one deterministic structure.
 *
 * This used to call the hand-written model. It now renders the governed spec through
 * `renderInputSpec` — the same interpreter the surfaces call — so the golden proves the path a
 * consultant and a client actually go through rather than a model nothing reads any more.
 *
 * The spec is read from `inputSpec.seed.json`, the fixture the migration was generated from.
 * That is one half of the proof and is knowingly not the whole of it: a fixture could drift from
 * what `0093` actually seeded. The other half lives in `inputSpecReproducesGolden.test.ts`, which
 * loads the spec out of a real Postgres and checks the same 160 renders. Together they say the
 * database, the fixture and the golden all agree; alone, neither would.
 */

// Four levels: this file lives in tests/support, one deeper than the suites in tests/.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SEED = join(ROOT, "apps/console/tests/fixtures/inputSpec.seed.json");

export type RenderKey = `${string}|${EntryAudience}|${EntryMode}|${"lean" | "full"}`;

export type RenderedField = {
  key: string;
  label: string;
  control: string;
  hint?: string;
  optional?: boolean;
};

export type RenderedEntry = {
  fields: RenderedField[];
  actions: Array<{ key: string; label: string; variant: string }>;
  units: string[];
  manualHint: string;
};

const AUDIENCES: EntryAudience[] = ["crm", "portal"];
const MODES: EntryMode[] = ["new", "existing"];

export const seededSpec = (): InputSpecCategory[] =>
  JSON.parse(readFileSync(SEED, "utf8")) as InputSpecCategory[];

export function renderMatrix(): Record<RenderKey, RenderedEntry> {
  const out: Record<string, RenderedEntry> = {};
  for (const category of seededSpec()) {
    for (const audience of AUDIENCES) {
      for (const mode of MODES) {
        for (const lean of [false, true]) {
          const key: RenderKey = `${category.categoryCode}|${audience}|${mode}|${lean ? "lean" : "full"}`;
          out[key] = {
            fields: renderInputSpec(category, audience, mode, lean),
            actions: emissionEntryActions(audience, mode).map((action) => ({
              key: action.key, label: action.label, variant: action.variant,
            })),
            units: category.units,
            manualHint: category.manualEntryHint,
          };
        }
      }
    }
  }
  return out as Record<RenderKey, RenderedEntry>;
}

/** The two exemplars the brief asks to be scrutinised hardest, resolved from the seeded spec. */
export const specFor = (code: string): InputSpecCategory =>
  seededSpec().find((category) => category.categoryCode === code)!;
export const ELECTRICITY = (): InputSpecCategory => specFor("2.purchased-electricity");
export const COMPANY_VEHICLE = (): InputSpecCategory => specFor("1.company-vehicles");
