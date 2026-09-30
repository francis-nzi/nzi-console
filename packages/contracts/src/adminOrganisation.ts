/**
 * Organisation settings (admin Phase D, D1; ruled `phaseD-org-settings-plan.md`, Q1–Q11). The company profile as typed
 * fields — one record per organisation — with the bank details apart, the logo as an asset, and the intensity metrics a
 * new client starts with. The same rules the command validates are 0142's CHECKs, stated once here for the screen.
 */

export type OrganisationProfileFields = {
  legalName: string | null;
  displayName: string | null;
  registrationNumber: string | null;
  vatNumber: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  addressCity: string | null;
  addressRegion: string | null;
  addressPostcode: string | null;
  addressCountry: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  websiteUrl: string | null;
  footerOverride: string | null;
  signatoryUserId: string | null;
  signatoryTitle: string | null;
};
export const ORGANISATION_PROFILE_FIELDS = [
  "legalName", "displayName", "registrationNumber", "vatNumber", "addressLine1", "addressLine2", "addressCity", "addressRegion",
  "addressPostcode", "addressCountry", "contactEmail", "contactPhone", "websiteUrl", "footerOverride", "signatoryUserId", "signatoryTitle",
] as const satisfies ReadonlyArray<keyof OrganisationProfileFields>;

export type OrganisationBankFields = { accountName: string | null; sortCode: string | null; accountNumber: string | null };
export const ORGANISATION_BANK_FIELDS = ["accountName", "sortCode", "accountNumber"] as const satisfies ReadonlyArray<keyof OrganisationBankFields>;

/** Text limits, as 0142 holds them. */
export const ORGANISATION_TEXT_MAX: Record<Exclude<keyof OrganisationProfileFields, "registrationNumber" | "vatNumber" | "contactEmail" | "contactPhone" | "websiteUrl" | "signatoryUserId">, number> = {
  legalName: 200, displayName: 120, addressLine1: 200, addressLine2: 200, addressCity: 100, addressRegion: 100, addressPostcode: 20,
  addressCountry: 100, footerOverride: 500, signatoryTitle: 120,
};
export const BANK_ACCOUNT_NAME_MAX = 140;

const blankToNull = (value: string | null | undefined) => { const trimmed = value?.trim().replace(/\s+/g, " "); return trimmed ? trimmed : null; };

/**
 * What a profile save stores: text trimmed and spaces collapsed, blanks as null; registration and VAT numbers
 * upper-cased with their spaces removed (`GB 123 4567 89` → `GB123456789`); the website as given.
 */
export function normaliseProfile(fields: OrganisationProfileFields): OrganisationProfileFields {
  const out = Object.fromEntries(ORGANISATION_PROFILE_FIELDS.map((key) => [key, blankToNull(fields[key])])) as OrganisationProfileFields;
  if (out.registrationNumber) out.registrationNumber = out.registrationNumber.replace(/\s+/g, "").toUpperCase();
  if (out.vatNumber) out.vatNumber = out.vatNumber.replace(/\s+/g, "").toUpperCase();
  if (out.contactEmail) out.contactEmail = out.contactEmail.toLowerCase();
  return out;
}

/** A sort code as digits only (`12-34-56` → `123456`); the rest trimmed. */
export function normaliseBank(fields: OrganisationBankFields): OrganisationBankFields {
  return {
    accountName: blankToNull(fields.accountName),
    sortCode: fields.sortCode?.replace(/[\s-]/g, "") || null,
    accountNumber: fields.accountNumber?.replace(/\s/g, "") || null,
  };
}

export type OrganisationIssue = { field: string; code: string; message: string };

