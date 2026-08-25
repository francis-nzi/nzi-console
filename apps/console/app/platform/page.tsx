import { auditEvents, platformServices, staffRoles } from "@nzi/mock-data";
import { loadFixtureScreen } from "@nzi/api-client";
import { ScreenState } from "../lib/ScreenState";
import { PlatformBoard } from "./PlatformBoard";

type PlatformPayload = { services: typeof platformServices; events: typeof auditEvents; roles: typeof staffRoles };
export default function PlatformPage() {
  const result = loadFixtureScreen<PlatformPayload>("platform", { services: platformServices, events: auditEvents, roles: staffRoles });
  return <ScreenState result={result}>{(data) => <PlatformBoard services={data.services} events={data.events} roles={data.roles} />}</ScreenState>;
}
