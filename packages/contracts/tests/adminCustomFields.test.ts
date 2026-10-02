import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { customFieldOptionIssues, customFieldValueIssue, V7_CUSTOM_FIELD_TYPE_MAP, type CustomFieldOption } from "../src/adminCustomFields";

/** Custom field definitions (admin F3): the value rule a default here and a value downstream are both held to. */
const options: CustomFieldOption[] = [{ value: "online", label: "Online", active: true }, { value: "post", label: "By post", active: false }];

describe("a value is valid for its type", () => {
  it("accepts each type's canonical form and refuses others", () => {
    const cases: Array<[Parameters<typeof customFieldValueIssue>[0], string, boolean]> = [
      ["text", "One line", true], ["text", "two\nlines", false],
      ["long_text", "two\nlines", true],
      ["number", "42", true], ["number", "-7", true], ["number", "4.2", false], ["number", "1e3", false],
      ["decimal", "4.25", true], ["decimal", "4,25", false],
      ["date", "2026-02-28", true], ["date", "2026-02-30", false], ["date", "31/12/2026", false],
      ["checkbox", "true", true], ["checkbox", "yes", false],
      ["select", "online", true], ["select", "post", false], ["select", "Online", false],
    ];
    for (const [type, value, ok] of cases) assert.equal(customFieldValueIssue(type, value, options) === null, ok, `${type} ${JSON.stringify(value)}`);
  });
});

describe("options suit the type", () => {
  it("a select needs an active option and distinct, valid values; any other type has none", () => {
    assert.deepEqual(customFieldOptionIssues("select", options), []);
    assert.deepEqual(customFieldOptionIssues("select", [{ value: "post", label: "Post", active: false }]), ["A choice-from-a-list field needs at least one active option."]);
    assert.deepEqual(customFieldOptionIssues("select", [...options, { value: "ONLINE", label: "Again", active: true }]), ["Option value \"ONLINE\" appears twice."]);
    assert.deepEqual(customFieldOptionIssues("text", options), ["Only a choice-from-a-list field has options."]);
    assert.deepEqual(customFieldOptionIssues("text", null), []);
  });

  it("maps every v7 field type, its radio buttons to a select", () => {
    assert.deepEqual(Object.keys(V7_CUSTOM_FIELD_TYPE_MAP).sort(), ["checkbox", "date", "decimal", "dropdown", "multiline_text", "number", "option", "text"]);
    assert.equal(V7_CUSTOM_FIELD_TYPE_MAP.option, "select");
  });
});
