// Contact roles (contact.manage) and the client logo (client.edit).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandGrantForRole, validateCommand, type StaffRole } from "@nzi/contracts";
import {
  AuthorizationError, CommandValidationError, createClientContact, deactivateClientContact, inspectClientLogo, logoResponse, removeClientLogo, setClientLogo,
  updateClientContact, validateCrpReport, VersionConflictError,
} from "../src/index";
import { withAccess } from "./support/access";

type Call = { sql: string; values?: readonly unknown[] };
const context = (key: string, role: StaffRole = "consultant", actorId = "consultant-a") => ({ organisationId: "org-a", actorId, principal: "staff" as const, idempotencyKey: key, correlationId: `corr-${key}`, grant: commandGrantForRole(role, "org-a", actorId) });
const contactRow = (over: Record<string, unknown> = {}) => ({ contact_id: "contact-a", client_id: "client-a", full_name: "Dawn Fletcher", job_title: "Operations director", email: "dawn@synthetic.invalid", phone: null, is_primary: false, roles: ["report_signee"], status: "active", version: 2, updated_at: "2026-09-11T10:00:00.000Z", updated_by: "consultant-a", ...over });

function contactPool(calls: Call[], current: Record<string, unknown> | null = contactRow()) {
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      calls.push({ sql, values });
      if (sql.includes("INSERT INTO nzi_console.client_contacts")) return { rows: [contactRow({ contact_id: String(values?.[1]), full_name: values?.[3], is_primary: values?.[7], roles: values?.[8], version: 1 })] };
      if (sql.includes("FROM nzi_console.client_contacts WHERE organisation_id=$1 AND contact_id=$2 FOR UPDATE")) return { rows: current ? [current] : [] };
      if (sql.includes("UPDATE nzi_console.client_contacts SET status='inactive'")) return { rows: [contactRow({ status: "inactive", is_primary: false, version: 3 })] };
      if (sql.includes("UPDATE nzi_console.client_contacts SET full_name")) return { rows: [contactRow({ full_name: values?.[3], is_primary: values?.[7], roles: values?.[8], version: 3 })] };
      return { rows: [] };
    },
    release() {},
  };
  return withAccess({ connect: async () => client } as never);
}

describe("client contacts with roles", () => {
  it("adds a contact with canonical roles, moves the primary flag, and records version 1", async () => {
    const calls: Call[] = [];
    const result = await createClientContact(contactPool(calls), { clientId: "client-a", fullName: " Ian Beale ", jobTitle: "Finance manager", email: "ian@synthetic.invalid", phone: null, isPrimary: true, roles: ["invoice_recipient", "report_signee"] }, context("contact-create"));
    assert.equal(result.data.clientId, "client-a");
    const demote = calls.findIndex((call) => call.sql.includes("SET is_primary=false"));
    const insert = calls.findIndex((call) => call.sql.includes("INSERT INTO nzi_console.client_contacts"));
    assert.ok(demote >= 0 && demote < insert, "the old primary is demoted before the new one is written");
    assert.deepEqual(calls[insert]!.values?.[8], ["report_signee", "invoice_recipient"]);
    assert.equal(calls[insert]!.values?.[3], "Ian Beale");
    assert.ok(calls.some((call) => call.sql.includes("INSERT INTO nzi_console.client_contact_versions")));
    assert.ok(calls.some((call) => call.sql.includes("INSERT INTO nzi_console.audit_events") && call.values?.[4] === "client_contact_created"));
  });

  it("refuses contact changes without contact.manage", async () => {
    for (const role of ["reviewer", "finance", "viewer"] as const) {
      await assert.rejects(() => createClientContact(contactPool([]), { clientId: "client-a", fullName: "X", isPrimary: false, roles: [] }, context(`contact-${role}`, role, `${role}-a`)), (error: unknown) => error instanceof AuthorizationError && error.permission === "contact.manage");
    }
  });

  it("validates roles, and requires an email for a portal candidate", () => {
    const grant = commandGrantForRole("admin", "org-a", "u");
    const base = { organisationId: "org-a", actorId: "u", principal: "staff" as const, idempotencyKey: "k", correlationId: "c", grant };
    assert.ok(validateCommand("client.contact.create", { clientId: "client-a", fullName: "X", isPrimary: false, roles: ["approver" as never] }, base).some((issue) => issue.field === "roles"));
    assert.ok(validateCommand("client.contact.create", { clientId: "client-a", fullName: "X", isPrimary: false, roles: ["portal_candidate"] }, base).some((issue) => issue.field === "email"));
    assert.deepEqual(validateCommand("client.contact.create", { clientId: "client-a", fullName: "X", email: "x@synthetic.invalid", isPrimary: false, roles: ["portal_candidate", "training_attendee"] }, base), []);
  });

  it("versions an edit and refuses a stale one", async () => {
    const calls: Call[] = [];
    const result = await updateClientContact(contactPool(calls), { contactId: "contact-a", expectedVersion: 2, fullName: "Dawn Fletcher", isPrimary: true, roles: ["report_signee", "portal_candidate"], email: "dawn@synthetic.invalid" }, context("contact-edit"));
    assert.equal(result.data.version, 3);
    assert.ok(calls.some((call) => call.sql.includes("INSERT INTO nzi_console.client_contact_versions")));
    await assert.rejects(() => updateClientContact(contactPool([]), { contactId: "contact-a", expectedVersion: 1, fullName: "Dawn", isPrimary: false, roles: [] }, context("contact-stale")), VersionConflictError);
  });

  it("deactivates, never deletes", async () => {
    const calls: Call[] = [];
    const result = await deactivateClientContact(contactPool(calls), { contactId: "contact-a", expectedVersion: 2 }, context("contact-remove"));
    assert.equal(result.data.status, "inactive");
    assert.ok(!calls.some((call) => /\bDELETE\b/i.test(call.sql)));
    await assert.rejects(() => deactivateClientContact(contactPool([], contactRow({ status: "inactive" })), { contactId: "contact-a", expectedVersion: 2 }, context("contact-again")), CommandValidationError);
  });
});

