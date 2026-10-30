# DESNZ 2019 flat file — committed extract

`factors-by-category-2019.json` is the "Factors by Category" sheet of `conversion-factors-2019-flat-file-v01-02.xls` (the UK Government GHG
Conversion Factors for Company Reporting, 2019): every data row (6,990), the eleven columns Scope · Level 1–4 · Column Text · UOM (simple) ·
UOM · GHG · Lookup · GHG Conversion Factor 2019. The source file's sha256 is in the extract's `source.sha256`
(`82461e6d6ad2a499a3a405ef353334178d38931221cce80a3575def0a9149c5e`). Numbers are the sheet's doubles rounded to 12 significant digits
(removing binary noise such as `0.13483000000000003`); text is whitespace-trimmed; blank cells stay blank (825 value cells are empty and 2 read
"< 1" — they are reported as "no number in the source", never as zero).

DESNZ 2019 carries no row ids; its natural key is the composite (Scope, Level 1–4, Column Text, UOM, GHG), unique across all 6,990 rows.

To regenerate (SheetJS is not a repo dependency; install it in a scratch directory): read the sheet with `sheet_to_json(..., { header: 1 })`, keep the
rows whose first cell is `Scope n` or `Outside of Scopes`, and write `{ source: { file, sheet, sha256, sheetDataRows, header }, rows }`. The
`v7Desnz2019.test.ts` suite pins the row count, the kg CO2e count (2,724) and one known value (long-haul · business · With RF = 0.43446).
