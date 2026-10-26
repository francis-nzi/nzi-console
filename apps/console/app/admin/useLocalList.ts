"use client";

import { useMemo, useState } from "react";
import { PAGE_SIZES } from "@nzi/contracts";

/**
 * A short list — dozens of rows, read whole — searched, sorted and paged in the page: the DataList the rest of Admin
 * uses, without a round trip. Shared by the Action library (A1) and the SRS framework (S1).
 */
export function useLocalList<Row>(rows: readonly Row[], text: (row: Row) => string, sorters: Record<string, (row: Row) => string | number>) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: Object.keys(sorters)[0]!, dir: "asc" });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[0]);
  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const by = sorters[sort.key]!;
    return rows.filter((row) => needle === "" || text(row).toLowerCase().includes(needle))
      .sort((a, b) => { const x = by(a), y = by(b); const order = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y)); return sort.dir === "asc" ? order : -order; });
  }, [rows, search, sort, sorters, text]);
  const pageCount = Math.max(1, Math.ceil(shown.length / pageSize));
  const current = Math.min(page, pageCount);
  return {
    rows: shown.slice((current - 1) * pageSize, current * pageSize), total: shown.length, unfiltered: rows.length,
    search: { value: search, onChange: (value: string) => { setSearch(value); setPage(1); } },
    sort, onSort: (key: string) => setSort((now) => ({ key, dir: now.key === key && now.dir === "asc" ? "desc" : "asc" })),
    paging: { page: current, pageCount, pageSize, pageSizes: PAGE_SIZES, total: shown.length },
    onPage: setPage, onPageSize: (size: number) => { setPageSize(size); setPage(1); },
    clear: search ? () => setSearch("") : undefined,
  };
}
