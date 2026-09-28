/**
 * The organisation that holds real client data: live capture, and the v7 import (NZC-165).
 *
 * Maintenance and fixture scripts written for the demo tenant must never reach it — not by default, not by an
 * environment variable that happens to name it, and not by accident. `NZI_DEMO_ORGANISATION_ID` was repurposed to this
 * id at the cutover, so a script that defaulted its target to that variable would now aim at live data. Scripts that
 * seed, renumber or otherwise rewrite a demo take their organisation from an explicit flag, and call this.
 */
export const LIVE_ORGANISATION = "net-zero-international";

export class LiveOrganisationRefused extends Error {}

/** Refuse, by name, an operation that must never run against the live organisation. */
export function refuseLiveOrganisation(organisationId: string, what: string): void {
  if (organisationId.trim() === LIVE_ORGANISATION) {
    throw new LiveOrganisationRefused(`${what} never runs against ${LIVE_ORGANISATION}: it holds real client data. Name a demo organisation.`);
  }
}
