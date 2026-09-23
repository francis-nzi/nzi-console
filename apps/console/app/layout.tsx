import type { Metadata } from "next";
import localFont from "next/font/local";
import "@nzi/ui/styles.css";
import { HelpProvider } from "./help/HelpProvider";

/**
 * Inter, self-hosted (NZC-150).
 *
 * This was `Inter` from `next/font/google`, which fetches the font from Google **at build time**. That
 * put an external HTTP request on the critical path of every build, and on 23 Sep 2026 it failed: the
 * capture-surface gate went red because the loader could not retrieve Inter, twenty-five seconds into a
 * compile that normally takes fifty-five. The same commit built green on the next run with nothing
 * changed. A build that depends on somebody else's CDN is a build that fails for reasons that have
 * nothing to do with the change under review, and the cost is paid in trust: a gate that goes red
 * without a cause gets re-run rather than read.
 *
 * Self-hosting removes the fetch rather than retrying it, which also makes the question of *why* the
 * fetch failed — network, rate limit, memory pressure during it — one nobody has to answer.
 *
 * **The file is the one Google was serving**: the `latin` subset of Inter v20, the variable face, taken
 * from the stylesheet `next/font/google` itself resolves. So this is the same typeface at the same
 * weights, not a substitution that happens to look close.
 */
const inter = localFont({
  src: "./fonts/inter-latin-variable.woff2",
  // A variable face covering the four weights the design uses (400/500/600/700), which is why this is
  // one file rather than four. Declaring the range is what lets `font-weight: 600` still mean 600.
  weight: "400 700",
  style: "normal",
  variable: "--font-inter",
  display: "swap",
  // Named so the CSS fallback `var(--font-inter, Inter)` keeps working, and so a browser that already
  // has Inter locally is not made to download it again.
  fallback: ["Inter", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
});

export const metadata: Metadata = {
  title: "NZI Console",
  description: "Redesigned NZI Pro front-end (staging).",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        {/* Mounted once, so the ? that TopBar renders has something to open on every page —
            rather than seventeen pages each remembering to wire it up. */}
        <HelpProvider writeEnabled={process.env.NZI_DATA_MODE === "isolated-api"}>{children}</HelpProvider>
      </body>
    </html>
  );
}
