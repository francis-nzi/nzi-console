import type { PurchasedGoodsBreakdownData } from "./types";
import { EmissionsByActivity } from "./EmissionsByActivity";

/** Purchased goods breakdown reuses the canonical ranked horizontal-bar renderer. */
export function PurchasedGoodsBreakdown(props: { data: PurchasedGoodsBreakdownData; width?: number; showChrome?: boolean }) {
  return <EmissionsByActivity {...props} />;
}
