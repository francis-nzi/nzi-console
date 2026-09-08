// Portal Phase 2 · A2-lite — qualitative Spheres-of-Influence engagement tracker.
// Deliberately contains no emissions quantity, factor, reduction, or projection field.

export type PortalActionLever = {
  code: string;
  sphereCode: "A" | "B" | "C";
  sphereName: string;
  subSphereCode: string;
  subSphereName: string;
  description: string;
};

export type PortalTrackerAction = {
  id: string;
  leverCode: string;
  title: string;
  notes: string;
  progressPercent: number;
  version: number;
  updatedAt: string;
};

export type PortalActionTracker = {
  levers: readonly PortalActionLever[];
  actions: PortalTrackerAction[];
};

const sphere = (sphereCode: "A" | "B" | "C", sphereName: string, subSphereCode: string, subSphereName: string, entries: Array<[string, string]>): PortalActionLever[] =>
  entries.map(([code, description]) => ({ code, sphereCode, sphereName, subSphereCode, subSphereName, description }));

export const portalActionLevers: readonly PortalActionLever[] = [
  ...sphere("A", "Products and Services", "A1", "Product and Service Innovation", [
    ["A1.1", "Develop and scale products that accelerate others' emissions reductions (i.e., resulting in avoided emissions)"],
    ["A1.2", "Develop and scale services that accelerate others' emissions reductions (i.e., resulting in avoided emissions)"],
  ]),
  ...sphere("A", "Products and Services", "A2", "Business Model Innovation", [
    ["A2.1", "Implement revenue models that decouple growth from material consumption"],
    ["A2.2", "Implement incentives for sustainable consumer behaviours"],
  ]),
  ...sphere("A", "Products and Services", "A3", "Climate Solutions Research and Development", [
    ["A3.1", "Catalyze and invest in internal climate solutions R&D (e.g., patents for climate solutions)"],
    ["A3.2", "Conduct joint climate solutions R&D for own products and services with external partners"],
  ]),
  ...sphere("B", "Portfolio of Climate System Investments", "B1", "Low-carbon systems and solutions", [
    ["B1.1", "Scale high-integrity credits/certificates for low-carbon technology and solutions beyond the emissions inventory"],
    ["B1.2", "Support the scaling of low-carbon solutions through advanced financing (e.g., accelerators, incubator funds, offtake deals)"],
    ["B1.3", "Invest in enabling infrastructure (e.g., grids, renewables) and shift money from high-emitting activities to low-emitting activities to grow new markets for solutions"],
  ]),
  ...sphere("B", "Portfolio of Climate System Investments", "B2", "Nature conservation and restoration", [
    ["B2.1", "Purchase and retire high-integrity credits/certificates supporting nature-based solutions beyond the emissions inventory"],
    ["B2.2", "Support conservation and restoration programmes/initiatives"],
    ["B2.3", "Invest in enabling infrastructure, services and wider local programmes that support the longevity and impact of restoration projects"],
  ]),
  ...sphere("B", "Portfolio of Climate System Investments", "B3", "Carbon removals", [
    ["B3.1", "Purchase and retire high-integrity removal credits/certificates the beyond emissions inventory"],
    ["B3.2", "Support removal technology development through forward looking purchases and financing (e.g., offtake agreements, demand aggregation partnerships)"],
    ["B3.3", "Invest in enabling infrastructure for removals"],
  ]),
  ...sphere("C", "Policy and Public Engagement", "C1", "Government and Policy Engagement", [
    ["C1.1", "Advocate for policies to address external dependencies and climate risk"],
    ["C1.2", "Advocate for policies to incentivize corporate climate action"],
    ["C1.3", "Advocate for policies to remove barriers for net zero compatible lifestyles"],
  ]),
  ...sphere("C", "Policy and Public Engagement", "C2", "Industry Engagement", [
    ["C2.1", "Advocate and engage with suppliers and partners to implement climate action and sustainable practices"],
    ["C2.2", "Advocate for alignment to the Paris Agreement for all affiliated coalitions, business and trade associations"],
    ["C2.3", "Participate in a multistakeholder coalition or initiative with the explicit objective of aligning with global net zero"],
    ["C2.4", "Open-source climate knowledge and solutions"],
  ]),
  ...sphere("C", "Policy and Public Engagement", "C3", "Public Engagement and Empowerment", [
    ["C3.1", "Equip the public with science-backed efforts to generate demand for and enable sustainable lifestyles (e.g., campaigns, entertainment or advertising to clients, customers, employees, or broader public)"],
    ["C3.2", "Participate in public climate advocacy campaigns"],
  ]),
];

export const isPortalActionTracker = (value: unknown): value is PortalActionTracker => {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<PortalActionTracker>;
  return Array.isArray(v.levers) && v.levers.length === 24 && Array.isArray(v.actions);
};
