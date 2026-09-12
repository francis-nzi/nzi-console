import type { ClientContactReadModel, ClientSiteReadModel } from "@nzi/contracts";

/**
 * Which drawer the workspace has open. One host renders them, so a drawer is never a
 * card's private business and two can never be open at once.
 */
export type DrawerRequest =
  | { kind: "identity" }
  | { kind: "targets" }
  | { kind: "rebaseline" }
  | { kind: "address" }
  | { kind: "compliance" }
  | { kind: "factors" }
  | { kind: "portal" }
  | { kind: "intensity-metrics" }
  | { kind: "contact"; contact: ClientContactReadModel | null }
  | { kind: "site"; site: ClientSiteReadModel | null };

export const drawerLabel = (request: DrawerRequest): string => {
  switch (request.kind) {
    case "identity": return "Identity and profile";
    case "targets": return "Reduction targets";
    case "rebaseline": return "Re-baseline";
    case "address": return "Registered address";
    case "compliance": return "Compliance";
    case "factors": return "Client factors";
    case "portal": return "Portal access";
    case "intensity-metrics": return "Intensity metrics";
    case "contact": return request.contact ? `Edit contact ${request.contact.fullName}` : "Add a contact";
    case "site": return request.site ? `Edit site ${request.site.name}` : "Add a site";
  }
};
