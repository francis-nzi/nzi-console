"use client";

import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { EnvBadge, NziMark } from "@nzi/ui";
import { ADMIN_ICON_PATHS, ADMIN_ITEMS, ADMIN_NAV, type AdminIcon } from "./adminNav";

/**
 * The admin frame (docs/design/admin-prototype.html; NZC-167): a deep-quiet left rail, a calm top bar, one canvas.
 * Everything renders under `.nz-admin`, whose tokens and typefaces apply nowhere else.
 *
 * - **Theme** — three states (system, light, dark), per viewer. The choice is kept in localStorage, guarded, because
 *   it is a convenience: an unavailable store just means the system setting (ruled P10: admin only).
 * - **Environment** — the badge's words come from the running service (`environmentBadge`), never a constant.
 * - **Search** — filters the rail's destinations; it goes to a settings page, it does not search records.
 */
type Theme = "system" | "light" | "dark";
const THEME_KEY = "nzi-admin-theme";
const THEMES: Theme[] = ["system", "light", "dark"];
const THEME_LABEL: Record<Theme, string> = { system: "Theme: system", light: "Theme: light", dark: "Theme: dark" };

function AdminIconSvg({ name }: { name: AdminIcon }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">{ADMIN_ICON_PATHS[name].split("|").map((d) => <path key={d} d={d} />)}</svg>;
}

export function AdminShell({ fontClassName, environment, user, children }: {
  fontClassName: string;
  environment: { label: string; detail: string };
  user: { name: string; role: string } | null;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? "/admin";
  const active = ADMIN_ITEMS.find((item) => item.href === pathname) ?? ADMIN_ITEMS.find((item) => item.href !== "/admin" && pathname.startsWith(`${item.href}/`)) ?? ADMIN_ITEMS[0]!;
  const [theme, setTheme] = useState<Theme>("system");
  const [railOpen, setRailOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const resultsId = useId();

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(THEME_KEY);
      if (saved === "light" || saved === "dark" || saved === "system") setTheme(saved);
    } catch { /* storage unavailable: the system setting stands */ }
  }, []);
  useEffect(() => { setRailOpen(false); setQuery(""); }, [pathname]);

  const cycleTheme = () => {
    const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]!;
    setTheme(next);
    try { window.localStorage.setItem(THEME_KEY, next); } catch { /* not persisted; still applied */ }
  };

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? ADMIN_ITEMS.filter((item) => item.label.toLowerCase().includes(needle) || item.description.toLowerCase().includes(needle)).slice(0, 7) : [];
  }, [query]);

  return <div className={`nz-admin ${fontClassName}`} data-theme={theme === "system" ? undefined : theme}>
    <a className="nz-skip-link" href="#nzi-admin-main">Skip to main content</a>
    <div className="nz-a-app">
      <aside className={`nz-a-rail${railOpen ? " on" : ""}`} aria-label="Administration">
        <div className="nz-a-brand">
          <NziMark className="nz-a-mark" />
          <div><b>NZ Insights Pro</b><span>Admin</span></div>
        </div>
        <nav className="nz-a-nav" aria-label="Admin sections">
          {ADMIN_NAV.map((group) => <div className="nz-a-nav-group" key={group.group ?? "top"}>
            {group.group ? <p>{group.group}</p> : null}
            {group.items.map((item) => <a key={item.id} href={item.href} className="nz-a-nav-item" aria-current={item.id === active.id ? "page" : undefined}>
              <AdminIconSvg name={item.icon} /><span>{item.label}</span>
              {item.phase ? <span className="phase" title={`Arrives with roadmap phase ${item.phase}`}>{item.phase}</span> : null}
            </a>)}
          </div>)}
        </nav>
        <div className="nz-a-rail-foot">
          <a href="/">← Back to the console</a>
        </div>
      </aside>

      <div className="nz-a-main">
        <header className="nz-a-topbar">
          <button type="button" className="nz-a-icon-btn nz-a-hamb" aria-label="Admin menu" aria-expanded={railOpen} onClick={() => setRailOpen((open) => !open)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
          <nav className="nz-a-crumb" aria-label="Breadcrumb">
            <a href="/admin">Admin</a>{active.id !== "overview" ? <><span aria-hidden="true">/</span><b aria-current="page">{active.label}</b></> : <><span aria-hidden="true">/</span><b aria-current="page">Overview</b></>}
          </nav>
          <div className="nz-a-search" role="search">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m21 21-4-4" /></svg>
            <input aria-label="Search settings" placeholder="Search settings…" value={query} role="combobox" aria-expanded={matches.length > 0 || query.trim() !== ""}
              aria-controls={resultsId} aria-autocomplete="list"
              onChange={(event) => { setQuery(event.target.value); setCursor(0); }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") { event.preventDefault(); setCursor((at) => Math.min(at + 1, Math.max(matches.length - 1, 0))); }
                else if (event.key === "ArrowUp") { event.preventDefault(); setCursor((at) => Math.max(at - 1, 0)); }
                else if (event.key === "Enter" && matches[cursor]) { window.location.assign(matches[cursor]!.href); }
                else if (event.key === "Escape") setQuery("");
              }} />
            {query.trim() ? <ul className="nz-a-search-results" id={resultsId} role="listbox" aria-label="Settings">
              {matches.length ? matches.map((item, index) => <li key={item.id}>
                <a href={item.href} role="option" aria-selected={index === cursor}>{item.label}<small>{item.phase ? `Phase ${item.phase}` : "Live"}</small></a>
              </li>) : <li className="none">No setting matches</li>}
            </ul> : null}
          </div>
          <EnvBadge label={environment.label} detail={environment.detail} />
          <button type="button" className="nz-a-icon-btn" onClick={cycleTheme} aria-label={`${THEME_LABEL[theme]}. Change theme`} title={THEME_LABEL[theme]}>
            <svg viewBox="0 0 24 24" aria-hidden="true">{theme === "dark" ? <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" /> : theme === "light" ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></> : <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>}</svg>
          </button>
          {user ? <span className="nz-a-user" title={`Signed in as ${user.name} (${user.role})`}>{user.name}</span> : null}
        </header>
        <main className="nz-a-canvas" id="nzi-admin-main" tabIndex={-1}><div className="nz-a-wrap">{children}</div></main>
      </div>
    </div>
  </div>;
}
