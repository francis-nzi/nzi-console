/** Client-review loop S8: where a report-signee contact is added - the client's Record tab, whose contact form has the Report signee role. */
export const signeeContactsHref = (clientId: string): string => `/clients/${encodeURIComponent(clientId)}?area=record`;

export const SIGNEE_EMPTY_LEAD = "No contact is marked Report signee for this client.";
export const SIGNEE_EMPTY_HOW = "Add or edit a contact on the client's Record tab and tick Report signee; it will then be offered here.";
