import type { PoolLike, Queryable } from "./postgres";
import { withTenantTransaction } from "./postgres";

export type XeroProjection = { externalRef: string; syncStatus: "synced" | "failed"; lastSyncedAt: string };
export type XeroAdapter = { push: (document: { type: "quote" | "invoice" | "credit_note"; id: string }) => Promise<XeroProjection> };

/** Worker seam: console documents are pushed outward; only payment reconciliation may come back. */
export async function syncPendingCommercialDocuments(pool: PoolLike, organisationId: string, adapter: XeroAdapter): Promise<number> {
  return withTenantTransaction(pool, organisationId, "nzi_console_worker", "write", async (db) => {
    const pending = await db.query<{ document_type: "quote" | "invoice" | "credit_note"; document_id: string }>(`SELECT document_type,document_id FROM nzi_console.commercial_xero_links WHERE sync_status IN ('pending','failed') ORDER BY coalesce(last_synced_at,'1970-01-01') LIMIT 50`);
    let processed = 0;
    for (const document of pending.rows) {
      try {
        const result = await adapter.push({ type: document.document_type, id: document.document_id });
        await db.query(`UPDATE nzi_console.commercial_xero_links SET external_ref=$1,sync_status=$2,last_synced_at=$3 WHERE organisation_id=$4 AND document_type=$5 AND document_id=$6`, [result.externalRef, result.syncStatus, result.lastSyncedAt, organisationId, document.document_type, document.document_id]);
      } catch {
        await db.query(`UPDATE nzi_console.commercial_xero_links SET sync_status='failed' WHERE organisation_id=$1 AND document_type=$2 AND document_id=$3`, [organisationId, document.document_type, document.document_id]);
      }
      processed += 1;
    }
    return processed;
  });
}
