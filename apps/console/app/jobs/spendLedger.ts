// Pure helpers for the spend-ledger adapter (Phase 2 vertical slice,
// docs/REDESIGN_ROLLOUT.md). Parsing and category suggestion are deterministic
// and side-effect-free so they can be unit-tested without a browser.

export type SpendLedgerLine = {
  description: string;
  netValue: number | null;
  vatPercent: number | null;
  glCode: string | null;
  invoiceDate: string | null; // ISO yyyy-mm-dd, or null
};

const HEADER_HINTS = ["description", "narrative", "detail", "supplier", "net", "amount", "value", "vat", "gl", "nominal", "code", "date"];
const num = (raw: string): number | null => {
  const cleaned = raw.replace(/[£$€,\s]/g, "").replace(/%$/, "");
  if (cleaned === "" || Number.isNaN(Number(cleaned))) return null;
  return Number(cleaned);
};
const isoDate = (raw: string): string | null => {
  const trimmed = raw.trim();
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(trimmed); // dd/mm/yyyy (UK)
  if (match) {
    const year = match[3]!.length === 2 ? `20${match[3]}` : match[3];
    return `${year}-${match[2]!.padStart(2, "0")}-${match[1]!.padStart(2, "0")}`;
  }
  return null;
};

function splitRow(row: string): string[] {
  if (row.includes("\t")) return row.split("\t").map((cell) => cell.trim());
  if (row.includes(",")) {
    // Rejoin a "1,234.56"-style amount that comma-splitting broke apart.
    const parts = row.split(",").map((cell) => cell.trim());
    const merged: string[] = [];
    for (const part of parts) {
      const previous = merged[merged.length - 1];
      if (previous !== undefined && /[£$€]?\d{1,3}$/.test(previous) && /^\d{3}(\.\d+)?$/.test(part)) merged[merged.length - 1] = `${previous}${part}`;
      else merged.push(part);
    }
    return merged;
  }
  return row.split(/\s{2,}/).map((cell) => cell.trim());
}

/**
 * Parse pasted ledger text. Columns may be tab-, comma-, or wide-space-separated.
 * A header row (containing words like "description", "net", "vat", "gl", "date")
 * maps columns by name; otherwise the order is description, net, vat, gl, date.
 */
export function parseSpendLedger(text: string): SpendLedgerLine[] {
  const rows = text.split(/\r?\n/).filter((row) => row.trim() !== "");
  if (rows.length === 0) return [];

  const first = splitRow(rows[0]!).map((cell) => cell.toLowerCase());
  const looksLikeHeader = first.filter((cell) => HEADER_HINTS.some((hint) => cell.includes(hint))).length >= 2;

  const index = { description: 0, net: 1, vat: 2, gl: 3, date: 4 };
  if (looksLikeHeader) {
    first.forEach((cell, position) => {
      if (/desc|narrat|detail|supplier/.test(cell)) index.description = position;
      else if (/net|amount|value/.test(cell)) index.net = position;
      else if (/vat/.test(cell)) index.vat = position;
      else if (/gl|nominal|code/.test(cell)) index.gl = position;
      else if (/date/.test(cell)) index.date = position;
    });
  }

  return rows
    .slice(looksLikeHeader ? 1 : 0)
    .map((row) => {
      const cells = splitRow(row);
      return {
        description: cells[index.description]?.trim() ?? "",
        netValue: cells[index.net] !== undefined ? num(cells[index.net]!) : null,
        vatPercent: cells[index.vat] !== undefined ? num(cells[index.vat]!) : null,
        glCode: cells[index.gl]?.trim() || null,
        invoiceDate: cells[index.date] !== undefined ? isoDate(cells[index.date]!) : null,
      };
    })
    .filter((line) => line.description !== "");
}

export type LedgerMonthlySlot = { month: string; quantity: number | null };

/**
 * Monthly split "where the ledger carries it" (NZC-032): a spend line carries one
 * invoice date, so its whole net value lands in that calendar month. Returns a
 * slot vector spanning the job's reporting months (each month once, in order) with
 * the value on the invoice month and `null` elsewhere — the shape the
 * `emission.source.create` command validates and sums into the annual quantity.
 * Returns `null` when the line cannot be split: no invoice date, no reporting
 * months, or an invoice date that falls outside the reporting period.
 */
export function monthlySlotsForLine(invoiceDate: string | null, netValue: number | null, reportingMonths: string[]): LedgerMonthlySlot[] | null {
  if (!invoiceDate || netValue === null || reportingMonths.length === 0) return null;
  const invoiceMonth = invoiceDate.slice(0, 7);
  if (!reportingMonths.includes(invoiceMonth)) return null;
  return reportingMonths.map((month) => ({ month, quantity: month === invoiceMonth ? netValue : null }));
}

/**
 * Advisory, grounded category suggestion (NZC-018): a deterministic word-overlap
 * match of the line description against the job's own controlled PG&S category
 * names. It never auto-applies — the consultant confirms. Returns the best
 * candidate name, or null when nothing overlaps.
 */
export function suggestCategory(description: string, categories: Array<{ name: string }>): string | null {
  const words = new Set(
    description
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4),
  );
  if (words.size === 0) return null;
  let best: { name: string; score: number } | null = null;
  for (const category of categories) {
    const score = category.name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4 && words.has(word)).length;
    if (score > 0 && (!best || score > best.score)) best = { name: category.name, score };
  }
  return best?.name ?? null;
}
