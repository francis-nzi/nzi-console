import type { DatasetOption } from "@nzi/contracts";

/**
 * Phase 3c (JW-2) — the editions a job could add by exception, in the order a person should consider them: the ones that
 * fit the job cleanly first (`applicable`: no warning — the period covered, the job's geography, an active edition), then
 * the job's own country before others, then the newest edition first. Each says what it is in one line — its derived
 * label, the years it is valid for, and how many warnings it would carry (shown in full below the picker).
 */
export type DatasetAddOption = { datasetId: string; text: string; applicable: boolean; warnings: string[] };

const year = (date: string) => date.slice(0, 4);

export function datasetAddOptions(datasets: readonly DatasetOption[]): DatasetAddOption[] {
  return datasets
    .filter((dataset) => !dataset.selected)
    .slice()
    .sort((a, b) =>
      Number(b.applicable) - Number(a.applicable)
      || Number(b.countryCode === b.jobCountryCode) - Number(a.countryCode === a.jobCountryCode)
      || b.validTo.localeCompare(a.validTo)
      || a.label.localeCompare(b.label))
    .map((dataset) => {
      const valid = year(dataset.validFrom) === year(dataset.validTo) ? year(dataset.validFrom) : `${year(dataset.validFrom)}–${year(dataset.validTo)}`;
      const notes = [
        dataset.warnings.length ? `${dataset.warnings.length} warning${dataset.warnings.length === 1 ? "" : "s"}` : null,
        dataset.synthetic ? "demonstration data" : null,
      ].filter((note): note is string => note !== null);
      return { datasetId: dataset.datasetId, text: `${dataset.label} · valid ${valid}${notes.length ? ` · ${notes.join(" · ")}` : ""}`, applicable: dataset.applicable, warnings: dataset.warnings };
    });
}
