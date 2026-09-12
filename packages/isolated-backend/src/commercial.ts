import { randomUUID } from "node:crypto";
import type { CommandContext, CommandInputMap, CommandKey, CommandOutcome } from "@nzi/contracts";
import type { PoolLike, Queryable } from "./postgres";
import { runPostgresCommand } from "./postgresCommands";

type CommercialResult = { documentId: string; version?: number; jobId?: string; invoiceNumber?: string };
const event = async (db: Queryable, organisationId: string, documentType: string, documentId: string, eventType: string, actorId: string, detail: Record<string, unknown> = {}) => {
  await db.query(`INSERT INTO nzi_console.commercial_document_events
    (organisation_id,event_id,document_type,document_id,event_type,actor_id,detail_json)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [organisationId, randomUUID(), documentType, documentId, eventType, actorId, JSON.stringify(detail)]);
};
const command = <K extends CommandKey>(pool: PoolLike, key: K, input: CommandInputMap[K], context: CommandContext, handler: (db: Queryable) => Promise<{ data: CommercialResult; entityType: string; entityId: string; topic: string }>) => runPostgresCommand(pool, key, input, context, handler);

export function createQuote(pool: PoolLike, input: CommandInputMap["commercial.quote.create"], context: CommandContext) {
  return command(pool, "commercial.quote.create", input, context, async (db) => { const id = randomUUID(); await db.query(`INSERT INTO nzi_console.quotes (organisation_id,quote_id,client_id) VALUES ($1,$2,$3)`, [context.organisationId, id, input.clientId]); await db.query(`INSERT INTO nzi_console.quote_versions (organisation_id,quote_id,version,title,total,currency,valid_until,created_by) VALUES ($1,$2,1,$3,$4,$5,$6,$7)`, [context.organisationId, id, input.title.trim(), input.total, input.currency, input.validUntil, context.actorId]); await event(db, context.organisationId, "quote", id, "created", context.actorId); return { data: { documentId: id, version: 1 }, entityType: "quote", entityId: id, topic: "commercial.quote.created" }; });
}

export function raiseInvoice(pool: PoolLike, input: CommandInputMap["commercial.invoice.raise"], context: CommandContext) {
  return command(pool, "commercial.invoice.raise", input, context, async (db) => { const id = randomUUID(); const number = `INV-${Date.now().toString().slice(-6)}`; const subtotal = input.lineItems.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0); await db.query(`INSERT INTO nzi_console.invoices (organisation_id,invoice_id,invoice_number,client_id,quote_id,currency,subtotal,balance) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`, [context.organisationId, id, number, input.clientId, input.quoteId ?? null, input.currency, subtotal]); for (const line of input.lineItems) await db.query(`INSERT INTO nzi_console.invoice_line_items (organisation_id,line_item_id,invoice_id,description,quantity,unit_price) VALUES ($1,$2,$3,$4,$5,$6)`, [context.organisationId, randomUUID(), id, line.description, line.quantity, line.unitPrice]); await event(db, context.organisationId, "invoice", id, "raised", context.actorId); return { data: { documentId: id, invoiceNumber: number, version: 1 }, entityType: "invoice", entityId: id, topic: "commercial.invoice.raised" }; });
}

export function createCreditNote(pool: PoolLike, input: CommandInputMap["commercial.creditNote.create"], context: CommandContext) {
  return command(pool, "commercial.creditNote.create", input, context, async (db) => { const id = randomUUID(); const number = `CN-${Date.now().toString().slice(-6)}`; await db.query(`INSERT INTO nzi_console.credit_notes (organisation_id,credit_note_id,credit_note_number,client_id,invoice_id,job_id,amount,currency) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [context.organisationId, id, number, input.clientId, input.invoiceId ?? null, input.jobId ?? null, input.amount, input.currency]); await event(db, context.organisationId, "credit_note", id, "created", context.actorId, { reason: input.reason }); return { data: { documentId: id, version: 1 }, entityType: "credit_note", entityId: id, topic: "commercial.credit_note.created" }; });
}

