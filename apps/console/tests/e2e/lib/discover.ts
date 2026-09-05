import type { APIRequestContext } from "@playwright/test";

// The suite is self-configuring: it discovers which entities exist on the target
// rather than hard-coding IDs, so it survives staging data changing.

async function json(request: APIRequestContext, path: string): Promise<unknown> {
  const response = await request.get(path);
  if (!response.ok()) throw new Error(`${path} -> ${response.status()}`);
  return response.json();
}

export async function discoverCrpJob(request: APIRequestContext): Promise<{ id: string; number: string } | null> {
  const body = (await json(request, "/api/isolated/jobs")) as { jobs?: Array<{ header?: { id?: string; number?: string; family?: string } }> };
  const jobs = body.jobs ?? [];
  const crp = jobs.find((job) => job.header?.family === "crp") ?? jobs[0];
  return crp?.header?.id ? { id: crp.header.id, number: crp.header.number ?? crp.header.id } : null;
}

export async function discoverCrpJobAtStage(
  request: APIRequestContext,
  workflowStage: string,
): Promise<{ id: string; number: string } | null> {
  const body = (await json(request, "/api/isolated/jobs")) as {
    jobs?: Array<{ header?: { id?: string; number?: string; family?: string; workflowStage?: string } }>;
  };
  const candidates = (body.jobs ?? []).filter(
    (job) => job.header?.family === "crp" && job.header?.workflowStage === workflowStage,
  );
  // Prefer the seeded demonstrator J000712 (the populated CRP job every spec
  // targets); fall back to the first match.
  const match = candidates.find((job) => job.header?.number === "J000712") ?? candidates[0];
  return match?.header?.id ? { id: match.header.id, number: match.header.number ?? match.header.id } : null;
}

/** Track C — an LCA or PCF job (they share one model, NZC-052); prefers the seeded J000714 (lca). */
export async function discoverLcaJob(request: APIRequestContext): Promise<{ id: string; number: string; family: string } | null> {
  const body = (await json(request, "/api/isolated/jobs")) as { jobs?: Array<{ header?: { id?: string; number?: string; family?: string } }> };
  const candidates = (body.jobs ?? []).filter((job) => job.header?.family === "lca" || job.header?.family === "pcf");
  const match = candidates.find((job) => job.header?.number === "J000714") ?? candidates[0];
  return match?.header?.id ? { id: match.header.id, number: match.header.number ?? match.header.id, family: match.header.family! } : null;
}

export async function discoverClient(request: APIRequestContext): Promise<{ id: string } | null> {
  const body = (await json(request, "/api/isolated/clients")) as { clients?: Array<{ id?: string }> };
  const client = (body.clients ?? [])[0];
  return client?.id ? { id: client.id } : null;
}

export async function discoverReportVersion(request: APIRequestContext): Promise<{ id: string } | null> {
  try {
    const body = (await json(request, "/api/isolated/report-versions")) as { reports?: Array<{ id?: string; reportVersionId?: string }> };
    const report = (body.reports ?? [])[0];
    const id = report?.id ?? report?.reportVersionId;
    return id ? { id } : null;
  } catch {
    return null;
  }
}

export async function discoverPortalJob(request: APIRequestContext): Promise<{ id: string } | null> {
  try {
    const body = (await json(request, "/api/portal/jobs")) as { jobs?: Array<{ id?: string; jobId?: string; header?: { id?: string } }> };
    const job = (body.jobs ?? [])[0];
    const id = job?.id ?? job?.jobId ?? job?.header?.id;
    return id ? { id } : null;
  } catch {
    return null;
  }
}
