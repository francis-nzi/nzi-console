/**
 * D3b — how client-facing copy names the organisation. One read on the server (`deploymentBrand()`), these two
 * names passed down, and every sentence built here, so "your NZI consultant" is never typed into a component again
 * (`organisationCopy.test.ts` fails if it is).
 *
 * `null` means the profile could not be read — fixture mode, or the database is unavailable. The copy then reads
 * without a name ("your adviser", "your consultant") rather than inventing one.
 */
export type OrganisationNames = { displayName: string; shortName: string } | null;

export type OrganisationCopy = {
  /** The short name as a noun — "Submitted to NZI for review". */
  short: string;
  /** The same, at the start of a sentence. */
  Short: string;
  /** The display name, for a footer; null when unknown, so the footer omits it rather than guessing. */
  display: string | null;
  /** "your NZI consultant", or "your consultant" without a name; `qualifier` reads before the name ("your named NZI adviser"). */
  your: (role: string, qualifier?: string) => string;
  /** The same, at the start of a sentence. */
  Your: (role: string, qualifier?: string) => string;
};

const words = (...parts: Array<string | undefined>) => parts.filter(Boolean).join(" ");

export function organisationCopy(names: OrganisationNames): OrganisationCopy {
  if (!names) return {
    short: "your adviser", Short: "Your adviser", display: null,
    your: (role, qualifier) => words("your", qualifier, role), Your: (role, qualifier) => words("Your", qualifier, role),
  };
  const { shortName, displayName } = names;
  return {
    short: shortName, Short: shortName, display: displayName,
    your: (role, qualifier) => words("your", qualifier, shortName, role), Your: (role, qualifier) => words("Your", qualifier, shortName, role),
  };
}
