import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { postBrowserCommand, postBrowserCommandWithReason, type BrowserCommandTransport } from "../src/index";

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
  let reason: string | null = null;
  await postBrowserCommandWithReason("/commands/datasets", { datasetId: "demo" }, "idem-reason", "  Required exception  ", async (_path, init) => { reason = new Headers(init?.headers).get("x-command-reason"); return Response.json({ data: { ok: true } }, { status: 201 }); });
  assert.equal(reason, "Required exception");
});
