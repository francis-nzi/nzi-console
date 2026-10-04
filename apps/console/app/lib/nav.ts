import type { NavSection } from "@nzi/ui";

export const NAV: NavSection[] = [
  {
    heading: "Workspaces",
    items: [
      { id: "control", label: "Control Room", icon: "home", href: "/" },
      { id: "clients", label: "Clients", icon: "users", href: "/clients" },
      { id: "jobs", label: "Jobs", icon: "jobs", href: "/jobs" },
      // TIME PR A: everyone logs their own time (time.log is held by every role), so the link is never gated.
      { id: "time", label: "Time", icon: "clock", href: "/time" },
      { id: "emissions", label: "Emissions", icon: "chart", href: "/charts" },
      { id: "datasets", label: "Datasets & factors", icon: "database", href: "/datasets" },
      { id: "reports", label: "Reports", icon: "file", href: "/reports" },
      { id: "lca", label: "LCA / PCF / CBAM", icon: "layers", href: "/lca" },
    ],
  },
  {
    heading: "Growth & admin",
    items: [
      { id: "bd", label: "Sales", icon: "trend", href: "/sales" },
      { id: "knowledge", label: "Knowledge", icon: "file", href: "/knowledge" },
      { id: "platform", label: "Platform & audit", icon: "settings", href: "/platform" },
      // Shown only to a holder of an admin capability (GatedNavLink); /admin authorises every request itself.
      { id: "admin", label: "Admin", icon: "settings", href: "/admin", capabilityPrefix: "admin." },
    ],
  },
];

export const USER = { initials: "FD", name: "Francis Doherty", role: "Administrator" };