/** The profile's field rules, on normalised values — the same as 0142's CHECKs. */
export function profileIssues(fields: OrganisationProfileFields): OrganisationIssue[] {
  const issues: OrganisationIssue[] = [];
  for (const [key, max] of Object.entries(ORGANISATION_TEXT_MAX) as Array<[keyof typeof ORGANISATION_TEXT_MAX, number]>) {
    const value = fields[key];
    if (value !== null && value.length > max) issues.push({ field: key, code: "TOO_LONG", message: `At most ${max} characters.` });
  }
  if (fields.registrationNumber !== null && !/^[A-Z0-9]{1,20}$/.test(fields.registrationNumber)) issues.push({ field: "registrationNumber", code: "INVALID", message: "Letters and digits only, up to 20." });
  if (fields.vatNumber !== null && !/^[A-Z]{0,2}[0-9A-Z]{2,15}$/.test(fields.vatNumber)) issues.push({ field: "vatNumber", code: "INVALID", message: "A VAT number: an optional two-letter country prefix, then its digits." });
  if (fields.contactEmail !== null && (fields.contactEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.contactEmail))) issues.push({ field: "contactEmail", code: "INVALID", message: "An email address." });
  if (fields.contactPhone !== null && !/^[0-9+() .-]{5,30}$/.test(fields.contactPhone)) issues.push({ field: "contactPhone", code: "INVALID", message: "A phone number: digits, spaces and + ( ) - only." });
  if (fields.websiteUrl !== null && (fields.websiteUrl.length > 300 || !/^https?:\/\/\S+$/.test(fields.websiteUrl))) issues.push({ field: "websiteUrl", code: "INVALID", message: "A web address starting https://" });
  if (fields.signatoryTitle !== null && fields.signatoryUserId === null) issues.push({ field: "signatoryTitle", code: "NO_SIGNATORY", message: "Choose the signatory the title belongs to." });
  return issues;
}

/** The bank rules: all three or none; a six-digit sort code and an eight-digit account number. */
export function bankIssues(fields: OrganisationBankFields): OrganisationIssue[] {
  const issues: OrganisationIssue[] = [];
  const given = ORGANISATION_BANK_FIELDS.filter((key) => fields[key] !== null);
  if (given.length > 0 && given.length < 3) for (const key of ORGANISATION_BANK_FIELDS) if (fields[key] === null) issues.push({ field: key, code: "REQUIRED", message: "All three bank details, or none." });
  if (fields.accountName !== null && fields.accountName.length > BANK_ACCOUNT_NAME_MAX) issues.push({ field: "accountName", code: "TOO_LONG", message: `At most ${BANK_ACCOUNT_NAME_MAX} characters.` });
  if (fields.sortCode !== null && !/^[0-9]{6}$/.test(fields.sortCode)) issues.push({ field: "sortCode", code: "INVALID", message: "A sort code is six digits." });
  if (fields.accountNumber !== null && !/^[0-9]{8}$/.test(fields.accountNumber)) issues.push({ field: "accountNumber", code: "INVALID", message: "An account number is eight digits." });
  return issues;
}

/**
 * The footer every consumer prints (Q11): the override when set, otherwise derived from the profile as v7 built it —
 * legal name · website · company number · VAT number — so a changed number can never leave a stale footer behind.
 */
export function organisationFooter(profile: Pick<OrganisationProfileFields, "legalName" | "displayName" | "websiteUrl" | "registrationNumber" | "vatNumber" | "footerOverride">): string {
  if (profile.footerOverride) return profile.footerOverride;
  return [
    profile.legalName ?? profile.displayName,
    profile.websiteUrl?.replace(/^https?:\/\//, "").replace(/\/$/, ""),
    profile.registrationNumber ? `Company No. ${profile.registrationNumber}` : null,
    profile.vatNumber ? `VAT No. ${profile.vatNumber}` : null,
  ].filter((part): part is string => Boolean(part)).join(" | ");
}

/** Bank details as the screen shows them unless someone asks: the last digits only. */
export const maskAccountNumber = (value: string | null) => value === null ? null : `•••• ${value.slice(-4)}`;
export const maskSortCode = (value: string | null) => value === null ? null : `••-••-${value.slice(-2)}`;
export const formatSortCode = (value: string | null) => value === null ? null : `${value.slice(0, 2)}-${value.slice(2, 4)}-${value.slice(4, 6)}`;
