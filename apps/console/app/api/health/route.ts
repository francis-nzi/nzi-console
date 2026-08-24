export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    status: "ok",
    app: "nzi-console",
    env: process.env.NEXT_PUBLIC_APP_ENV ?? "local",
    time: new Date().toISOString(),
  });
}
