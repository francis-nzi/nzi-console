import {
  countClientsWithoutMetrics, listIntensityDefaults, listTeamMembers, readOrganisationBank, readOrganisationProfile, withTenantRead,
  type IntensityDefault, type OrganisationBankView, type OrganisationProfileView,
} from "@nzi/isolated-backend";
import { serviceEnvironment } from "../../lib/environment";
import { isolatedPool } from "../../lib/isolatedDatabase";
import { adminAccess, holds } from "../adminAccess";
import { OrganisationBoard } from "./OrganisationBoard";

export const dynamic = "force-dynamic";

/**
 * Organisation (admin Phase D, D1; ruled `phaseD-org-settings-plan.md`, Q7: /admin/organisation). The company profile —
 * one record, a form, not a list — its logo, its bank details (masked; "Show" asks for them explicitly) and the
 * intensity metrics a new client starts with. admin.settings opens it; anyone else in the admin section is told why,
 * and nothing is read.
 */
export default async function OrganisationPage() {
  const access = await adminAccess();
  if (access.state !== "allowed") return null; // The layout states why; nothing is read.
  if (!holds(access.capabilities, "admin.settings")) {
    return <section className="nz-a-state" role="alert"><h1>Organisation needs admin.settings</h1><p>Your role can open administration, but the company profile and its bank details are shown only to those who can govern them. Nothing has been read.</p></section>;
  }

  let data: { profile: OrganisationProfileView; bank: OrganisationBankView; defaults: IntensityDefault[]; clientsWithout: number; roster: Array<{ userId: string; displayName: string }> } | null = null;
  try {
    data = await withTenantRead(isolatedPool(), access.organisationId, async (db) => {
      const profile = await readOrganisationProfile(db, access.organisationId);
      if (!profile) throw new Error("no profile row");
      return {
        profile,
        bank: await readOrganisationBank(db, access, access.organisationId, { reveal: false }),
        defaults: await listIntensityDefaults(db, access.organisationId),
        clientsWithout: await countClientsWithoutMetrics(db, access.organisationId),
        roster: (await listTeamMembers(db)).map(({ userId, displayName }) => ({ userId, displayName })),
      };
    });
  } catch {
    data = null;
  }
  if (data === null) {
    return <section className="nz-a-state" role="alert"><h1>The organisation profile could not be read</h1><p>It is unavailable just now. Nothing is shown rather than a profile that might be wrong — this is not the same as an empty one.</p></section>;
  }

  const editing = serviceEnvironment().writes !== "enabled" ? { allowed: false as const, reason: "Writes are switched off in this environment, so the profile is read-only here." } : { allowed: true as const };
  return <OrganisationBoard {...data} editing={editing} />;
}
