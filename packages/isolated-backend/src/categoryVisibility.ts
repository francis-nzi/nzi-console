import type { InputSpecCategory } from "@nzi/contracts";
import { listInputSpec } from "./inputSpecRecords";
import type { Queryable } from "./postgres";

/**
 * What a client sees of the category list, and why (NZC-110).
 *
 * Every category is visible by default, so this reads a list of *decisions* rather than a list of
 * permissions: a row exists only where a consultant decided something, and its absence means the
 * default. That shape is deliberate. If hiding were implemented by simply not sending a category,
 * "nobody has looked at this yet" and "a consultant decided this client does not collect it" would
 * be indistinguishable from outside, and the second would be unanswerable when a client asked.
 *
 * ## Two readers, two questions
 *
 * The **portal** asks "what may I show?" and gets a filtered spec — it never learns that anything
 * was withheld, because a client seeing "3 categories hidden" would be told exactly what they were
 * not told.
 *
 * The **CRM** asks "why does this client's view differ from the default?" and gets the decisions
 * themselves: the category, the choice, who made it, when, and the note. That is the whole point of
 * recording a decision rather than performing a hide (NZC-087 — the staff preview must be able to
 * explain what the client sees).
 */

export type CategoryVisibilityDecision = {
  categoryCode: string;
  visible: boolean;
  note: string;
  decidedBy: string;
  decidedAt: string;
};

type DecisionRow = {
  category_code: string;
  visible: boolean;
  note: string;
  decided_by: string;
  decided_at: Date | string;
};

/** The decisions in force for one client. No row for a category means the default: visible. */
export async function listCategoryVisibility(db: Queryable, clientId: string): Promise<CategoryVisibilityDecision[]> {
  const { rows } = await db.query<DecisionRow>(
    `SELECT category_code, visible, note, decided_by, decided_at
       FROM nzi_console.client_category_visibility
      WHERE client_id=$1 AND active
      ORDER BY category_code`, [clientId]);
  return rows.map((row) => ({
    categoryCode: row.category_code,
    visible: row.visible,
    note: row.note,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at instanceof Date ? row.decided_at.toISOString() : String(row.decided_at),
  }));
}

/** The category codes this client does not see. The narrow answer the portal surfaces need. */
export async function hiddenCategoryCodes(db: Queryable, clientId: string): Promise<Set<string>> {
  const { rows } = await db.query<{ category_code: string }>(
    `SELECT category_code FROM nzi_console.client_category_visibility
      WHERE client_id=$1 AND active AND visible=false`, [clientId]);
  return new Set(rows.map((row) => row.category_code));
}

/**
 * The spec as one client sees it.
 *
 * A hidden category is absent, not flagged: the portal is given what it may show, with no count of
 * what it may not. Anything else would disclose the decision to the person it was made about.
 */
export async function listInputSpecForClient(db: Queryable, clientId: string): Promise<InputSpecCategory[]> {
  const [spec, hidden] = await Promise.all([listInputSpec(db), hiddenCategoryCodes(db, clientId)]);
  return spec.filter((category) => !hidden.has(category.categoryCode));
}
