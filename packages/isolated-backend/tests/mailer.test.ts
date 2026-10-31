import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mailDelivery, smtpSettingsFrom, SmtpConfigurationError } from "../src/mailer";

/**
 * The gate in front of the wire. Two conditions, both about mail: the deliberate switch, and a complete SMTP
 * configuration. It reads neither the database-isolation token nor the app environment.
 */
describe("whether mail may leave the building", () => {
  const smtp = { SMTP_HOST: "smtp.example.com", SMTP_USER: "u", SMTP_PASS: "p", SMTP_FROM: "f@example.com" };
  const on = { mailMode: "send", smtp };

  it("sends when the switch is on and the SMTP configuration is complete", () => {
    assert.equal(mailDelivery(on).mode, "send");
  });

  it("does not read the database boundary or the app environment: a staging, isolated-boundary service sends once switched on", () => {
    const env = { ...smtp, NZI_DATABASE_BOUNDARY: "isolated-non-production", NEXT_PUBLIC_APP_ENV: "staging" };
    assert.equal(mailDelivery({ mailMode: "send", smtp: env }).mode, "send");
    assert.equal(mailDelivery({ mailMode: "send", ...{ boundaryToken: "isolated-non-production", appEnv: "staging" }, smtp } as never).mode, "send", "a stray boundary or env field changes nothing");
  });

  it("suppresses until the switch is deliberately set, whatever the SMTP configuration", () => {
    assert.equal(mailDelivery({ smtp }).mode, "suppress");
    assert.equal(mailDelivery({ mailMode: "true", smtp }).mode, "suppress", "only the exact string opts in");
    assert.equal(mailDelivery({ mailMode: "SEND", smtp }).mode, "suppress");
    const result = mailDelivery({ smtp });
    assert.match(result.mode === "suppress" ? result.reason : "", /NZI_MAIL_MODE/);
  });

  it("suppresses when it is told nothing at all", () => {
    // The default has to be silence: an unconfigured worker must not discover a way to send.
    assert.equal(mailDelivery({}).mode, "suppress");
  });

  it("with the switch on, an incomplete SMTP configuration fails loudly — it neither sends nor quietly suppresses", () => {
    for (const missing of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"]) {
      assert.throws(() => mailDelivery({ mailMode: "send", smtp: { ...smtp, [missing]: "" } }), (error: unknown) =>
        error instanceof SmtpConfigurationError && error.message.includes(missing) && !error.message.includes("smtp.example.com"), missing);
    }
    assert.throws(() => mailDelivery({ mailMode: "send" }), SmtpConfigurationError, "no SMTP variables at all");
    assert.throws(() => mailDelivery({ mailMode: "send", smtp: { ...smtp, SMTP_PORT: "nope" } }), SmtpConfigurationError);
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
