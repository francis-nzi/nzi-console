import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "@nzi/ui/styles.css";
import { HelpProvider } from "./help/HelpProvider";

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-inter",
  display: "swap",
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
