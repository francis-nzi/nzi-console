"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

const destinations = [
  ["Control Room", "/", "Portfolio overview and priority actions"], ["Clients", "/clients", "Relationships and delivery health"],
  ["Jobs", "/jobs", "All delivery engagements"], ["Emissions", "/charts", "Visual evidence and chart library"],
  ["Datasets & factors", "/datasets", "Governed emissions data"], ["Reports", "/reports", "Validation and publication"],
  ["LCA / PCF / CBAM", "/lca", "Product impact assessments"], ["Sales", "/sales", "Growth pipeline"],
  ["Platform & audit", "/platform", "Access, services and audit history"],
] as const;

export function CommandSearch({ placeholder, icon }: { placeholder: string; icon: ReactNode }) {
  const input = useRef<HTMLInputElement>(null), [query, setQuery] = useState(""), [open, setOpen] = useState(false), [active, setActive] = useState(0);
  const matches = useMemo(() => { const value = query.trim().toLowerCase(); return (value ? destinations.filter(item => `${item[0]} ${item[2]}`.toLowerCase().includes(value)) : destinations).slice(0, 6); }, [query]);
  function go(href: string) { window.location.assign(href); }
  function keys(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); setActive(value => Math.min(value + 1, matches.length - 1)); }
    if (event.key === "ArrowUp") { event.preventDefault(); setActive(value => Math.max(value - 1, 0)); }
    if (event.key === "Enter" && open && matches[active]) { event.preventDefault(); go(matches[active][1]); }
    if (event.key === "Escape") { setOpen(false); input.current?.blur(); }
  }
  useEffect(() => {
    function shortcut(event: KeyboardEvent) { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); input.current?.focus(); input.current?.select(); setOpen(true); } }
    window.addEventListener("keydown", shortcut); return () => window.removeEventListener("keydown", shortcut);
  }, []);
  return <div className="nz-search" role="search">{icon}<input ref={input} value={query} onChange={event => { setQuery(event.target.value); setActive(0); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 120)} onKeyDown={keys} placeholder={placeholder} role="combobox" aria-label={placeholder} aria-describedby="nzi-search-hint" aria-expanded={open} aria-controls="nzi-workspace-results" aria-activedescendant={open && matches[active] ? `nzi-result-${active}` : undefined} autoComplete="off"/><span className="k" aria-hidden="true">Ctrl K</span><span className="nz-sr-only" id="nzi-search-hint">Search workspace shortcuts. Use arrow keys to choose and Enter to navigate.</span>{open?<div className="nz-search-results" id="nzi-workspace-results" role="listbox" aria-label="Workspace shortcuts"><small>Workspace shortcuts</small>{matches.length?matches.map((item,index)=><button id={`nzi-result-${index}`} role="option" aria-selected={index===active} className={index===active?"active":undefined} key={item[1]} onMouseDown={event=>event.preventDefault()} onClick={()=>go(item[1])}><span><b>{item[0]}</b><small>{item[2]}</small></span><i>→</i></button>):<p>No matching workspace</p>}</div>:null}</div>;
}
