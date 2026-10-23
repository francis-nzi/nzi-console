import {PortalHome} from "./PortalHome";
import {ShellDashboard} from "./shell/ShellViews";
import {portalFeatureEnabled} from "../lib/portalFlags";
/** With `portal-shell` on (and the dashboard it lands on), the portal opens in the shell on the default job's Dashboard. */
export default function PortalPage(){return portalFeatureEnabled("portal-shell")&&portalFeatureEnabled("portal-analytics")?<ShellDashboard actions={portalFeatureEnabled("portal-actions")}/>:<PortalHome/>}
