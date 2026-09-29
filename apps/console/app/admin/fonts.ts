import localFont from "next/font/local";

/**
 * The admin section's typefaces (NZC-167): Hanken Grotesk for UI and headings, IBM Plex Mono for codes, rates, IDs,
 * counts and eyebrow labels. Self-hosted like Inter (NZC-150) — the latin subsets from Fontsource, SIL OFL (licences
 * beside the files) — so no build ever fetches a font. Applied only under `.nz-admin`; the rest of the console keeps
 * Inter (NZC-003).
 */
export const adminSans = localFont({
  src: "../fonts/hanken-grotesk-latin-variable.woff2",
  weight: "400 700",
  style: "normal",
  variable: "--font-admin-sans",
  display: "swap",
  fallback: ["Hanken Grotesk", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
});

export const adminMono = localFont({
  src: [
    { path: "../fonts/ibm-plex-mono-latin-400.woff2", weight: "400", style: "normal" },
    { path: "../fonts/ibm-plex-mono-latin-500.woff2", weight: "500", style: "normal" },
    { path: "../fonts/ibm-plex-mono-latin-600.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-admin-mono",
  display: "swap",
  fallback: ["IBM Plex Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
});
