/**
 * A client's website (CLIENT-07): typed as a person types it, stored as an address.
 *
 * - **Normalise first.** Blank — or the bare `https://` the form starts with — is no website. A value with no scheme
 *   (`acme.com`) gets `https://`. A value that names its scheme keeps it.
 * - **Then validate.** The http / https allow-list stays: any other scheme is refused, and so is anything that does not
 *   read as an address (no host with a dot, or whitespace).
 *
 * The same rule is the form's (on blur), the command's validation and what the command stores, so a bare domain is never
 * an error anywhere and the stored value is always the full address.
 */
export function normaliseWebsite(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "" || /^https?:\/\/?$/i.test(trimmed)) return null;
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** Whether a normalised website is an http or https address with a real host. */
export function isValidWebsite(value: string): boolean {
  if (/\s/.test(value) || !/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.includes(".") && !url.hostname.startsWith(".") && !url.hostname.endsWith(".");
  } catch {
    return false;
  }
}
