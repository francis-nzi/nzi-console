/**
 * The admin rail (docs/design/admin-prototype.html): groups that follow the roadmap's phases. An item not yet built
 * carries its phase, and its page is the design's placeholder saying when it arrives (ruled P9: shown, not hidden —
 * the rail is the roadmap made visible).
 */
export type AdminIcon = "home" | "list" | "users" | "building" | "briefcase" | "flag" | "file" | "coin" | "cart" | "truck" | "mail" | "doc" | "funnel" | "atom" | "sliders" | "book";
export type AdminNavItem = { id: string; label: string; icon: AdminIcon; href: string; phase?: string; description: string; capability?: string };
export type AdminNavGroup = { group: string | null; items: AdminNavItem[] };

export const ADMIN_NAV: AdminNavGroup[] = [
  { group: null, items: [{ id: "overview", label: "Overview", icon: "home", href: "/admin", description: "Everything the console is built from." }] },
  {
    group: "Foundation",
    items: [
      { id: "lookups", label: "Lookups", icon: "list", href: "/admin/lookups", capability: "admin.lookups",
        description: "One engine for every simple reference list — industries, referrals, portfolios, payment terms, units and more. Values are edited, reordered and deactivated, never deleted, and stay resolved on records that already use them." },
      { id: "team", label: "Team & access", icon: "users", href: "/admin/team", phase: "B", capability: "admin.users",
        description: "Staff records, role assignment against the versioned capability matrix, and deactivation — replacing today’s command-line-only path." },
      { id: "organisation", label: "Organisation", icon: "building", href: "/admin/organisation", phase: "D", capability: "admin.settings",
        description: "The company profile behind quotes, invoices, certificates and report footers. Bank details are restricted to Admin and Finance, and never exposed on a public endpoint." },
    ],
  },
  {
    group: "Delivery",
    items: [
      { id: "job-types", label: "Job types", icon: "briefcase", href: "/admin/job-types", capability: "admin.lookups",
        description: "The services NZI sells, each with a default price, effort and VAT, linked to the milestone template a new job of that type starts from." },
      { id: "milestone-templates", label: "Milestone templates", icon: "flag", href: "/admin/milestone-templates", capability: "admin.templates",
        description: "The default delivery schedule a new job’s three milestones are generated from — the upstream of the milestone command, and of Risk on new jobs." },
      { id: "file-types", label: "File types", icon: "file", href: "/admin/file-types", capability: "admin.lookups",
        description: "The job file-type vocabulary and its storage mapping, with two protected system types that cannot be removed." },
    ],
  },
  {
    group: "Commercial",
    items: [
      { id: "tax-currency", label: "Tax & currency", icon: "coin", href: "/admin/tax-currency", phase: "E", capability: "admin.lookups",
        description: "VAT rates (typed %, one default), currencies (code, symbol, rate) and payment terms — the typed lookups behind quotes and invoices." },
      { id: "service-catalogue", label: "Service catalogue", icon: "cart", href: "/admin/service-catalogue", phase: "E", capability: "admin.lookups",
        description: "The catalogue of billable items — code, unit, default hours, cost and sell price, VAT — reused by quotes, invoices and job lines." },
      { id: "suppliers", label: "Suppliers", icon: "truck", href: "/admin/suppliers", phase: "E", capability: "admin.lookups",
        description: "Subcontractors and their rate card. Contact details are sealed as third-party personal data." },
    ],
  },
  {
    group: "Engagement",
    items: [
      { id: "message-templates", label: "Message templates", icon: "mail", href: "/admin/message-templates", phase: "F", capability: "admin.templates",
        description: "Email and notification templates with subject and body, previewed before they are used for invites, quotes and reminders." },
      { id: "report-templates", label: "Report templates", icon: "doc", href: "/admin/report-templates", phase: "H", capability: "admin.templates",
        description: "Report templates, their variables and versions, assignable per client." },
      { id: "crm-pipeline", label: "CRM & pipeline", icon: "funnel", href: "/admin/crm-pipeline", phase: "F", capability: "admin.lookups",
        description: "Pipeline stages, service lines, tags and automation rules for business development." },
    ],
  },
  {
    group: "Carbon data",
    items: [
      { id: "factor-library", label: "Factor library", icon: "atom", href: "/admin/factor-library", phase: "G",
        description: "The emission-factor library — already imported — gains curation, dataset archiving and factor-variant management." },
      { id: "custom-factors", label: "Custom factors", icon: "sliders", href: "/admin/custom-factors", phase: "G",
        description: "Reusable global custom factors, reconciled with the per-client factors that already exist." },
      { id: "methodology", label: "Methodology", icon: "book", href: "/admin/methodology", phase: "G",
        description: "Country and scope methodology rows, reconciled against the console’s input specification." },
    ],
  },
];

export const ADMIN_ITEMS: AdminNavItem[] = ADMIN_NAV.flatMap((group) => group.items);
export const adminItem = (id: string): AdminNavItem | undefined => ADMIN_ITEMS.find((item) => item.id === id);
export const adminGroupOf = (id: string): string => ADMIN_NAV.find((group) => group.items.some((item) => item.id === id))?.group ?? "Administration";

/** The design's icon set (the prototype's own paths). */
export const ADMIN_ICON_PATHS: Record<AdminIcon, string> = {
  home: "M3 11 12 4l9 7|M5 10v10h14V10",
  list: "M8 6h13M8 12h13M8 18h13|M3.5 6h.01M3.5 12h.01M3.5 18h.01",
  users: "M12.2 8a3.2 3.2 0 1 1-6.4 0 3.2 3.2 0 0 1 6.4 0|M3.5 20a5.5 5.5 0 0 1 11 0|M17 5.5a3 3 0 0 1 0 5.8M16.5 20a5.5 5.5 0 0 0-3-4.9",
  building: "M5 3h14v18H5z|M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2",
  briefcase: "M3 7h18v13H3z|M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18",
  flag: "M5 21V4M5 4h11l-2 4 2 4H5",
  file: "M6 3h8l4 4v14H6z|M14 3v4h4",
  coin: "M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0|M9.5 9.5a2.5 2.5 0 0 1 5 0c0 1.5-2.5 2-2.5 3.5|M12 16h.01",
  cart: "M9 20h.01M18 20h.01|M2 3h3l2.5 12h11L21 7H6",
  truck: "M1.5 6h13v10h-13z|M14.5 9h4l3 3v4h-7z|M6 18h.01M18 18h.01",
  mail: "M3 5h18v14H3z|m3 7 9 6 9-6",
  doc: "M6 3h8l4 4v14H6z|M9 12h6M9 16h6M9 8h3",
  funnel: "M3 5h18l-7 8v6l-4-2v-4z",
  atom: "M14 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0|M3 12c0-2.2 4-4 9-4s9 1.8 9 4-4 4-9 4-9-1.8-9-4",
  sliders: "M4 6h10M18 6h2M4 12h2M10 12h10M4 18h8M16 18h4",
  book: "M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z|M4 19V5",
};
