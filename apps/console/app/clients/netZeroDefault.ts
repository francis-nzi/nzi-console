import { NET_ZERO_DEFAULT, type ForwardTargetModel } from "@nzi/contracts";

/**
 * Decision 2 — the net-zero row of the targets editor, when the client holds no net-zero target, starts filled: from
 * the commitment on the client record when it is complete (what the create wizard wrote), else NZI's 90% by 2050.
 * Fill-blank-only: a held net-zero target is never replaced, and nothing is saved until the person saves.
 */
export function netZeroDraft(
  model: ForwardTargetModel | null, profile: { year: number | null; pct: number | null } | null,
): { year: string; pct: string; prefilled: "profile" | "default" | null } {
  if (model?.netZero) return { year: String(model.netZero.year), pct: String(model.netZero.pct), prefilled: null };
  if (profile && profile.year !== null && profile.pct !== null) return { year: String(profile.year), pct: String(profile.pct), prefilled: "profile" };
  return { year: String(NET_ZERO_DEFAULT.year), pct: String(NET_ZERO_DEFAULT.pct), prefilled: "default" };
}
