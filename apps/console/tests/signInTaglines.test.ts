import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/** Both sign-in pages carry the same two taglines, and the old staff lines are gone. */
const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(here, "..", path), "utf8");
const MAIN = "<h1>Building stronger businesses for a changing climate.</h1>";
const SECOND = "<p>Mitigating risk, lowering costs, and protecting growth.</p>";
const OLD = [/Evidence-led carbon work/, /One secure workspace for client delivery/];

describe("sign-in taglines", () => {
  it("the staff console sign-in shows the two new lines", () => {
    const page = read("app/login/page.tsx");
    assert.ok(page.includes(MAIN));
    assert.ok(page.includes(SECOND));
    for (const old of OLD) assert.doesNotMatch(page, old);
  });

  it("the client portal sign-in shows the two new lines", () => {
    const page = read("app/portal/login/page.tsx");
    assert.ok(page.includes(MAIN));
    assert.ok(page.includes(SECOND));
    for (const old of OLD) assert.doesNotMatch(page, old);
  });
});
