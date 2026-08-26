"use client";

import { useEffect, useRef, type ReactNode } from "react";

export function CommandSearch({ placeholder, icon }: { placeholder: string; icon: ReactNode }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); input.current?.focus(); input.current?.select(); }
      const current = input.current;
      if (event.key === "Escape" && current && document.activeElement === current) current.blur();
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  return <div className="nz-search" role="search">{icon}<input ref={input} placeholder={placeholder} aria-label={placeholder} aria-describedby="nzi-search-hint"/><span className="k" aria-hidden="true">Ctrl K</span><span className="nz-sr-only" id="nzi-search-hint">Press Control K or Command K to focus search. Press Escape to leave search.</span></div>;
}
