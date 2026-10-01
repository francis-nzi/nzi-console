import { redirect } from "next/navigation";
import { adminAccess } from "../adminAccess";

export const dynamic = "force-dynamic";

/** Tax & currency (admin Phase E1) opens on its first tab, VAT rates. */
export default async function TaxCurrencyPage() {
  const access = await adminAccess();
  if (access.state !== "allowed") return null; // The layout states why; nothing is read.
  redirect("/admin/tax-currency/vat-rates");
}
