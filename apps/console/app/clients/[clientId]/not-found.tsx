import { WorkspaceNotFound } from "../../lib/ScreenState";

export default function ClientNotFound() {
  return <WorkspaceNotFound chrome={{ activeId: "clients", label: "Clients", href: "/clients" }} what="client" />;
}
