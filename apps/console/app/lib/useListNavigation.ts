"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { changeListQuery, listQueryToSearchParams, nextSort, type ListQuery, type ListSpec } from "@nzi/contracts";

/**
 * A list's controls, as URL changes (docs/LIST_PARITY_DESIGN.md §2). The query in the URL is the list's only state:
 * every control computes the next query and replaces the URL with it, and the server page reads that URL. So a
 * filtered, sorted page can be shared, and survives a refresh.
 *
 * `replace` rather than `push`: typing a search should not leave one history entry per debounced keystroke.
 */
export function useListNavigation<S extends string, F extends string>(spec: ListSpec<S, F>, query: ListQuery<S, F>, path: string) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const go = (next: ListQuery<S, F>) => {
    const search = listQueryToSearchParams(next, spec).toString();
    startTransition(() => router.replace(search ? `${path}?${search}` : path, { scroll: false }));
  };
  return {
    pending,
    search: (value: string) => go(changeListQuery(query, { search: value })),
    filter: (key: F, value: string) => go(changeListQuery(query, { filters: { [key]: value === "" ? undefined : [value] } as Partial<Record<F, string[]>> })),
    filters: (values: Partial<Record<F, string[] | undefined>>) => go(changeListQuery(query, { filters: values })),
    sort: (key: S) => go(changeListQuery(query, { sort: nextSort(query.sort, key) })),
    page: (page: number) => go(changeListQuery(query, { page })),
    pageSize: (pageSize: number) => go(changeListQuery(query, { pageSize })),
    /** Search and filters cleared; sort and page size kept. */
    clear: (keep: Partial<Record<F, string[]>> = {}) => go({ ...query, search: "", filters: keep, page: 1 }),
  };
}
