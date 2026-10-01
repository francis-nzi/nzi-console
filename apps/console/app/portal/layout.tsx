import { PortalInactivityGuard } from "./PortalInactivityGuard";
import { PortalTermsGate } from "./PortalTermsGate";
import { WithOrganisationName } from "../lib/organisationBrand";
import { WithCurrencyDirectory } from "../lib/currencyDirectory";

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <WithOrganisationName>
      <a className="nz-skip-link" href="#portal-route-content">Skip to main content</a>
      <div id="portal-route-content" tabIndex={-1}><WithCurrencyDirectory>{children}</WithCurrencyDirectory></div>
      <PortalInactivityGuard />
      <PortalTermsGate />
    </WithOrganisationName>
  );
}
