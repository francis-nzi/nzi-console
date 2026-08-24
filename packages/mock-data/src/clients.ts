// Illustrative demonstrator data only — no real client data, no PII.

export type ClientStatus = "active" | "onboarding" | "at-risk" | "prospect";

export type ClientJobRef = { number: string; year: number; status: string };

export type Client = {
  id: string;
  name: string;
  sector: string;
  location: string;
  status: ClientStatus;
  owner: string;
  memberSince: string;
  latestFootprint: string | null;
  yoy: string | null;
  completeness: number;
  openJobs: number;
  nextReportDue: string;
  contact: { name: string; role: string; email: string };
  jobs: ClientJobRef[];
};

export const clients: Client[] = [
  {
    id: "bushy-tails", name: "Bushy Tails Ltd", sector: "Consumer goods", location: "Manchester, UK",
    status: "active", owner: "A. Shaw", memberSince: "2023", latestFootprint: "1,842 tCO₂e", yoy: "−7.4%",
    completeness: 92, openJobs: 1, nextReportDue: "31 Mar 2025",
    contact: { name: "Priya Nair", role: "Sustainability lead", email: "priya@example.com" },
    jobs: [{ number: "#712", year: 2024, status: "Data entry" }, { number: "#588", year: 2023, status: "Signed off" }],
  },
  {
    id: "harbourline", name: "Harbourline Logistics", sector: "Transport & logistics", location: "Rotterdam, NL",
    status: "active", owner: "A. Shaw", memberSince: "2022", latestFootprint: "18,400 tCO₂e", yoy: "−3.1%",
    completeness: 88, openJobs: 2, nextReportDue: "30 Apr 2025",
    contact: { name: "Tom De Vries", role: "HSE manager", email: "tom@example.com" },
    jobs: [{ number: "#701", year: 2024, status: "Factor mapping" }, { number: "#699", year: 2024, status: "Data entry" }],
  },
  {
    id: "verdant", name: "Verdant Foods Co", sector: "Food & beverage", location: "Bristol, UK",
    status: "active", owner: "M. Osei", memberSince: "2024", latestFootprint: "9,210 tCO₂e", yoy: "+1.2%",
    completeness: 74, openJobs: 1, nextReportDue: "30 Jun 2025",
    contact: { name: "Sarah Lund", role: "Operations director", email: "sarah@example.com" },
    jobs: [{ number: "#733", year: 2024, status: "Scope defined" }],
  },
  {
    id: "northwind", name: "Northwind Energy", sector: "Energy", location: "Aberdeen, UK",
    status: "onboarding", owner: "M. Osei", memberSince: "2025", latestFootprint: null, yoy: null,
    completeness: 18, openJobs: 1, nextReportDue: "Baseline in progress",
    contact: { name: "Iain Ross", role: "Group ESG", email: "iain@example.com" },
    jobs: [{ number: "#740", year: 2024, status: "Scope defined" }],
  },
  {
    id: "cedar-cra", name: "Cedar & Crane Architects", sector: "Professional services", location: "London, UK",
    status: "active", owner: "A. Shaw", memberSince: "2023", latestFootprint: "412 tCO₂e", yoy: "−11.0%",
    completeness: 96, openJobs: 0, nextReportDue: "31 Jul 2025",
    contact: { name: "Elena Fischer", role: "Partner", email: "elena@example.com" },
    jobs: [{ number: "#690", year: 2024, status: "Signed off" }],
  },
  {
    id: "pennine", name: "Pennine Textiles", sector: "Manufacturing", location: "Leeds, UK",
    status: "at-risk", owner: "M. Osei", memberSince: "2022", latestFootprint: "6,880 tCO₂e", yoy: "+4.8%",
    completeness: 61, openJobs: 1, nextReportDue: "Overdue · 28 Feb 2025",
    contact: { name: "David Clark", role: "Plant manager", email: "david@example.com" },
    jobs: [{ number: "#655", year: 2024, status: "Awaiting client data" }],
  },
  {
    id: "solside", name: "Solside Retail Group", sector: "Retail", location: "Dublin, IE",
    status: "active", owner: "A. Shaw", memberSince: "2024", latestFootprint: "24,900 tCO₂e", yoy: "−2.0%",
    completeness: 83, openJobs: 2, nextReportDue: "30 Sep 2025",
    contact: { name: "Aoife Byrne", role: "Head of ESG", email: "aoife@example.com" },
    jobs: [{ number: "#728", year: 2024, status: "Review & QA" }, { number: "#729", year: 2024, status: "Data entry" }],
  },
  {
    id: "quaymed", name: "Quaymed Devices", sector: "Medical devices", location: "Galway, IE",
    status: "onboarding", owner: "M. Osei", memberSince: "2025", latestFootprint: null, yoy: null,
    completeness: 34, openJobs: 1, nextReportDue: "Baseline in progress",
    contact: { name: "Niamh Kelly", role: "Quality & ESG", email: "niamh@example.com" },
    jobs: [{ number: "#741", year: 2024, status: "Data entry" }],
  },
  {
    id: "brackenfield", name: "Brackenfield Estates", sector: "Real estate", location: "Edinburgh, UK",
    status: "prospect", owner: "Unassigned", memberSince: "—", latestFootprint: null, yoy: null,
    completeness: 0, openJobs: 0, nextReportDue: "Proposal sent",
    contact: { name: "Gordon Muir", role: "Facilities director", email: "gordon@example.com" },
    jobs: [],
  },
];

export const clientStatusMeta: Record<ClientStatus, { cls: string; label: string }> = {
  active: { cls: "done", label: "Active" },
  onboarding: { cls: "est", label: "Onboarding" },
  "at-risk": { cls: "nof", label: "At risk" },
  prospect: { cls: "need", label: "Prospect" },
};

export const clientCounts = {
  all: clients.length,
  active: clients.filter((c) => c.status === "active").length,
  onboarding: clients.filter((c) => c.status === "onboarding").length,
  atRisk: clients.filter((c) => c.status === "at-risk").length,
  prospect: clients.filter((c) => c.status === "prospect").length,
};
