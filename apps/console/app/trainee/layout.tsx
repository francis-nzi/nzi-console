import { WithOrganisationName } from "../lib/organisationBrand";

/** The trainee portal names the organisation from its profile (D3b); the provider serves its client components. */
export default function TraineeLayout({ children }: { children: React.ReactNode }) {
  return <WithOrganisationName>{children}</WithOrganisationName>;
}
