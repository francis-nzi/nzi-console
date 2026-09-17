"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * The one smart-search (NZC-089).
 *
 * The app had two typeaheads and no primitive: `TemplateSearchBar`, a full combobox welded to the
 * job factor library and to the command that creates a row from a pick, and a bare `<datalist>` in
 * the data-entry form. Neither could be reused, so a third field meant a third implementation — and
 * three typeaheads is three sets of keyboard behaviour for a person to learn.
 *
 * This is the extraction. It knows nothing about what it is searching: it takes options, returns
 * the id of the one chosen, and leaves fetching to the caller.
 *
 * ## Why not a `<datalist>`
 *
 * A datalist is a suggestion list over a text input, and three things follow from that. It cannot
 * return an **id** — only the text a person typed, so "Maya Osei" would be stored rather than
 * `m.osei`, which is the whole point of moving owner and manager off free text. It cannot show a
 * **second line** (a SIC code beside an industry, a role beside a colleague). And its behaviour is
 * the browser's, so it differs between them and cannot be tested. A real combobox is more code and
 * the only one of the two that can do the job.
 *
 * ## Accessibility
 *
 * `combobox` + `listbox` with `aria-activedescendant`, so the input keeps focus and a screen reader
 * announces the highlighted option rather than a focus move. Up/Down move, Enter selects, Escape
 * closes without selecting, and a click outside closes. The chosen value is echoed under the field
 * so the state is readable, not just inferred from the input's text.
 *
 * ## It does not render its own `<label>`
 *
 * It used to, and on a form whose field rows render one as well that produced two — visibly, on all
 * four smart-search fields of the Add-client Identity step and on none of the others. The second
 * label was the tell for something quieter: the wrapper's `<label htmlFor="client-owner">` pointed
 * at an id this component never used, because it generated its own. So the visible duplicate was a
 * cosmetic symptom of a label that was not attached to anything.
 *
 * The caller owns the label, because the caller owns the layout it has to sit in. `id` is therefore
 * **required**: a caller that has an id to pass has a label to point at it, and one that does not
 * cannot render this at all. `label` remains, as the accessible name of the results listbox — the
 * popup needs its own name and it is not the one the visible `<label>` provides.
 */

export type SmartSearchOption = {
  id: string;
  label: string;
  /** A second line — the SIC beside an industry, the role beside a colleague. */
  hint?: string;
};

export function SmartSearch({
  label, options, value, onChange, placeholder, required, disabled, emptyHint,
  id: fieldId, describedBy, invalid,
}: {
  /** The accessible name of the results listbox. The visible `<label>` is the caller's. */
  label: string;
  options: readonly SmartSearchOption[];
  /** The selected option's id, or "" for none. */
  value: string;
  onChange: (id: string, option: SmartSearchOption | null) => void;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  /** Said when the list itself is empty — a different fact from "nothing matched what you typed". */
  emptyHint?: string;
  /** Required: the caller's `<label htmlFor>` must be able to reach this input. */
  id: string;
  /** Hint and error ids from the caller's field row, so the control keeps one description. */
  describedBy?: string;
  invalid?: boolean;
}) {
  const listId = `${fieldId}-list`;

  const selected = useMemo(() => options.find((option) => option.id === value) ?? null, [options, value]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);

  // The input shows the selection until the person starts typing, and returns to it when they
  // stop without choosing — so an abandoned search does not look like a cleared field.
  const text = open ? query : selected?.label ?? "";

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!open || needle === "") return options.slice(0, 50);
    return options
      .filter((option) => `${option.label} ${option.hint ?? ""}`.toLowerCase().includes(needle))
      .slice(0, 50);
  }, [open, query, options]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  useEffect(() => { setActive(0); }, [query, open]);

  function choose(option: SmartSearchOption) {
    onChange(option.id, option);
    setOpen(false);
    setQuery("");
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) { setOpen(true); return; }
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => (current + step + matches.length) % Math.max(matches.length, 1));
      return;
    }
    if (event.key === "Enter" && open) {
      const option = matches[active];
      if (option) { event.preventDefault(); choose(option); }
      return;
    }
    if (event.key === "Escape" && open) { event.preventDefault(); setOpen(false); setQuery(""); }
  }

  return (
    <div className="nz-smart" ref={root}>
      <input
        id={fieldId}
        className={invalid ? "nz-inp bad" : "nz-inp"}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
        aria-required={required || undefined}
        autoComplete="off"
        disabled={disabled}
        placeholder={placeholder}
        value={text}
        onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />

      {open ? (
        <ul className="nz-smart-results" id={listId} role="listbox" aria-label={label}>
          {matches.length === 0 ? (
            <li className="nz-smart-empty" role="presentation">
              {options.length === 0
                ? emptyHint ?? "Nothing to choose from yet."
                : `Nothing matches “${query.trim()}”.`}
            </li>
          ) : matches.map((option, index) => (
            <li
              key={option.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              className={index === active ? "on" : undefined}
              // Pointer-down rather than click: a click would land after the input's blur has
              // already closed the list.
              onMouseDown={(event) => { event.preventDefault(); choose(option); }}
              onMouseEnter={() => setActive(index)}
            >
              <b>{option.label}</b>
              {option.hint ? <span>{option.hint}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {selected && !open ? <span className="nz-smart-chosen">{selected.hint ?? "Selected"}</span> : null}
    </div>
  );
}
