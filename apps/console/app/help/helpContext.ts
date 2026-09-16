/**
 * What the help drawer knows about where you are.
 *
 * Derived from the route, which is the one source available everywhere without asking every
 * page to cooperate. It is deliberately coarse and honest: the drawer shows the user exactly
 * this string, so what the assistant will be told is visible before anything is asked.
 *
 * A page that knows better can refine it (a client's name rather than its id) — but nothing
 * *depends* on a page doing so, which is what keeps the affordance genuinely universal.
 */

export type HelpPageContext = {
  /** The workspace, in the app's own vocabulary. */
  page: string;
  /** The record in view, where the route names one. */
  entityKind: string | null;
  entityId: string | null;
  /** What the drawer shows, and what Phase 1 will send with a question. */
  label: string;
};

const WORKSPACES: Array<[RegExp, string]> = [
  [/^\/clients\/new/, "Clients · new client"],
  [/^\/clients\/[^/]+/, "Client workspace"],
  [/^\/clients/, "Clients"],
  [/^\/jobs\/[^/]+/, "Job workspace"],
  [/^\/jobs/, "Jobs"],
  [/^\/reports\/[^/]+/, "Report"],
  [/^\/reports/, "Reports"],
  [/^\/charts/, "Emissions"],
  [/^\/datasets/, "Datasets & factors"],
  [/^\/lca/, "LCA / PCF / CBAM"],
  [/^\/sales/, "Sales"],
  [/^\/knowledge/, "Knowledge library"],
  [/^\/platform/, "Platform & audit"],
  [/^\/portal/, "Client portal"],
  [/^\/$/, "Control Room"],
];

/** The record a route names, where it names one. */
function entityOf(path: string): { kind: string; id: string } | null {
  const client = /^\/clients\/(?!new)([^/]+)/.exec(path);
  if (client) return { kind: "client", id: client[1]! };
  const job = /^\/jobs\/([^/]+)/.exec(path);
  if (job) return { kind: "job", id: job[1]! };
  const report = /^\/reports\/([^/]+)/.exec(path);
  if (report) return { kind: "report", id: report[1]! };
  return null;
}

export function helpContextForPath(path: string): HelpPageContext {
  const page = WORKSPACES.find(([pattern]) => pattern.test(path))?.[1] ?? "NZI Console";
  const entity = entityOf(path);
  return {
    page,
    entityKind: entity?.kind ?? null,
    entityId: entity?.id ?? null,
    // The id rather than a name: a global provider has no way to resolve a name without a
    // fetch on every route change, and showing the id is honest where inventing one is not.
    label: entity === null ? page : `${page} · ${entity.id}`,
  };
}
