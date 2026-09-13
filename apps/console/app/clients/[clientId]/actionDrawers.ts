import type { ActionLibraryEntry, ClientAction } from "@nzi/contracts";

/** Which Actions drawer the workspace has open. Hosted by the shell, like every other. */
export type ActionDrawerRequest =
  | { kind: "action-library"; library: ActionLibraryEntry[] }
  | { kind: "action-bespoke" }
  | { kind: "action-edit"; action: ClientAction };

export const actionDrawerLabel = (request: ActionDrawerRequest): string => {
  switch (request.kind) {
    case "action-library": return "Add an action from the library";
    case "action-bespoke": return "Add a bespoke action";
    case "action-edit": return `Edit ${request.action.title}`;
  }
};
