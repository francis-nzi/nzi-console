/**
 * The currency directory — what `currencySymbol(code)` reads (admin Phase E1; ruled phaseE plan §E1.2). D3c wrote
 * `currencySymbol` as "the one function Phase E swaps its lookup into": its `string → string` signature stays, so no
 * caller changes, and its answer now comes from the organisation's own `currencies` (0145) — the symbol an admin edits
 * on the Tax & currency screen — instead of a table baked into the code.
 *
 * **Where the directory comes from.** `currencySymbol` is synchronous and runs in the browser as well as on the server,
 * so the organisation's set is read ahead of time and held here:
 * - **the console** reads its deployment organisation's set on the server (every console route serves that one
 *   organisation) and a provider registers it, on the server render and in the browser alike;
 * - **an issued report** is composed inside `withCurrencyDirectory(issuer's set, …)`, synchronously, so the unit it
 *   freezes is written in the issuing organisation's symbols and nothing leaks to the next request.
 *
 * Until a directory is read — a unit test, a path that has not loaded one — the three symbols D3c shipped stand in, and
 * any other code is written as itself. **No "UAE" alias** (E-Q2): 0145 corrected the one stored value, and the set holds
 * AED.
 */
export type CurrencyDirectoryEntry = { code: string; name: string; symbol: string };

let current: ReadonlyMap<string, CurrencyDirectoryEntry> | null = null;

/** Before any directory is read: D3c's three, so a unit never regresses to "GBP m" for want of a read. */
const BEFORE_READ: Readonly<Record<string, string>> = { GBP: "£", EUR: "€", USD: "$" };

const normalise = (code: string) => code.trim().toUpperCase();
const indexed = (entries: readonly CurrencyDirectoryEntry[]) => new Map(entries.map((entry) => [normalise(entry.code), entry]));

/** Register the organisation's set (the console's provider). `null` clears it. */
export function setCurrencyDirectory(entries: readonly CurrencyDirectoryEntry[] | null): void {
  current = entries === null ? null : indexed(entries);
}

/** Run `work` — synchronously — against `entries`, then put back whatever was registered before. */
export function withCurrencyDirectory<T>(entries: readonly CurrencyDirectoryEntry[], work: () => T): T {
  const before = current;
  current = indexed(entries);
  try {
    const result = work();
    if (result instanceof Promise) throw new Error("withCurrencyDirectory runs synchronous work only: a directory must not outlive its own request.");
    return result;
  } finally {
    current = before;
  }
}

/**
 * The symbol a currency is written with: the organisation's own, from its `currencies`. A code the directory does not
 * hold is written as the code itself ("CHF"), which a unit then spaces ("CHF m").
 */
export function currencySymbol(code: string): string {
  const iso = normalise(code);
  return current?.get(iso)?.symbol ?? (current === null ? BEFORE_READ[iso] : undefined) ?? iso;
}