async function transition(pool: PoolLike, key: "commercial.quote.send" | "commercial.quote.approve" | "commercial.quote.accept" | "commercial.quote.revise" | "commercial.invoice.send" | "commercial.creditNote.apply" | "commercial.invoice.markPaid", input: CommandInputMap[typeof key], context: CommandContext) {
  const documentId = "quoteId" in input ? input.quoteId : "invoiceId" in input ? input.invoiceId : input.creditNoteId;
  const table = "quoteId" in input ? "quotes" : "invoiceId" in input ? "invoices" : "credit_notes";
  const status = key.endsWith("send") ? "sent" : key.endsWith("approve") ? "approved" : key.endsWith("accept") ? "converted" : key.endsWith("apply") ? "applied" : key.endsWith("markPaid") ? "paid" : "draft";
  return command(pool, key, input, context, async (db) => {
    let jobId: string | undefined;
    if (key === "commercial.quote.accept") {
      jobId = randomUUID();
      const quote = await db.query<{ client_id: string; title: string }>(`SELECT q.client_id,v.title FROM nzi_console.quotes q JOIN nzi_console.quote_versions v ON (v.organisation_id,v.quote_id,v.version)=(q.organisation_id,q.quote_id,q.current_version) WHERE q.organisation_id=$1 AND q.quote_id=$2 FOR UPDATE`, [context.organisationId, documentId]);
      if (!quote.rows[0]) throw new Error("Quote not found.");
      await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage) VALUES ($1,$2,$3,nzi_console.allocate_job_sequence(),'crp',$4,'draft','Setup')`, [context.organisationId, jobId, quote.rows[0].client_id, quote.rows[0].title]);
    }
    await db.query(`UPDATE nzi_console.${table} SET status=$1, version=version+1, updated_at=now() WHERE organisation_id=$2 AND ${table === "quotes" ? "quote_id" : table === "invoices" ? "invoice_id" : "credit_note_id"}=$3 AND version=$4`, [status, context.organisationId, documentId, "expectedVersion" in input ? input.expectedVersion : 1]);
    await event(db, context.organisationId, table === "quotes" ? "quote" : table === "invoices" ? "invoice" : "credit_note", documentId, key.split(".").at(-1) ?? "changed", context.actorId, "xeroPaymentRef" in input ? { xeroPaymentRef: input.xeroPaymentRef } : {});
    return { data: { documentId, ...(jobId ? { jobId } : {}) }, entityType: table, entityId: documentId, topic: `commercial.${table}.changed` };
  });
}
export const sendQuote = (pool: PoolLike, input: CommandInputMap["commercial.quote.send"], context: CommandContext) => transition(pool, "commercial.quote.send", input, context);
export const approveQuote = (pool: PoolLike, input: CommandInputMap["commercial.quote.approve"], context: CommandContext) => transition(pool, "commercial.quote.approve", input, context);
export const acceptQuote = (pool: PoolLike, input: CommandInputMap["commercial.quote.accept"], context: CommandContext) => transition(pool, "commercial.quote.accept", input, context);
export const reviseQuote = (pool: PoolLike, input: CommandInputMap["commercial.quote.revise"], context: CommandContext) => transition(pool, "commercial.quote.revise", input, context);
export const sendInvoice = (pool: PoolLike, input: CommandInputMap["commercial.invoice.send"], context: CommandContext) => transition(pool, "commercial.invoice.send", input, context);
export const applyCreditNote = (pool: PoolLike, input: CommandInputMap["commercial.creditNote.apply"], context: CommandContext) => transition(pool, "commercial.creditNote.apply", input, context);
export const markInvoicePaid = (pool: PoolLike, input: CommandInputMap["commercial.invoice.markPaid"], context: CommandContext) => transition(pool, "commercial.invoice.markPaid", input, context);

export const emailQuote = (pool: PoolLike, input: CommandInputMap["commercial.quote.email"], context: CommandContext) => emailDocument(pool, { documentId: input.quoteId, documentType: "quote", recipient: input.recipient }, context);
export const emailDocument = (pool: PoolLike, input: CommandInputMap["commercial.document.email"], context: CommandContext) => command(pool, "commercial.document.email", input, context, async (db) => { await event(db, context.organisationId, input.documentType, input.documentId, "emailed", context.actorId, { recipient: input.recipient }); return { data: { documentId: input.documentId }, entityType: input.documentType, entityId: input.documentId, topic: "commercial.document.emailed" }; });
