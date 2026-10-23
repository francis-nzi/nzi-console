// Files — a design preview (BUILD-portal-shell-lookandfeel R4): MOCKUP-client-portal.html's Files layout, so the walkthrough is
// complete, with nothing presented as real. There is no file store yet: the upload is disabled, every row is marked as an example
// and dimmed, and nothing here reads or writes. A server component — no state, no request.
const EXAMPLES: Array<{ icon: string; name: string; category: string; by: string; scan: "Clean" | "Scanning" | "Quarantined" }> = [
  { icon: "📊", name: "Utility bills.xlsx", category: "Data & evidence", by: "You", scan: "Clean" },
  { icon: "📄", name: "Carbon Reduction Plan.pdf", category: "Reports", by: "Your adviser", scan: "Clean" },
  { icon: "🧾", name: "Supplier contract.pdf", category: "Contracts", by: "You", scan: "Scanning" },
  { icon: "⚠", name: "Travel export.zip", category: "Data & evidence", by: "You", scan: "Quarantined" },
];

export function FilesPreview() {
  return (
    <div className="nzp-metrics">
      <header className="nz-pd-top">
        <div>
          <span className="nz-eyebrow">Documents</span>
          <h1 className="nz-pd-client">Files <span className="nzp-early">Preview — coming soon</span></h1>
          <p className="nz-pd-meta">Upload, share and audit every document — both ways</p>
        </div>
      </header>
      <div className="nzp-preview-banner" role="note">
        <b>This is a preview of a page that is coming soon.</b> No files are stored here yet, and nothing below is yours — the rows show
        what the page will look like. Until then, documents are shared with your adviser as today.
      </div>
      <div className="nzp-dropzone" aria-disabled="true">
        <b>Drag files here, or browse</b>
        <span>PDF, Excel, Word, images · every upload virus-scanned before anyone can open it</span>
        <button type="button" className="nz-btn pri" disabled>Choose files</button>
      </div>
      <section className="nzp-metric-card nzp-example" aria-label="Example documents (illustrative)">
        <div className="nzp-metric-h"><h3>Documents</h3><span className="nzp-early">Example rows</span></div>
        <div className="nzp-tablewrap"><table className="nz-tbl">
          <thead><tr><th>Name</th><th>Category</th><th>By</th><th>Scan</th></tr></thead>
          <tbody>
            {EXAMPLES.map((row) => (
              <tr key={row.name}>
                <td><span aria-hidden="true">{row.icon}</span> {row.name} <span className="nzp-example-tag">Example</span></td>
                <td>{row.category}</td><td>{row.by}</td><td>{row.scan}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </section>
    </div>
  );
}
