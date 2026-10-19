// R5b — pagedjs ships no bundled types and there is no @types/pagedjs. This
// covers only the surface `ReportPagedView.tsx` actually uses (Previewer /
// preview). Imported via the bare specifier (the package's `exports` map
// only allows deep imports the package itself declares, and `./dist/*` isn't
// one of them) — dynamically, only when the user switches to Page view · A4,
// so it is its own lazy-loaded chunk, never part of the default report bundle.
declare module "pagedjs" {
  export type PagedFlow = { pages: unknown[]; total?: number; performance?: number };
  /** A layout hook module (the studio's repeating table headers). Only the hooks it implements are listed. */
  export class Handler {
    constructor(chunker: unknown, polisher: unknown, caller: unknown);
  }
  export function registerHandlers(...handlers: Array<new (chunker: unknown, polisher: unknown, caller: unknown) => Handler>): unknown;
  export class Previewer {
    constructor(options?: Record<string, unknown>);
    preview(
      content?: string | Node,
      stylesheets?: Array<string | Record<string, string>>,
      renderTo?: HTMLElement,
    ): Promise<PagedFlow>;
  }
}
