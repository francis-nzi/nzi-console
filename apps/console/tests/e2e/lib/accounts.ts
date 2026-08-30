// Credentials for the rendered-acceptance run, supplied as environment variables
// by `packages/isolated-backend/scripts/provision-acceptance-accounts.ts`.
export type Account = { email: string; password: string; totp: string };

function read(prefix: "STAFF" | "PORTAL"): Account | null {
  const email = process.env[`ACCEPTANCE_${prefix}_EMAIL`]?.trim();
  const password = process.env[`ACCEPTANCE_${prefix}_PASSWORD`]?.trim();
  const totp = process.env[`ACCEPTANCE_${prefix}_TOTP`]?.trim();
  return email && password && totp ? { email, password, totp } : null;
}

export const staffAccount = () => read("STAFF");
export const portalAccount = () => read("PORTAL");
