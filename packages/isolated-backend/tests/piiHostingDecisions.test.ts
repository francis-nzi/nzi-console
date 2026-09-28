import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { PII_HOSTING_DECISIONS } from "../src/piiInventory";

/**
 * Real personal data is in this isolated store only by accepted decision — staff (26 Sep 2026) and clients
 * (28 Sep 2026). The inventory and DEPLOYMENT.md record the same decisions, each with the commitment to replicate
 * to production; neither may drift from the other.
 */

// Spelled out rather than locale-formatted: ICU renders September as "Sept" in some versions.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const here = dirname(fileURLToPath(import.meta.url));
const deployment = readFileSync(resolve(here, "../../../docs/DEPLOYMENT.md"), "utf8");
const section = deployment.slice(deployment.indexOf("## Personal data in the isolated store"), deployment.indexOf("## Staff enrolment (0129)"));

describe("why personal data is in the isolated store", () => {
  it("records the staff and client decisions, each with its terms and the commitment to replicate to production", () => {
    assert.deepEqual(PII_HOSTING_DECISIONS.map((decision) => decision.population), ["NZI staff", "Clients"]);
    for (const decision of PII_HOSTING_DECISIONS) {
      assert.match(decision.accepted, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(decision.terms.includes("ealed"), `${decision.population}: accepted without sealing in its terms`);
      assert.match(decision.commitment, /true production environment/);
    }
  });

  it("says the same in DEPLOYMENT.md", () => {
    assert.ok(section.length > 0, "DEPLOYMENT.md has no 'Personal data in the isolated store' section");
    assert.ok(section.includes("PII_HOSTING_DECISIONS"), "DEPLOYMENT.md does not point at the inventory");
    assert.match(section, /replicated there/);
    for (const decision of PII_HOSTING_DECISIONS) {
      const [year, month, day] = decision.accepted.split("-").map(Number);
      const written = `${day} ${MONTHS[month! - 1]} ${year}`;
      assert.ok(section.includes(decision.population.split(" ").pop()!) && section.includes(written),
        `DEPLOYMENT.md does not record ${decision.population}, accepted ${written}`);
    }
  });
});
