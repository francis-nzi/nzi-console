import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * One label per field, and it belongs to the field row.
 *
 * On the Add-client Identity step four fields showed their label twice — Client owner, Client
 * manager, Industry, Referral — and those four are exactly the smart-search fields. `Field` renders
 * a `<label htmlFor>`, and `SmartSearch` rendered one of its own beneath it.
 *
 * The visible duplicate was the smaller half. `Lookup` passed `control={() => …}`, discarding the
 * a11y props the field row hands its control, so `SmartSearch` fell back to generating its own id —
 * which meant the row's `<label htmlFor="client-owner">` pointed at **no element**. A screen reader
 * got the name from the component's own label; clicking the row's label focused nothing. Removing
 * the second label without wiring the id through would have left a field with no working label at
 * all, which is why the fix is the pair.
 *
 * Asserted on the source because the acceptance criterion is an absence, and because the failure
 * mode is a component quietly reacquiring a label — a fifth duplicate the day someone adds another
 * typeahead. `id` being a required prop is the structural half of that guard; this is the rest.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
/**
 * Code with the comments taken out.
 *
 * The docblock explaining why this component renders no `<label>` contains the word `<label`, and a
 * scan that cannot tell prose from markup reports the explanation as the offence. Narrower than
 * removing the assertion: the rule is about what renders, so read only what renders.
 */
const code = (path: string) => read(path)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");

describe("the smart-search does not bring its own label", () => {
  it("renders no <label> element at all", () => {
    const source = code("packages/ui/src/SmartSearch.tsx");
    assert.ok(!/<label[\s>]/.test(source), "the caller's field row owns the visible label");
  });

  it("still names the results listbox, which needs a name of its own", () => {
    // Dropping the <label> must not drop the popup's accessible name with it: the listbox is a
    // separate widget and the field's visible label does not name it.
    assert.match(read("packages/ui/src/SmartSearch.tsx"), /role="listbox"[^>]*aria-label=\{label\}/);
  });

  it("requires an id, so it cannot be rendered with nothing pointing at it", () => {
    // The structural guard. A caller with an id to pass has a label to point at it; a caller with
    // neither cannot compile.
    const source = read("packages/ui/src/SmartSearch.tsx");
    assert.match(source, /\/\*\* Required: the caller's `<label htmlFor>` must be able to reach this input\. \*\/\s*\n\s*id: string;/);
    assert.ok(!source.includes("id?: string;"), "id is not optional");
  });
});

describe("every Identity-step field has exactly one label, from the field row", () => {
  const form = () => read("apps/console/app/clients/clientForm.tsx");

  it("wires the row's id and description into the smart-search", () => {
    // Without this the row's label points at an element that does not exist.
    const code = form();
    assert.ok(code.includes("id={a11y.id}"), "the control uses the row's id");
    assert.ok(code.includes(`describedBy={a11y["aria-describedby"]}`), "and the row's description");
    assert.ok(!code.includes("control={() => ("), "no control may discard the row's a11y props");
  });

  it("renders one <label> per field row and none inside a control", () => {
    // `Field` is the only thing on this form that may render a field label. The checkbox-card
    // labels are their own control's, not a field row's, and are excluded by class.
    const fieldLabels = code("apps/console/app/clients/clientForm.tsx")
      .split("\n").filter((line) => line.includes("<label htmlFor={id}>"));
    assert.equal(fieldLabels.length, 1, "exactly one place renders a field label");
    assert.ok(fieldLabels[0]!.includes("className=\"req\""), "and it carries the required asterisk");
  });

  it("keeps the red asterisk on the two required lookups and off the other two", () => {
    const code = form();
    for (const [field, required] of [["owner", true], ["clientManager", false],
      ["sector", true], ["referral", false]] as const) {
      const line = code.split("\n").find((entry) => entry.includes(`name="${field}"`))!;
      assert.equal(/\brequired\b/.test(line), required, `${field} required=${required}`);
    }
    // The asterisk is the field row's, styled red by `.nz-fl .req`.
    assert.match(read("packages/ui/src/styles.css"), /\.nz-fl \.req\{color:var\(--danger\)/);
  });
});

describe("the jobs create form labels its smart-search the same way", () => {
  it("renders its own label pointing at the control's id", () => {
    // The one call site outside the client form. Removing the component's label would otherwise
    // have left this field with no label at all.
    const code = read("apps/console/app/jobs/JobsIndex.tsx");
    assert.ok(code.includes(`<label htmlFor="job-client-manager">Client manager</label>`));
    assert.ok(code.includes(`<SmartSearch id="job-client-manager"`), "and the ids match");
  });

  it("puts it in the same field-row wrapper as the controls beside it", () => {
    assert.match(read("apps/console/app/jobs/JobsIndex.tsx"),
      /<div className="nz-fl" style=\{\{ margin: 0 \}\}>\s*\n\s*(\{\/\*[\s\S]*?\*\/\}\s*\n\s*)?<label htmlFor="job-client-manager">/);
  });
});
