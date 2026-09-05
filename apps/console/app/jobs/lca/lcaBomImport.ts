// Track C — pure helpers for the LCA inventory bulk-paste BOM import (L2;
// NZC-054/056). Deterministic and side-effect-free so they're unit-testable
// without a browser. Mirrors vehicleBulk.ts's column-sniffing convention.
import { lcaModuleCodes, type LcaModuleCode } from "@nzi/contracts";

export type BomLine = {
  moduleCode: LcaModuleCode | null;
  lineLabel: string;
  quantity: number | null;
  unit: string;
  originCountry: string | null;
};

const HEADER_HINTS = ["module", "en 15804", "line", "label", "material", "component", "description", "quantity", "mass", "weight", "unit", "origin", "country"];
const num = (raw: string): number | null => {
  const cleaned = raw.replace(/[,\s]/g, "").replace(/(kg|g|litres?|liters?|kwh|m3|m2|units?)$/i, "");
  if (cleaned === "" || Number.isNaN(Number(cleaned))) return null;
  return Number(cleaned);
};

function splitRow(row: string): string[] {
  if (row.includes("\t")) return row.split("\t").map((cell) => cell.trim());
  if (row.includes(",")) return row.split(",").map((cell) => cell.trim());
  return row.split(/\s{2,}/).map((cell) => cell.trim());
}

/** Match free-text to one of the canonical EN 15804 module codes, or null. */
export function matchModuleCode(raw: string): LcaModuleCode | null {
  const text = raw.trim().toUpperCase();
  if (!text) return null;
  const exact = lcaModuleCodes.find((code) => code === text);
  if (exact) return exact;
  // "A1-A3", "A1" of "A1 raw material supply", etc. — take the first valid code mentioned.
  const match = text.match(/\b(A[1-5]|B[1-7]|C[1-4]|D)\b/);
  return match ? (match[1] as LcaModuleCode) : null;
}

/**
 * Parse pasted BOM rows. Columns may be tab-, comma-, or wide-space-
 * separated. A header row maps columns by name; otherwise the order is
 * module, label, quantity, unit, origin country. Rows with no recognisable
 * label and no quantity are dropped (blank paste padding).
 */
export function parseLcaBomLines(text: string): BomLine[] {
  const rows = text.split(/\r?\n/).filter((row) => row.trim() !== "");
  if (rows.length === 0) return [];

  const first = splitRow(rows[0]!).map((cell) => cell.toLowerCase());
  const looksLikeHeader = first.filter((cell) => HEADER_HINTS.some((hint) => cell.includes(hint))).length >= 2;

  const index = { module: 0, label: 1, quantity: 2, unit: 3, origin: 4 };
  if (looksLikeHeader) {
    first.forEach((cell, position) => {
      if (/module|en ?15804/.test(cell)) index.module = position;
      else if (/label|material|component|description/.test(cell)) index.label = position;
      else if (/quantity|mass|weight/.test(cell) && !/unit/.test(cell)) index.quantity = position;
      else if (/unit/.test(cell)) index.unit = position;
      else if (/origin|country/.test(cell)) index.origin = position;
    });
  }

  return rows
    .slice(looksLikeHeader ? 1 : 0)
    .map((row) => {
      const cells = splitRow(row);
      return {
        moduleCode: matchModuleCode(cells[index.module] ?? ""),
        lineLabel: cells[index.label]?.trim() ?? "",
        quantity: cells[index.quantity] !== undefined ? num(cells[index.quantity]!) : null,
        unit: cells[index.unit]?.trim() || "kg",
        originCountry: cells[index.origin]?.trim() || null,
      };
    })
    .filter((line) => line.lineLabel !== "" || line.quantity !== null);
}

/** A downloadable .csv template for the domain (no identity block — CSV is import-only). */
export function lcaBomTemplateCsv(): string {
  return [
    "Module,Label,Quantity,Unit,Origin country",
    "A1,rPET tray,31.5,kg,GB",
    "A1,Food-grade adhesive,0.35,kg,",
    "A3,Corrugated distribution carton,0.22,kg,GB",
  ].join("\r\n");
}
