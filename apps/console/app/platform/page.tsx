import { auditEvents, platformServices, staffRoles } from "@nzi/mock-data";
import { PlatformBoard } from "./PlatformBoard";

export default function PlatformPage() { return <PlatformBoard services={platformServices} events={auditEvents} roles={staffRoles} />; }