describe("the report signee comes only from report-signee contacts", () => {
  const releasePool = (calls: Call[], signee: Record<string, unknown> | null) => withAccess({ connect: async () => ({
    async query(sql: string, values?: readonly unknown[]) {
      calls.push({ sql, values });
      if (sql.includes("FROM nzi_console.reviewed_crp_snapshots WHERE")) return { rows: [{ job_id: "job-a", data_hash: `sha256:${"b".repeat(64)}`, created_at: "2026-09-01T00:00:00.000Z", created_by: "consultant-a", approved_by: "reviewer-a", payload_json: { jobNumber: "J000900", client: "Synthetic", reportingYear: 2024, measurements: [] } }] };
      if (sql.includes("FROM nzi_console.client_contacts k JOIN nzi_console.jobs j")) return { rows: signee ? [signee] : [] };
      return { rows: [] };
    }, release() {},
  }) } as never);

  it("refuses a contact that is not an active report signee of the job's client", async () => {
    await assert.rejects(() => validateCrpReport(releasePool([], null), { reviewedSnapshotId: "snapshot-a", manifestVersion: 1, signeeContactId: "contact-x" }, context("signee-bad", "reviewer", "reviewer-a")),
      (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === "SIGNEE_INVALID"));
  });

  it("checks the role in the query itself, so only signees can pass", async () => {
    const calls: Call[] = [];
    await validateCrpReport(releasePool(calls, { contact_id: "contact-a", full_name: "Dawn Fletcher", job_title: "Operations director" }), { reviewedSnapshotId: "snapshot-a", manifestVersion: 1, signeeContactId: "contact-a" }, context("signee-ok", "reviewer", "reviewer-a")).catch(() => undefined);
    const lookup = calls.find((call) => call.sql.includes("FROM nzi_console.client_contacts k JOIN nzi_console.jobs j"))!;
    assert.ok(lookup.sql.includes("'report_signee'=ANY(k.roles)") && lookup.sql.includes("k.status='active'"));
  });
});

describe("the client logo", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("synthetic")]).toString("base64");
  const svg = (body: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${body}</svg>`).toString("base64");

  it("accepts a PNG or a plain SVG, and refuses anything that could script or fetch", () => {
    assert.deepEqual(inspectClientLogo("image/png", png).issues, []);
    assert.deepEqual(inspectClientLogo("image/svg+xml", svg("<rect width=\"10\" height=\"10\" fill=\"#0BA75E\"/>")).issues, []);
    assert.ok(inspectClientLogo("image/png", svg("")).issues.length);
    for (const unsafe of ["<script>alert(1)</script>", "<rect onload=\"x()\"/>", "<image href=\"https://example.invalid/x.png\"/>", "<foreignObject/>"]) assert.ok(inspectClientLogo("image/svg+xml", svg(unsafe)).issues.length, unsafe);
  });

  it("stores the upload as an append-only asset and points the client at it (client.edit)", async () => {
    const calls: Call[] = [];
    const pool = withAccess({ connect: async () => ({ async query(sql: string, values?: readonly unknown[]) { calls.push({ sql, values }); return { rows: [] }; }, release() {} }) } as never);
    const result = await setClientLogo(pool, { clientId: "client-a", fileName: "logo.png", contentType: "image/png", dataBase64: png }, context("logo-set"));
    assert.equal(typeof result.data.assetId, "string");
    assert.ok(calls.some((call) => call.sql.includes("INSERT INTO nzi_console.client_logo_assets")));
    assert.ok(calls.some((call) => call.sql.includes("UPDATE nzi_console.clients SET logo_asset_id=$3")));
    const removed: Call[] = [];
    await removeClientLogo(withAccess({ connect: async () => ({ async query(sql: string, values?: readonly unknown[]) { removed.push({ sql, values }); return { rows: [] }; }, release() {} }) } as never), { clientId: "client-a" }, context("logo-remove"));
    assert.ok(!removed.some((call) => /DELETE/i.test(call.sql)), "removing a logo never deletes the asset");
    await assert.rejects(() => setClientLogo(pool, { clientId: "client-a", fileName: "logo.png", contentType: "image/png", dataBase64: png }, context("logo-finance", "finance", "finance-a")), (error: unknown) => error instanceof AuthorizationError && error.permission === "client.edit");
  });

  it("serves a logo that cannot act as a document, and 404s so the monogram shows", () => {
    const response = logoResponse({ assetId: "a", contentType: "image/svg+xml", sha256: "c".repeat(64), content: Buffer.from("<svg/>") }, null);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(response.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.equal(logoResponse(null, null).status, 404);
    assert.equal(logoResponse({ assetId: "a", contentType: "image/png", sha256: "c".repeat(64), content: Buffer.from("x") }, `"${"c".repeat(64)}"`).status, 304);
  });
});
