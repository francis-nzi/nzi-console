// B4 — a real CSV reader for the spend import (NZC-036, decision D1: CSV-first,
// the .xlsx round-trip is a later slice). RFC 4180-ish: quoted fields may contain
// the delimiter, embedded newlines and doubled quotes. Delimiter and encoding are
// detected. Every cell is neutralised against CSV/formula injection on the way in.

export type DelimitedTable = { delimiter: "," | ";" | "\t"; headers: string[]; rows: string[][] };

const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/** A leading =, +, -, @, tab or CR makes a spreadsheet treat the cell as a formula. Prefix it so it is always text. */
export function neutraliseCell(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

const detectDelimiter = (firstLine: string): DelimitedTable["delimiter"] => {
  const counts: Array<[DelimitedTable["delimiter"], number]> = [
    ["\t", (firstLine.match(/\t/g) ?? []).length],
    [";", (firstLine.match(/;/g) ?? []).length],
    [",", (firstLine.match(/,/g) ?? []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ",";
};

/** Parse the full text into rows of raw string cells, honouring quotes. */
function parseRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; }
        else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === delimiter) { row.push(cell); cell = ""; continue; }
    if (char === "\r") continue;
    if (char === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; continue; }
    cell += char;
  }
  if (cell !== "" || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

export function parseDelimited(raw: string): DelimitedTable {
  const text = stripBom(raw).trimEnd();
  if (!text.trim()) return { delimiter: ",", headers: [], rows: [] };
  const delimiter = detectDelimiter(text.split("\n", 1)[0] ?? "");
  const all = parseRows(text, delimiter)
    .map((cells) => cells.map((cell) => neutraliseCell(cell.trim())))
    .filter((cells) => cells.some((cell) => cell !== ""));
  if (all.length === 0) return { delimiter, headers: [], rows: [] };
  const [headers, ...rows] = all;
  return { delimiter, headers: headers!, rows };
}
