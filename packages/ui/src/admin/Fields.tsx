"use client";

import { useId, type ReactNode } from "react";

/**
 * The admin form fields (docs/design/admin-design-notes.md): a label above, an optional hint below, the control between.
 * Each field owns its id, so the label, the hint and any error are programmatically tied to the control
 * (`aria-describedby`, `aria-invalid`) — a screen reader hears the label, the value, the hint and the problem together.
 *
 * Controlled, with no state of their own: the form that renders them owns the values.
 */

type FieldChrome = { label: string; hint?: ReactNode; error?: string; mono?: boolean };

function FieldFrame({ id, label, hint, error, mono, children }: FieldChrome & { id: string; children: ReactNode }) {
  return <div className={`nz-a-field${mono ? " mono" : ""}`}>
    <label htmlFor={id}>{label}</label>
    {children}
    {hint ? <div className="nz-a-hint" id={`${id}-hint`}>{hint}</div> : null}
    {error ? <div className="nz-a-error" id={`${id}-error`} role="alert">{error}</div> : null}
  </div>;
}

const describedBy = (id: string, hint: unknown, error: unknown) =>
  [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;

export function TextField({ label, hint, error, mono, value, onChange, placeholder, required, readOnly, disabled, maxLength }: FieldChrome & {
  value: string; onChange?: (value: string) => void; placeholder?: string; required?: boolean; readOnly?: boolean; disabled?: boolean; maxLength?: number;
}) {
  const id = useId();
  return <FieldFrame id={id} label={label} hint={hint} error={error} mono={mono}>
    <input id={id} value={value} placeholder={placeholder} required={required} readOnly={readOnly} disabled={disabled} maxLength={maxLength}
      aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, hint, error)}
      onChange={(event) => onChange?.(event.target.value)} />
  </FieldFrame>;
}

/** A number, kept as the text the person typed until the form parses it — so "1." is not rewritten mid-keystroke. */
export function NumberField({ label, hint, error, value, onChange, min, max, step, required, disabled }: Omit<FieldChrome, "mono"> & {
  value: string; onChange?: (value: string) => void; min?: number; max?: number; step?: number; required?: boolean; disabled?: boolean;
}) {
  const id = useId();
  return <FieldFrame id={id} label={label} hint={hint} error={error} mono>
    <input id={id} type="number" inputMode="decimal" value={value} min={min} max={max} step={step} required={required} disabled={disabled}
      aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, hint, error)}
      onChange={(event) => onChange?.(event.target.value)} />
  </FieldFrame>;
}

export function TextAreaField({ label, hint, error, value, onChange, rows = 3, required, disabled }: Omit<FieldChrome, "mono"> & {
  value: string; onChange?: (value: string) => void; rows?: number; required?: boolean; disabled?: boolean;
}) {
  const id = useId();
  return <FieldFrame id={id} label={label} hint={hint} error={error}>
    <textarea id={id} rows={rows} value={value} required={required} disabled={disabled}
      aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, hint, error)}
      onChange={(event) => onChange?.(event.target.value)} />
  </FieldFrame>;
}

export type SelectOption = { value: string; label: string };
export function SelectField({ label, hint, error, value, onChange, options, placeholder, required, disabled }: Omit<FieldChrome, "mono"> & {
  value: string; onChange?: (value: string) => void; options: readonly SelectOption[]; placeholder?: string; required?: boolean; disabled?: boolean;
}) {
  const id = useId();
  return <FieldFrame id={id} label={label} hint={hint} error={error}>
    <select id={id} value={value} required={required} disabled={disabled}
      aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, hint, error)}
      onChange={(event) => onChange?.(event.target.value)}>
      {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  </FieldFrame>;
}

/**
 * The design's Active toggle: a labelled switch with the consequence written beside it ("Inactive values leave the
 * pickers but still show on existing records"). A real `role="switch"` button, so its state is announced.
 */
export function Switch({ label, description, checked, onChange, disabled }: {
  label: string; description?: ReactNode; checked: boolean; onChange?: (checked: boolean) => void; disabled?: boolean;
}) {
  const id = useId();
  return <div className="nz-a-switch">
    <div className="tx"><b id={`${id}-label`}>{label}</b>{description ? <p id={`${id}-desc`}>{description}</p> : null}</div>
    <button type="button" role="switch" aria-checked={checked} aria-labelledby={`${id}-label`} aria-describedby={description ? `${id}-desc` : undefined}
      disabled={disabled} className={`nz-a-tog${checked ? " on" : ""}`} onClick={() => onChange?.(!checked)} />
  </div>;
}

/** Two fields side by side, collapsing to one column at phone width. */
export const FieldRow = ({ children }: { children: ReactNode }) => <div className="nz-a-row2">{children}</div>;
