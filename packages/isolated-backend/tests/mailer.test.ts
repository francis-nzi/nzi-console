import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mailDelivery, smtpSettingsFrom, SmtpConfigurationError } from "../src/mailer";

/**
 * The gate in front of the wire. Every case here is the isolation rule: this repository's
 * services must never email a real client.
 */
describe("whether mail may leave the building", () => {
  const live = { boundaryToken: "live", appEnv: "production", mailMode: "send" };

  it("sends only when all three say so", () => {
    assert.equal(mailDelivery(live).mode, "send");
  });

  it("suppresses on the isolated boundary whatever else is set", () => {
    // The isolation rule, and the reason this service cannot mail a real client however
    // the other two are configured.
    const result = mailDelivery({ ...live, boundaryToken: "isolated-non-production" });
    assert.equal(result.mode, "suppress");
    assert.match(result.mode === "suppress" ? result.reason : "", /isolated non-production/);
  });

  it("suppresses outside production even with the switch on", () => {
    assert.equal(mailDelivery({ ...live, boundaryToken: "live", appEnv: "staging" }).mode, "suppress");
  });

  it("suppresses in production until the switch is deliberately set", () => {
    // A production-looking environment without an explicit opt-in stays quiet.
    assert.equal(mailDelivery({ ...live, mailMode: undefined }).mode, "suppress");
    assert.equal(mailDelivery({ ...live, mailMode: "true" }).mode, "suppress", "only the exact string opts in");
  });

  it("suppresses when it is told nothing at all", () => {
    // The default has to be silence: an unconfigured worker must not discover a way to send.
    assert.equal(mailDelivery({}).mode, "suppress");
  });
});

describe("reading the SMTP contract", () => {
  const env = { SMTP_HOST: "smtp.example.com", SMTP_USER: "u", SMTP_PASS: "p", SMTP_FROM: "f@example.com" };

  it("names what is missing without quoting what is present", () => {
    // A configuration error must never become a way to read a secret out of the logs.
    try {
      smtpSettingsFrom({ ...env, SMTP_PASS: "" });
      assert.fail("expected a configuration error");
    } catch (error) {
      assert.ok(error instanceof SmtpConfigurationError);
      assert.match(error.message, /SMTP_PASS/);
      assert.ok(!error.message.includes("smtp.example.com"), "no value is echoed back");
      assert.ok(!error.message.includes("f@example.com"));
    }
  });

  it("defaults to the Office 365 submission port and requires TLS", () => {
    const settings = smtpSettingsFrom(env);
    assert.equal(settings.port, 587);
    assert.equal(settings.requireTls, true);
  });

  it("makes turning TLS off something you have to ask for by name", () => {
    assert.equal(smtpSettingsFrom({ ...env, SMTP_TLS: "" }).requireTls, true);
    assert.equal(smtpSettingsFrom({ ...env, SMTP_TLS: "0" }).requireTls, true, "only 'false' opts out");
    assert.equal(smtpSettingsFrom({ ...env, SMTP_TLS: "false" }).requireTls, false);
  });

  it("refuses a port that is not a port", () => {
    assert.throws(() => smtpSettingsFrom({ ...env, SMTP_PORT: "not-a-port" }), SmtpConfigurationError);
    assert.throws(() => smtpSettingsFrom({ ...env, SMTP_PORT: "99999" }), SmtpConfigurationError);
  });
});
