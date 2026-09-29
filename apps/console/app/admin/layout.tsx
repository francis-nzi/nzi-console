import type { ReactNode } from "react";
import { withTenantRead } from "@nzi/isolated-backend";
import { environmentBadge, serviceEnvironment } from "../lib/environment";
import { isolatedPool } from "../lib/isolatedDatabase";
import { adminAccess } from "./adminAccess";
import { AdminShell } from "./AdminShell";
import { adminMono, adminSans } from "./fonts";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin · NZ Insights Pro" };

const STATE_TITLE = { forbidden: "Administration is not part of your role", "signed-out": "Sign in to continue", unavailable: "Administration is unavailable here" } as const;

/**
 * Every admin page renders inside the admin shell (NZC-167). Access is decided on the server for each request
 * (adminAccess), and shown here as a stated reason when it is not allowed.
 *
 * **This layout is not the boundary on its own.** The App Router renders a page's server component in parallel with
 * its layout, whether or not the layout places `children` — so every admin page checks `adminAccess()` itself before
 * it reads anything (the check is cached per request, so it runs once).
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const access = await adminAccess();
  const fonts = `${adminSans.variable} ${adminMono.variable}`;
  const environment = environmentBadge(serviceEnvironment());

  if (access.state !== "allowed") {
    return <AdminShell fontClassName={fonts} environment={environment} user={null}>
      <section className="nz-a-state" role="status" aria-live="polite">
        <div className="nz-a-eyebrow">Administration</div>
        <h1>{STATE_TITLE[access.state]}</h1>
        <p>{access.reason}</p>
        {access.state === "signed-out" ? <p><a className="nz-a-btn pri" href="/login?next=/admin">Sign in</a></p> : <p><a href="/">Back to the console</a></p>}
      </section>
    </AdminShell>;
  }

  const name = await withTenantRead(isolatedPool(), access.organisationId, async (db) =>
    (await db.query<{ display_name: string | null }>(`SELECT display_name FROM nzi_console.memberships WHERE user_id = $1`, [access.userId])).rows[0]?.display_name ?? null)
    .catch(() => null);
  return <AdminShell fontClassName={fonts} environment={environment} user={{ name: name ?? access.userId, role: access.role }}>{children}</AdminShell>;
}
