import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isValidWebsite, normaliseWebsite } from "../src/clientWebsite";
import { commandDefinitions } from "../src/commands";

/** A client's website (CLIENT-07): a bare domain is normalised, never refused; only what is not an address is. */
describe("a client's website", () => {
  it("normalises: blank or the bare https:// is no website; no scheme gets https://; a named scheme is kept", () => {
    assert.equal(normaliseWebsite(null), null);
    assert.equal(normaliseWebsite("  "), null);
    assert.equal(normaliseWebsite("https://"), null, "the form's starting value");
    assert.equal(normaliseWebsite("acme.com"), "https://acme.com");
    assert.equal(normaliseWebsite("  www.acme.co.uk/about "), "https://www.acme.co.uk/about");
    assert.equal(normaliseWebsite("http://acme.com"), "http://acme.com", "http stays http");
    assert.equal(normaliseWebsite("ftp://acme.com"), "ftp://acme.com", "a named scheme is kept, for validation to refuse");
  });

  it("validates the normalised address: http or https, a host with a dot, no whitespace", () => {
    for (const ok of ["https://acme.com", "http://acme.com", "https://www.acme.co.uk/about?x=1"]) assert.equal(isValidWebsite(ok), true, ok);
    for (const bad of ["ftp://acme.com", "javascript:alert(1)", "https://acme", "https://acme .com", "https://.com", "https://acme."]) assert.equal(isValidWebsite(bad), false, bad);
  });

  it("client.create accepts a bare domain and refuses only what is not an address", () => {
    const issues = (website: string | null) => commandDefinitions["client.create"].validate(
      { name: "Acme", status: "active", sector: "Manufacturing", location: "Leeds, UK", owner: "Ada", website } as never,
      { actorId: "ada", organisationId: "org-a", idempotencyKey: "key-1", correlationId: "corr-1" } as never,
    ).filter((issue) => issue.field === "website");
    assert.deepEqual(issues("acme.com"), [], "a bare domain is not an error");
    assert.deepEqual(issues("https://"), [], "the form's starting value is no website, not an error");
    assert.deepEqual(issues(null), []);
    assert.deepEqual(issues("ftp://acme.com").map((issue) => issue.code), ["INVALID"]);
    assert.deepEqual(issues("not a website").map((issue) => issue.code), ["INVALID"]);
    assert.ok(!issues("ftp://acme.com")[0]!.message.includes("must start with"), "no more \"must start with…\"");
  });
});
