import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { helpContextForPath } from "../app/help/helpContext";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

/**
 * The help drawer (0b). The rules worth holding: the affordance is genuinely on every page,
 * the panel follows the side-panel anatomy, Review is capability-gated, and the Ask tab
 * abstains honestly rather than pretending to answer.
 */

describe("the affordance is on every page, not on the pages that remembered", () => {
  it("is rendered by TopBar itself", () => {
    // Seventeen pages compose a TopBar. Passing the button per page would guarantee that one
    // eventually does not have it, which is the one thing "every page" cannot tolerate.
    const topBar = read("packages/ui/src/index.tsx");
    assert.match(topBar, /export function TopBar[\s\S]*?<HelpAffordance \/>/);
  });

  it("is mounted once for the whole app", () => {
    assert.match(read("apps/console/app/layout.tsx"), /<HelpProvider/);
  });

  it("renders nothing when no provider is mounted, rather than throwing", () => {
    // A surface outside the app shell must not be broken by help's absence.
    assert.match(read("packages/ui/src/HelpAffordance.tsx"), /if \(help === null\) return null;/);
  });

  it("keeps the design system free of the help system's content", () => {
    // Code, not comments: the comment necessarily names the features in order to say why
    // they are not hard-coded here.
    const code = read("packages/ui/src/HelpAffordance.tsx")
      .replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const leak of ["knowledge", "tour", "library", "Ask"]) {
      assert.ok(!code.toLowerCase().includes(leak.toLowerCase()), `@nzi/ui must not name ${leak}`);
    }
    // The label the app supplies is where those words legitimately live.
    assert.match(read("apps/console/app/help/HelpProvider.tsx"), /label: "Help — guided tours/);
  });
});

describe("page awareness", () => {
  it("names the workspace you are in", () => {
    assert.equal(helpContextForPath("/").label, "Control Room");
    assert.equal(helpContextForPath("/charts").label, "Emissions");
    assert.equal(helpContextForPath("/knowledge").label, "Knowledge library");
  });

  it("names the record in view where the route names one", () => {
    const client = helpContextForPath("/clients/bushy-tails");
    assert.equal(client.entityKind, "client");
    assert.equal(client.entityId, "bushy-tails");
    assert.equal(client.label, "Client workspace · bushy-tails");
  });

  it("does not mistake a sub-route for a record", () => {
    // /clients/new is a wizard, not a client.
    assert.equal(helpContextForPath("/clients/new").entityId, null);
    assert.equal(helpContextForPath("/clients/new").label, "Clients · new client");
  });

  it("falls back to the product rather than inventing a page", () => {
    assert.equal(helpContextForPath("/something-unmapped").label, "NZI Console");
  });
});

describe("the drawer follows the side-panel anatomy", () => {
  const drawer = read("apps/console/app/help/HelpDrawer.tsx");
  const css = read("packages/ui/src/styles.css");

  it("is header, scrollable body, pinned footer", () => {
    assert.match(drawer, /className="nz-dh"/);
    assert.match(drawer, /className="nz-db"/);
    assert.match(drawer, /className="nz-df"/);
    assert.match(css, /\.nz-drawer\.nz-help \.nz-db\{flex:1;overflow-y:auto\}/, "only the body scrolls");
  });

  it("is an inline panel, not a modal that blocks the page behind it", () => {
    assert.match(drawer, /role="dialog" aria-modal="false"/);
  });

  it("manages focus and closes on Escape", () => {
    assert.match(drawer, /panel\.current\?\.focus\(\)/);
    assert.match(drawer, /returnFocusTo\?\.focus\(\)/, "focus goes back to the affordance");
    assert.match(drawer, /event\.key === "Escape"/);
  });

  it("is a real tablist with arrow-key navigation", () => {
    assert.match(drawer, /role="tablist"/);
    assert.match(drawer, /role="tab"/);
    assert.match(drawer, /role="tabpanel"/);
    assert.match(drawer, /ArrowRight/);
    assert.match(drawer, /tabIndex=\{tab === entry\.id \? 0 : -1\}/, "one tab stop, arrows within");
  });

  it("respects reduced motion", () => {
    assert.match(css, /prefers-reduced-motion: reduce\)\{\.nz-drawer\.nz-help\{animation:none\}\}/);
  });

  it("is theme-aware — tokens, not fixed colours", () => {
    const block = /\.nz-help-btn\{[\s\S]*?\.nz-help-empty span\{[^}]*\}/.exec(css)?.[0] ?? "";
    assert.ok(block.length > 0, "the help styles exist");
    assert.doesNotMatch(block.replace(/rgba\([^)]*\)/g, ""), /#[0-9A-Fa-f]{6}/, "no hard-coded colour");
  });
});

describe("the four tabs", () => {
  const drawer = read("apps/console/app/help/HelpDrawer.tsx");

  it("shows Review only to capability-holders", () => {
    assert.match(drawer, /const showReview = capabilities\.approve \|\| capabilities\.publish/);
    assert.match(drawer, /entry\.id !== "review" \|\| showReview/, "the tab is hidden, not just its body");
  });

  it("abstains honestly rather than pretending to answer", () => {
    // The reason this surface is trustworthy at all: no answer beats an uncited one.
    assert.match(drawer, /No grounded answer/);
    assert.match(drawer, /only from sources it can cite/);
  });

  it("offers to capture the question, which is the flywheel", () => {
    assert.match(drawer, /Capture this for the team/);
  });

  it("says the Guide is not wired yet rather than looking broken", () => {
    assert.match(drawer, /No tour for this page yet/);
  });

  it("generates no answer — that is Phase 1", () => {
    // If this ever calls a model, the abstention above becomes a lie.
    assert.doesNotMatch(drawer, /\/api\/(help|ask|assistant)/);
    assert.doesNotMatch(drawer, /completion/i);
  });

  it("shows the user what the assistant will be told", () => {
    assert.match(drawer, /nz-help-context/);
    assert.match(drawer, /It will be told you are on/);
  });
});

describe("one library implementation, two hosts", () => {
  it("the drawer renders the page's own components", () => {
    assert.match(read("apps/console/app/help/HelpDrawer.tsx"),
      /import \{ KnowledgeLibrary, KnowledgeReview \} from "\.\.\/knowledge\/KnowledgeViews"/);
    const views = read("apps/console/app/knowledge/KnowledgeViews.tsx");
    assert.match(views, /export function KnowledgeLibrary/);
    assert.match(views, /export function KnowledgeReview/);
  });

  it("has no second copy of the library in the help folder", () => {
    // The failure this guards: the drawer growing its own library over time until the two
    // surfaces quietly disagree about what the library says.
    for (const file of readdirSync(new URL("../app/help/", import.meta.url))) {
      assert.ok(!read(`apps/console/app/help/${file}`).includes("/api/isolated/knowledge"),
        `${file} must not fetch the library itself`);
    }
  });
});
