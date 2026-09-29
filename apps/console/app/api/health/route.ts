import { serviceEnvironment } from "../../lib/environment";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    status: "ok",
    app: "nzi-console",
    ...serviceEnvironment(),
    time: new Date().toISOString(),
  });
}
