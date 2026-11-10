/**
 * Whose work a job or a client is — the routing the platform already uses, in one place, for the personalised Control Room
 * (crmControlRoom.ts) and the lists' `crm` filter (listReads.ts) to share.
 */

/** A job's CRM, over `jobs j JOIN clients c`: the job's manager, else the client's manager, else its owner — as the reopen-request notice routes it. */
export const JOB_CRM_SQL = "coalesce(j.client_manager_user_id, c.client_manager_user_id, c.owner_user_id)";
/** A client's CRM, over `clients c`: its manager, else its owner — as the SRS review reminder routes it. */
export const CLIENT_CRM_SQL = "coalesce(c.client_manager_user_id, c.owner_user_id)";
