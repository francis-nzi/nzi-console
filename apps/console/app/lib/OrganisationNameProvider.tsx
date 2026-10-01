"use client";
import { createContext, useContext, useMemo } from "react";
import { organisationCopy, type OrganisationCopy, type OrganisationNames } from "./organisationName";

const OrganisationNameContext = createContext<OrganisationNames>(null);

/** Serves the organisation's names to client components (D3b); `WithOrganisationName` reads them on the server. */
export function OrganisationNameProvider({ names, children }: { names: OrganisationNames; children: React.ReactNode }) {
  return <OrganisationNameContext.Provider value={names}>{children}</OrganisationNameContext.Provider>;
}

export function useOrganisationName(): OrganisationCopy {
  const names = useContext(OrganisationNameContext);
  return useMemo(() => organisationCopy(names), [names]);
}
