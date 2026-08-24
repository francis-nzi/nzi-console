import type { NavSection } from "@nzi/ui";

export const NAV: NavSection[] = [
  {
    heading: "Workspaces",
    items: [
      { id: "control", label: "Control Room", icon: "home", href: "/" },
      { id: "clients", label: "Clients", icon: "users", href: "/clients", count: 214 },
      { id: "jobs", label: "Jobs", icon: "jobs", href: "/jobs", count: 37 },
      { id: "emissions", label: "Emissions", icon: "chart", href: "/charts" },
      { id: "datasets", label: "Datasets & factors", icon: "database", href: "#" },
      { id: "reports", label: "Reports", icon: "file", href: "#" },
      { id: "lca", label: "LCA / PCF / CBAM", icon: "layers", href: "#" },
    ],
  },
  {
    heading: "Growth & admin",
    items: [
      { id: "bd", label: "Business development", icon: "trend", href: "#", count: 9 },
      { id: "platform", label: "Platform & audit", icon: "settings", href: "#" },
    ],
  },
];

export const USER = { initials: "FD", name: "Francis Doherty", role: "Administrator" };
