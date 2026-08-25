import type { NavSection } from "@nzi/ui";

export const NAV: NavSection[] = [
  {
    heading: "Workspaces",
    items: [
      { id: "control", label: "Control Room", icon: "home", href: "/" },
      { id: "clients", label: "Clients", icon: "users", href: "/clients", count: 214 },
      { id: "jobs", label: "Jobs", icon: "jobs", href: "/jobs", count: 37 },
      { id: "emissions", label: "Emissions", icon: "chart", href: "/charts" },
      { id: "datasets", label: "Datasets & factors", icon: "database", href: "/datasets" },
      { id: "reports", label: "Reports", icon: "file", href: "/reports" },
      { id: "lca", label: "LCA / PCF / CBAM", icon: "layers", href: "/lca" },
    ],
  },
  {
    heading: "Growth & admin",
    items: [
      { id: "bd", label: "Sales", icon: "trend", href: "/sales", count: 9 },
      { id: "platform", label: "Platform & audit", icon: "settings", href: "/platform" },
    ],
  },
];

export const USER = { initials: "FD", name: "Francis Doherty", role: "Administrator" };
