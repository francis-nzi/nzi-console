import "server-only";
import { cache } from "react";
import { connection } from "next/server";
import { readOrganisationBrand, withTenantRead, type OrganisationBrand } from "@nzi/isolated-backend";
import { isolatedPool } from "./isolatedDatabase";
import { OrganisationNameProvider } from "./OrganisationNameProvider";
import type { OrganisationNames } from "./organisationName";

/**
 * D3b — the organisation this deployment serves, as its live profile names it: the one read behind the portal's,
 * the trainee portal's and the verify page's copy. Pre-login pages have no session, so this is the deployment's
 * organisation (`NZI_DEMO_ORGANISATION_ID`, the one portal and trainee sign-in use), never a request parameter.
 *
 * Read per request — `connection()` keeps it out of the build, where a prerender would freeze whatever the profile
 * said (or failed to say) at build time. Null when it can't be read; the copy then omits the name (`organisationCopy`).
 * Issued documents never read this: they carry the issuer frozen when they were issued.
 */
export const deploymentBrand = cache(async (): Promise<OrganisationBrand | null> => {
  await connection();
  const organisationId = process.env.NZI_DEMO_ORGANISATION_ID?.trim();
  if (process.env.NZI_DATA_MODE !== "isolated-api" || !organisationId) return null;
  try {
    return await withTenantRead(isolatedPool(), organisationId, (db) => readOrganisationBrand(db, organisationId));
  } catch (error) {
    console.error("[organisation-brand] the organisation profile could not be read", error);
    return null;
  }
});

export async function deploymentNames(): Promise<OrganisationNames> {
  const brand = await deploymentBrand();
  return brand ? { displayName: brand.displayName, shortName: brand.shortName } : null;
}

/** Wraps a subtree so its client components can `useOrganisationName()`. Names only — never the footer or bank. */
export async function WithOrganisationName({ children }: { children: React.ReactNode }) {
  return <OrganisationNameProvider names={await deploymentNames()}>{children}</OrganisationNameProvider>;
}
