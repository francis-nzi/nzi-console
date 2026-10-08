import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandReason, CommandReasonEncodingError, commandReasonHeaders, patchBrowserCommandWithReason, postBrowserCommand, postBrowserCommandWithReason, putBrowserCommandWithReason, type BrowserCommandTransport } from "../src/index";

describe("authenticated browser commands", () => {
  it("sends only command data and request identity, never tenant or actor identity", async () => {
    let captured: RequestInit | undefined;
    const transport: BrowserCommandTransport = async (_path, init) => {
      captured = init;
      return Response.json({ data: { clientId: "client-a" } }, { status: 201 });
    };
    const result = await postBrowserCommand<{ clientId: string }>("/commands/clients", { name: "Example" }, "idem-a", transport);
    assert.equal(result.state, "success");
    assert.equal((captured?.headers as Record<string, string>)["idempotency-key"], "idem-a");
    assert.deepEqual(JSON.parse(String(captured?.body)), { name: "Example" });
    assert.doesNotMatch(JSON.stringify(captured), /organisationId|actorId|role|permission/);
  });

  it("preserves validation failures as a distinct outcome", async () => {
    const transport: BrowserCommandTransport = async () => Response.json({ message: "Command validation failed.", issues: [{ field: "dueDate", message: "Due date must not precede start date." }] }, { status: 422 });
    const result = await postBrowserCommand("/commands/jobs", {}, "idem-b", transport);
    assert.equal(result.state, "validation_failed");
    if (result.state === "validation_failed") assert.equal(result.issues[0]?.field, "dueDate");
  });

  it("preserves optimistic version conflicts as a distinct outcome", async () => {
    const result = await postBrowserCommand("/commands/jobs/stage", {}, "idem-conflict", async () => Response.json({ message: "Refresh first." }, { status: 409 }));
    assert.deepEqual(result, { state: "conflict", message: "Refresh first." });
  });

  it("marks server and network failures retryable without inventing success", async () => {
    const server = await postBrowserCommand("/commands/jobs", {}, "idem-c", async () => Response.json({ message: "Unavailable" }, { status: 503 }));
    assert.deepEqual(server, { state: "failed", message: "Unavailable", retryable: true });
    const network = await postBrowserCommand("/commands/jobs", {}, "idem-d", async () => { throw new Error("offline"); });
    assert.deepEqual(network, { state: "failed", message: "offline", retryable: true });
  });
});

it("keeps justification in dedicated request metadata for reason-aware commands", async () => {
  let headers: Headers | null = null;
  await postBrowserCommandWithReason("/commands/datasets", { datasetId: "demo" }, "idem-reason", "  Required exception  ", async (_path, init) => { headers = new Headers(init?.headers); return Response.json({ data: { ok: true } }, { status: 201 }); });
  // Encoded and marked (RULING-command-reason-encoding); the server's one reader gives back the trimmed reason as before.
  assert.equal(headers!.get("x-command-reason"), "Required%20exception");
  assert.equal(headers!.get("x-command-reason-encoding"), "uri");
  assert.equal(commandReason(headers!), "Required exception");
});

it("sends a reason outside ISO-8859-1 — a curly quote, an em dash, €, an emoji — without throwing, and it reads back exactly", async () => {
  const reason = "Client’s site closed — “moved” to Zürich €; ok ✅";
  // The failure being fixed: a header value outside ISO-8859-1 cannot be built at all (fetch throws before sending).
  assert.throws(() => new Headers({ "x-command-reason": reason }));
  let headers: Headers | null = null;
  const result = await postBrowserCommandWithReason("/commands/sites", {}, "idem-unicode", reason, async (_path, init) => { headers = new Headers(init?.headers); return Response.json({ data: { ok: true } }, { status: 201 }); });
  assert.equal(result.state, "success", "the command was sent");
  assert.equal(commandReason(headers!), reason, "byte for byte");
  for (const send of [patchBrowserCommandWithReason, putBrowserCommandWithReason]) {
    let sent: Headers | null = null;
    await send("/x", {}, "idem", reason, async (_path, init) => { sent = new Headers(init?.headers); return Response.json({ data: { ok: true } }, { status: 201 }); });
    assert.equal(commandReason(sent!), reason);
  }
});

it("reads a reason: decoded when marked, raw when not (an old caller still works), trimmed, and none when empty; a malformed encoded one is refused", () => {
  const read = (values: Record<string, string>) => commandReason(new Headers(values));
  assert.equal(read({ "x-command-reason": "caf%C3%A9%20%E2%80%94%20ok", "x-command-reason-encoding": "uri" }), "café — ok");
  assert.equal(read({ "x-command-reason": "50%20reduction", "x-command-reason-encoding": " URI " }), "50 reduction", "the marker is case- and space-tolerant");
  assert.equal(read({ "x-command-reason": "  plain old reason  " }), "plain old reason", "no marker: read raw, as before");
  assert.equal(read({ "x-command-reason": "50% off" }), "50% off", "no marker: a literal % is not decoded");
  assert.equal(read({}), undefined);
  assert.equal(read({ "x-command-reason": "%20%20", "x-command-reason-encoding": "uri" }), undefined, "only spaces is no reason");
  assert.throws(() => read({ "x-command-reason": "bad%E2%80", "x-command-reason-encoding": "uri" }), CommandReasonEncodingError);
  assert.deepEqual(commandReasonHeaders("   "), {}, "an empty reason sends no headers");
});
