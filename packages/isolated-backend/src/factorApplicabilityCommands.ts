import type { CommandContext, CommandInputMap, FactorApplicability } from "@nzi/contracts";
import { addApplicabilityIn, FactorApplicabilityError, retireApplicabilityIn } from "./factorApplicability";
import type { PoolLike } from "./postgres";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";

/**
 * Dedup slice 5 Step B: applicability curated through registered commands, now it is the system of record.
 *
 * `factor.applicability.add` and `factor.applicability.retire` run under the command runner like every governed write — the
 * `factor.manage` grant (Admin alone), the command's validation, idempotency, the audit (the pair before; the result after) and the
 * outbox — over the same in-transaction cores `addFactorApplicability` and `retireFactorApplicability` use, so there is one rule for
 * what an add or a retire does. The registry is asked whether the factor is a base, exists here, and whether the suffix is
 * registered and active; a refusal is the command's validation error, said in the caller's terms.
 */

const FIELD: Record<FactorApplicabilityError["reason"], string> = {
  "variant-id": "factorId", "unknown-factor": "factorId", unknown: "factorId",
  "unknown-suffix": "suffixCode", "retired-suffix": "suffixCode", "no-reason": "reason",
};

/** The core's refusal as the command's validation error: the field it concerns, and a code in the commands' own style. */
const asValidation = (error: unknown): never => {
  if (error instanceof FactorApplicabilityError) {
    throw new CommandValidationError([{ field: FIELD[error.reason], code: error.reason.toUpperCase().replace(/-/g, "_"), message: error.message }]);
  }
  throw error;
};

/** Mark a base factor usable under a category, with the pair's labels. Idempotent; reinstates a retired pair. */
export function addFactorApplicabilityCommand(pool: PoolLike, input: CommandInputMap["factor.applicability.add"], context: CommandContext)
  : Promise<StoredOutcome<{ applicability: FactorApplicability; outcome: "added" | "reinstated" | "already-applicable" }>> {
  return runPostgresCommand(pool, "factor.applicability.add", input, context, async (db) => {
    const added = await addApplicabilityIn(db, context.organisationId, context.actorId, input).catch(asValidation);
    return {
      data: { applicability: added.applicability, outcome: added.outcome },
      entityType: "factor_applicability", entityId: `${added.applicability.factorId}${added.applicability.suffixCode}`, topic: `factor.applicability.${added.outcome}`,
      ...(added.before ? { before: added.before } : {}),
    };
  });
}

/** Withhold a category from a base factor's new use, keeping the record. Idempotent; the reason is the command's own. */
export function retireFactorApplicabilityCommand(pool: PoolLike, input: CommandInputMap["factor.applicability.retire"], context: CommandContext)
  : Promise<StoredOutcome<{ applicability: FactorApplicability; alreadyRetired: boolean }>> {
  return runPostgresCommand(pool, "factor.applicability.retire", input, context, async (db) => {
    const retired = await retireApplicabilityIn(db, context.organisationId, context.actorId,
      { factorId: input.factorId.trim(), suffixCode: input.suffixCode.trim(), reason: context.reason ?? "" }).catch(asValidation);
    return {
      data: { applicability: retired.applicability, alreadyRetired: retired.alreadyRetired },
      entityType: "factor_applicability", entityId: `${retired.applicability.factorId}${retired.applicability.suffixCode}`, topic: "factor.applicability.retired",
      before: retired.before,
    };
  });
}
