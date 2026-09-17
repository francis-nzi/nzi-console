import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clientReferences, resolveReference } from "../src/clientReference";

/**
 * Resolving a client's identity references (NZC-090).
 *
 * The fallback is tested as the **ordinary** case, not as an edge one, because that is what the
 * first dry run showed it to be: nearly every sector, owner and manager on staging resolved to
 * stored text rather than to a curated id, and staging is smaller and more synthetic than live.
 *
 * Three things keep it that way for good, not just until the lists improve:
 *   - archive is deactivation, so a client keeps pointing at a value that has left the search;
 *   - every client predating the lookups holds free text typed against nothing;
 *   - "Food & beverage" and "Food and Drink" are one industry to a person and two strings to a
 *     matcher. Aliases will shrink that population; they will not empty it.
 */

const row = (over: Record<string, unknown> = {}) => ({
  sector_value_id: null, sector_label: null, sector: null,
  referral_value_id: null, referral_label: null, referral: null,
  owner_user_id: null, owner_label: null, owner_name: null,
  client_manager_user_id: null, client_manager_label: null, client_manager: null,
  ...over,
}) as Parameters<typeof clientReferences>[0];

describe("a reference resolves in three steps, always", () => {
  it("prefers the curated label when the client holds an id", () => {
    const resolved = resolveReference("industries:manufacturing", "Manufacturing", "Manufacuring");
    assert.deepEqual(resolved, { id: "industries:manufacturing", label: "Manufacturing", source: "reference" });
    // And the misspelling the client used to hold is not what anyone now sees.
  });

  it("falls back to the client's own text — the common case, not the exception", () => {
    const resolved = resolveReference(null, null, "Food & beverage");
    assert.deepEqual(resolved, { id: null, label: "Food & beverage", source: "legacy" });
  });

  it("still shows a value whose reference has gone", () => {
    // Belt and braces for the rule that DELETE is revoked: even if a value vanished, the client
    // would keep reading, because losing a client's recorded industry is worse than showing a
    // stale one.
    const resolved = resolveReference("industries:gone", null, "Lighting");
    assert.deepEqual(resolved, { id: null, label: "Lighting", source: "legacy" });
  });

  it("reports nothing as nothing, rather than as an empty reference", () => {
    assert.deepEqual(resolveReference(null, null, null), { id: null, label: "", source: "none" });
    assert.deepEqual(resolveReference(null, null, "   "), { id: null, label: "", source: "none" });
  });

  it("never shows an id to a person", () => {
    // An id in a label is the failure this whole conversion would be judged by.
    for (const resolved of [
      resolveReference("industries:manufacturing", "Manufacturing", null),
      resolveReference("industries:manufacturing", null, "Manufacturing"),
      resolveReference(null, null, "Manufacturing"),
    ]) {
      assert.doesNotMatch(resolved.label, /industries:/);
    }
  });
});

describe("a client's four references", () => {
  it("resolves each independently, so one legacy value does not drag the others down", () => {
    // The shape the dry run found: an industry nobody curated, beside an owner who is on the
    // roster, beside a referral that matched.
    const references = clientReferences(row({
      sector: "Interpretive Dance",
      referral_value_id: "referrals:website", referral_label: "Website", referral: "Website",
      owner_user_id: "david", owner_label: "David Hawes", owner_name: "D. Hawes",
      client_manager: "A. Shaw",
    }));
    assert.equal(references.sector.source, "legacy");
    assert.equal(references.sector.label, "Interpretive Dance");
    assert.equal(references.referral.source, "reference");
    assert.equal(references.owner.source, "reference");
    assert.equal(references.owner.label, "David Hawes", "the roster's name, not the record's abbreviation");
    assert.equal(references.clientManager.source, "legacy");
    assert.equal(references.clientManager.label, "A. Shaw");
  });

  it("gives every field a label a surface can render without checking first", () => {
    const references = clientReferences(row({ sector: "Retail" }));
    for (const reference of Object.values(references)) {
      assert.equal(typeof reference.label, "string");
    }
    assert.equal(references.owner.label, "", "absent reads as empty, and says so in source");
    assert.equal(references.owner.source, "none");
  });
});
