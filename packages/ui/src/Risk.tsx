/**
 * The milestone traffic light (docs/LIST_PARITY_DESIGN.md, PR 2): a dot and its label, always both.
 *
 * **Status role, not scope identity (ruled R6).** Scope 1/2/3 own coral, amber and emerald as categorical identities
 * (`--s1/--s2/--s3`). Risk is a semantic state, so it draws on its own `--risk-*` tokens — the deeper status tints the
 * badges already use — and never on a scope hue: no single colour means both a scope and a risk state. The label is
 * always shown beside the dot, so the meaning never rests on colour.
 */
export type RiskValue = "Overdue" | "Due" | "Healthy" | "Not set";

const CLASS: Record<RiskValue, string> = { Overdue: "overdue", Due: "due", Healthy: "healthy", "Not set": "notset" };

export function RiskBadge({ risk }: { risk: RiskValue }) {
  return <span className={`nz-risk ${CLASS[risk]}`}><i aria-hidden="true" />{risk}</span>;
}

/** The legend, as v7 shows it above the list. */
export function RiskLegend() {
  return <p className="nz-risk-legend"><span>Risk:</span>
    {(["Overdue", "Due", "Healthy", "Not set"] as const).map((risk) => <RiskBadge key={risk} risk={risk} />)}
    <span className="nz-risk-legend-note">from each job&rsquo;s data-collection, first-draft and final-report milestones</span>
  </p>;
}
