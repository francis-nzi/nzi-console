import { CapabilityChip } from "@nzi/ui";

/**
 * The Tax & currency head (admin Phase E1): one screen, two lists — each its own route, because each list keeps its
 * own search, sort and page in the URL. Payment terms are a Lookups list (Phase A), linked rather than repeated.
 */
export function TaxCurrencyHead({ tab, action }: { tab: "vat-rates" | "currencies"; action?: React.ReactNode }) {
  return <>
    <div className="nz-a-page-head">
      <div>
        <div className="nz-a-eyebrow">Commercial</div>
        <h1>Tax &amp; currency</h1>
        <p>The typed lookups behind quotes and invoices. Each list has exactly one default, which can move but never lapse; a deactivated rate or currency leaves the pickers but still resolves on whatever already names it.</p>
      </div>
      <div className="nz-a-head-actions">
        <CapabilityChip capability="admin.lookups" />
        {action}
      </div>
    </div>
    <nav className="nz-a-seg nz-a-tabs" aria-label="Tax and currency lists">
      <a href="/admin/tax-currency/vat-rates" className={tab === "vat-rates" ? "on" : undefined} aria-current={tab === "vat-rates" ? "page" : undefined}>VAT rates</a>
      <a href="/admin/tax-currency/currencies" className={tab === "currencies" ? "on" : undefined} aria-current={tab === "currencies" ? "page" : undefined}>Currencies</a>
      <a href="/admin/lookups?category=payment_terms">Payment terms ↗</a>
    </nav>
  </>;
}
