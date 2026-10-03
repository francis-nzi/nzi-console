"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { postBrowserCommand } from "@nzi/api-client";
import type { ClientScreenReadModel } from "@nzi/isolated-backend";
import type { EditAccess } from "../../lib/useEditAccess";

/**
 * CLIENT-04 — whether the client is located from its registered postcode and country, said quietly: yes; or not, and
 * why — geocoding switched off, no postcode, or the lookup came back empty (with a retry). Never an error.
 */
export function ClientLocation({ client, geocodingEnabled, access }: { client: ClientScreenReadModel; geocodingEnabled: boolean; access: EditAccess }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "working" | "missed">("idle");
  if (client.located) return <>Yes — from the registered postcode</>;
  if (!geocodingEnabled) return <span className="muted">No — geocoding is not enabled</span>;
  if (!client.profile.registeredPostcode || !client.profile.registeredCountry) return <span className="muted">No — add the registered postcode and country</span>;
  async function retry() {
    setState("working");
    const result = await postBrowserCommand<{ location?: string }>(`/api/isolated/clients/${encodeURIComponent(client.id)}/locate`, {}, crypto.randomUUID());
    if (result.state === "success" && (result.data.location === "located" || result.data.location === "already")) { router.refresh(); return; }
    setState("missed");
  }
  return <span className="muted">{state === "missed" ? "Still couldn’t locate it from its postcode" : "Couldn’t locate it from its postcode"}
    {access.state === "allowed" ? <> · <button type="button" className="nz-editlink" disabled={state === "working"} onClick={() => void retry()}>{state === "working" ? "Locating…" : "Retry"}</button></> : null}</span>;
}
