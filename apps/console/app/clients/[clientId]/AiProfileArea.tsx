"use client";

import type { ClientWorkspaceReadModel } from "@nzi/isolated-backend";
import { CardHead } from "./OverviewArea";

/**
 * AI Profile (client workspace v10, phase 2).
 *
 * There is no advisory engine in this platform — no model integration exists anywhere in
 * the codebase — so this area shows no generated content. What it does show is the
 * **grounding**: the recorded facts an advisory context would have to be built from, and
 * how much of it this client actually has. That is honest and useful; a screen of
 * plausible-sounding advice with nothing behind it would be neither.
 *
 * AI is advisory and grounded by decision, and is kept visibly separate from the evidence
 * base — so the grounding is shown as the client record it is, not as insight.
 */
export function AiProfileArea({ workspace }: { workspace: ClientWorkspaceReadModel }) {
  const { client, sites, contacts, targets, history } = workspace;
  const profile = client.profile;
  const grounding = [
    { label: "Sector and SIC code", value: [client.sector, profile.industrySic].filter((part) => part?.toString().trim()).join(" · "), why: "what the client does" },
    { label: "Group structure", value: profile.groupStructure ?? "", why: "who the boundary covers" },
    { label: "Reporting frameworks", value: (profile.reportingFrameworks ?? []).join(" · "), why: "what it must disclose against" },
    { label: "Certifications", value: (profile.certifications ?? []).join(" · "), why: "what it already holds" },
    { label: "Primary Scope 3 categories", value: (profile.primaryScope3Categories ?? []).join(" · "), why: "where its value-chain emissions sit" },
    { label: "Sites in the boundary", value: sites.length ? `${sites.length} recorded` : "", why: "the operational footprint" },
    { label: "Assured reporting years", value: history.length ? `${history.length} year${history.length === 1 ? "" : "s"}` : "", why: "the measured position" },
    { label: "Forward targets", value: targets.model ? "Set" : "", why: "the commitment to advise against" },
    { label: "Named contacts", value: contacts.length ? `${contacts.length} active` : "", why: "who the advice is for" },
  ];
  const present = grounding.filter((item) => item.value.trim()).length;

  return <>
    <div className="nz-cw-vhead"><div><div className="eyebrow">Advisory</div><h2>AI profile</h2></div><span style={{ flex: 1 }} />
      <span className="sub">{present} of {grounding.length} grounding inputs on record</span></div>
    <p className="nz-cw-vsub">Grounded advisory context for this client. No advisory content is generated yet — this shows what any such context would have to be built from, and what is missing.</p>

    <div className="nz-cw-grid">
      <div className="nz-cw-col">
        <section className="nz-panel">
          <CardHead eyebrow="Grounding" title="What the advice would be built from" />
          <div style={{ padding: "6px 16px 12px" }}>
            {grounding.map((item) => <div className="nz-kv" key={item.label}>
              <span className="k">{item.label}<span className="hint">{item.why}</span></span>
              <span className="v">{item.value.trim() ? item.value : <span className="muted">Not recorded</span>}</span>
            </div>)}
          </div>
          <div className="nz-card-b">
            <p className="nz-maps">Every input here is a recorded fact from this client&apos;s own record — the compliance context on the client, its sites, its assured years and its targets. Nothing here is inferred.</p>
          </div>
        </section>
      </div>

      <div className="nz-cw-col">
        <section className="nz-panel">
          <CardHead eyebrow="Not available yet" title="Advisory output" right={<span className="nz-st need">Not built</span>} />
          <div className="nz-card-b">
            <p className="sub" style={{ margin: "8px 0" }}>No model integration exists in this platform, so no advisory content is produced. When it is built, it will be <b>grounded and advisory only</b>: drawn from the record above, never from the assured figures themselves, and always marked as advice rather than evidence.</p>
            <p className="nz-maps">Report narrative already carries a source label (default / AI-drafted / client-edited) so a reader can tell generated prose from recorded fact. The same separation applies here.</p>
          </div>
        </section>
      </div>
    </div>
  </>;
}
