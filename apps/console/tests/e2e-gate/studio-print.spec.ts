import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { buildStudioPrintCss, studioPrintMark } from "../../app/jobs/[jobId]/report/studioPrint";

/**
 * The Report Studio's draft prints as paper, in a browser (fast-follow to #487/#488).
 *
 * A composed@6 draft's Print / Save as PDF put a large empty grey block on every page, the cover included, and cut the first
 * letter off every left-aligned line. Neither shows in a unit test — both are what the browser's layout makes of the rules
 * together:
 *   - the grey was the console's own ground (`html,body`, @nzi/ui), printed because the studio forces backgrounds to print;
 *   - the clip was a *screen* query (`max-width:900px`) matching the ~680px printed page and giving the studio frame a negative
 *     margin, so the document sat 8px past the page's left edge.
 *
 * So this lays the real document out under print media at A4's content width: the composed@6 golden pin's markup (the exact
 * markup the renderer is pinned to), inside the studio's own container chain, with the stylesheets the studio page loads and the
 * print rules it injects. No server and no data: what is under test is the CSS, and only a layout engine can answer it.
 */

const APP = join(__dirname, "..", "..");
const css = (path: string) => readFileSync(join(APP, path), "utf8");
const STYLES = [
  "../../packages/ui/src/styles.css",
  "app/reports/[versionId]/report-composed.css",
  "app/reports/[versionId]/report-composed5.css",
  "app/jobs/[jobId]/report/report-studio.css",
].map(css).join("\n");

/** 210mm − 2 × 15mm, the content width `@page` gives a printed page, in CSS pixels. */
const A4_CONTENT_WIDTH = 680;

// The studio's flow source draws the document in flow mode; the pin was rendered in page mode.
const DOCUMENT = css("tests/fixtures/composition-composed6-whole.html").replace("nzr5 r5-mode-page", "nzr5 r5-mode-flow");

/** The chain the studio page actually renders (measured in the browser), with the chrome print must strip beside it. */
const page = (printCss: string) => `<!doctype html><html><head><style>${STYLES}</style><style>${printCss}</style></head><body>
<div class="nz-app no-drawer"><nav class="nz-rail">rail</nav><main class="nz-main"><header class="nz-topbar">top bar</header>
<div class="nz-preview-canvas"><div class="nzs-studio"><nav class="nzs-subnav">Sections · Printing</nav>
<div class="nzs-toolbar">toolbar</div><div class="nzs-body"><aside class="nzs-rail">rail</aside>
<div class="nzs-stage mode-flow"><div data-report-draft>Draft band</div><div class="nzs-paged-source">${DOCUMENT}</div></div>
</div></div></div></main></div></body></html>`;

test("a draft prints as paper: no grey ground, nothing past the page edge, no studio chrome", async ({ page: browser }) => {
  // The mirror is only as good as its match to the studio: the classes it copies must still be the ones ReportStudio renders.
  const studio = css("app/jobs/[jobId]/report/ReportStudio.tsx");
  for (const name of ["nzs-studio", "nzs-body", "nzs-stage", "nzs-paged-source", "data-report-draft"]) {
    expect(studio, `ReportStudio still renders ${name}`).toContain(name);
  }

  await browser.setViewportSize({ width: A4_CONTENT_WIDTH, height: 1000 });
  await browser.emulateMedia({ media: "print" });
  await browser.setContent(page(buildStudioPrintCss({ client: "Bushy Tails Ltd", title: "Carbon Reduction Plan 2025–2026", mark: studioPrintMark("draft") })));

  const measured = await browser.evaluate(() => {
    const paper = (colour: string) => colour === "rgb(255, 255, 255)" || colour === "rgba(0, 0, 0, 0)";
    const main = document.querySelector("main.nzr5")!.getBoundingClientRect();
    const grey: string[] = [];
    for (const el of document.querySelectorAll("body, body *")) {
      const style = getComputedStyle(el);
      if (style.display === "none" || paper(style.backgroundColor)) continue;
      const box = el.getBoundingClientRect();
      // A page-filling coloured block: taller than half a printed page's content box.
      if (box.height > 500 && box.width > 300) grey.push(`${el.tagName.toLowerCase()}.${el.className} ${style.backgroundColor} ${Math.round(box.height)}px`);
    }
    const shown = (selector: string) => [...document.querySelectorAll(selector)].filter((el) => getComputedStyle(el).display !== "none").length;
    return {
      ground: [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).backgroundColor],
      paper: [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).backgroundColor].every(paper),
      documentLeft: Math.round(main.left), documentRight: Math.round(main.right), scrollWidth: document.documentElement.scrollWidth,
      grey,
      chrome: shown(".nz-rail, .nz-topbar, .nzs-subnav, .nzs-toolbar, .nzs-rail, [data-report-draft], .r5-spill, .r5-runhead, .r5-runfoot, .nzs-narr-tools"),
      sections: document.querySelectorAll("main.nzr5 .r5-page").length,
    };
  });

  expect(measured.sections, "the whole composed@6 document is laid out").toBeGreaterThan(10);
  expect(measured.paper, `the printed page is paper, not the console's ground (${measured.ground.join(" / ")})`).toBe(true);
  expect(measured.grey, "no page-filling coloured block").toEqual([]);
  expect(measured.documentLeft, "the document starts at the page's left edge, not past it").toBeGreaterThanOrEqual(0);
  expect(measured.documentRight, "and ends inside its right edge").toBeLessThanOrEqual(A4_CONTENT_WIDTH);
  expect(measured.scrollWidth, "nothing overflows the printed width").toBeLessThanOrEqual(A4_CONTENT_WIDTH);
  expect(measured.chrome, "no console or studio chrome, no provenance pill, no simulated running head or foot").toBe(0);
});
