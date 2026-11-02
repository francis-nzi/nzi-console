"use client";

/** A wordless switch: on = shown/enabled. It carries only its name, for the screen reader and the tooltip. Shared by the Portal Management tabs. */
export function PmSwitch({ name, on, blocked, onToggle, title }: { name: string; on: boolean; blocked: boolean; onToggle: () => void; title?: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={name} title={title} aria-disabled={blocked || undefined} className={`nz-pm-sw${on ? " on" : ""}`}
    onClick={() => { if (!blocked) onToggle(); }} />;
}
