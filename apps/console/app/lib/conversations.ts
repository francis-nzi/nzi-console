import "server-only";
import { portalFeatureEnabled } from "./portalFlags";

/** The conversation routes are dark until `portal-conversations` is on (dark by absence), and 404 while it is off - as the files routes are. */
export class ConversationsOffError extends Error { constructor() { super("Not found."); this.name = "ConversationsOffError"; } }
export const requireConversations = (): void => { if (!portalFeatureEnabled("portal-conversations")) throw new ConversationsOffError(); };
export const conversationsOff = (error: unknown): Response | null => error instanceof ConversationsOffError ? Response.json({ code: "NOT_FOUND", message: "Not found." }, { status: 404 }) : null;
