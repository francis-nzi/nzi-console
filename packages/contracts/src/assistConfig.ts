import type { AssistSurface } from "./aiAssist";

/**
 * Two assistants, keyed and configured apart (NZC-112).
 *
 * The staff help drawer and the client-facing entry assistant are different systems that happen to
 * use the same kind of model. They face different people, carry different risk, and will want
 * different limits — so they are separated at the composition edge from the start, while the cost
 * of doing so is one environment variable and one config object each.
 *
 * **What the separation buys.** They can be rate-limited independently, so a client hammering the
 * entry assistant cannot exhaust the budget the consultants' help drawer runs on. They can be
 * monitored apart, so "the client assistant is behaving oddly" is a question with an answer. And a
 * compromised or misconfigured credential is contained to one of them: a key leaked from the portal
 * surface cannot be used to drive the staff system, and vice versa.
 *
 * **Why now rather than when the real model lands.** Collapsing them onto one key is a decision
 * that becomes invisible the moment it is made — it looks like nothing, reads like nothing, and is
 * discovered later by whoever is trying to work out why revoking one key broke two products. The
 * seam costs nothing while both are stubbed and is expensive to introduce afterwards, because by
 * then something will depend on the shared credential.
 *
 * The key itself is never read here. This describes *which* configuration a surface uses; the
 * value is supplied at the edge, which keeps the one place a secret enters the process greppable —
 * the discipline `answerModel.ts` already follows.
 */

export type AssistConfig = {
  /** Which surface this configuration serves. One config is never shared by both. */
  surface: AssistSurface;
  /** The environment variable the credential comes from. Named, not read. */
  keyVariable: string;
  /** How many questions this surface may ask before handing over to the form. */
  maxRounds: number;
  /** Requests per session per minute. A client-facing surface is held tighter than a staff one. */
  requestsPerMinute: number;
};

/**
 * The consultant-facing entry assistant. Distinct from the staff *help* system
 * (`ANTHROPIC_API_KEY`), which answers questions about the platform rather than proposing entries —
 * a third concern, and deliberately not merged into either of these.
 */
export const CONSOLE_ASSIST: AssistConfig = {
  surface: "console",
  keyVariable: "NZI_ASSIST_CONSOLE_API_KEY",
  maxRounds: 3,
  requestsPerMinute: 30,
};

/** The client-facing entry assistant. Its own credential, and a tighter limit. */
export const PORTAL_ASSIST: AssistConfig = {
  surface: "portal",
  keyVariable: "NZI_ASSIST_PORTAL_API_KEY",
  maxRounds: 3,
  requestsPerMinute: 10,
};

export const assistConfigFor = (surface: AssistSurface): AssistConfig =>
  surface === "portal" ? PORTAL_ASSIST : CONSOLE_ASSIST;

/** Every configured assistant, for the test that holds them apart. */
export const assistConfigs: readonly AssistConfig[] = [CONSOLE_ASSIST, PORTAL_ASSIST] as const;
