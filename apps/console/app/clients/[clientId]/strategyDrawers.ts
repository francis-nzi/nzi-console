import type { StrategyLibraryEntry, ClientStrategy } from "@nzi/contracts";

/** Which Reduction Strategies drawer the workspace has open. Hosted by the shell, like every other. */
export type StrategyDrawerRequest =
  | { kind: "strategy-library"; library: StrategyLibraryEntry[] }
  | { kind: "strategy-bespoke" }
  | { kind: "strategy-edit"; strategy: ClientStrategy }
  /** A2: a client's proposed action, to approve (optionally promoting it into the library) or decline. */
  | { kind: "strategy-proposal"; strategy: ClientStrategy };

export const strategyDrawerLabel = (request: StrategyDrawerRequest): string => {
  switch (request.kind) {
    case "strategy-library": return "Add a reduction strategy from the library";
    case "strategy-bespoke": return "Add a bespoke reduction strategy";
    case "strategy-edit": return `Edit ${request.strategy.title}`;
    case "strategy-proposal": return `Review the client's proposal: ${request.strategy.title}`;
  }
};
