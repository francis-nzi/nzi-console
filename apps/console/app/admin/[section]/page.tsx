import { notFound } from "next/navigation";
import { CapabilityChip } from "@nzi/ui";
import { adminAccess } from "../adminAccess";
import { adminGroupOf, adminItem } from "../adminNav";

export const dynamic = "force-dynamic";

/**
 * An admin area that is on the roadmap but not built yet (ruled P9: shown, with its phase — the rail is the roadmap
 * made visible). Each becomes its real screen in its phase; Lookups is the first, in A2.
 */
export default async function AdminSectionPage({ params }: { params: Promise<{ section: string }> }) {
  const access = await adminAccess();
  if (access.state !== "allowed") return null; // The layout states why; nothing is read.
  const { section } = await params;
  const item = adminItem(section);
  if (!item || item.id === "overview" || !item.phase) notFound();

  return <>
    <div className="nz-a-page-head">
      <div><div className="nz-a-eyebrow">{adminGroupOf(item.id)}</div><h1>{item.label}</h1></div>
      {item.capability ? <div className="nz-a-head-actions"><CapabilityChip capability={item.capability} /></div> : null}
    </div>
    <section className="nz-a-placeholder" aria-labelledby="placeholder-title">
      <h2 id="placeholder-title">{item.label} is on the way</h2>
      <p>{item.description}</p>
      <span className="nz-a-phase">Roadmap · Phase {item.phase}</span>
    </section>
  </>;
}
