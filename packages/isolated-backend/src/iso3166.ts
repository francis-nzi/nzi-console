/**
 * ISO 3166-1 alpha-2 codes with their English short names — the list now lives in @nzi/contracts (CLIENT-03), so the
 * console's country typeahead and this backend read one table. Re-exported here for the v7 country reader
 * (v7Countries.ts), whose aliases for v7's own spellings stay backend-side.
 */
export { ISO_3166 } from "@nzi/contracts";
