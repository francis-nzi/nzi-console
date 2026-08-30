import type { ReactNode } from "react";
import { CommandSearch } from "./CommandSearch";

export type IconName =
  | "home" | "users" | "jobs" | "chart" | "database" | "file" | "layers"
  | "trend" | "settings" | "search" | "bell";

const PATHS: Record<IconName, ReactNode> = {
  home: <><path d="M3 12l9-8 9 8" /><path d="M5 10v10h14V10" /></>,
  users: <><circle cx="12" cy="8" r="4" /><path d="M4 21v-1a6 6 0 0 1 12 0v1" /></>,
  jobs: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18" /></>,
  chart: <><path d="M3 20h18" /><path d="M6 20V9" /><path d="M12 20V4" /><path d="M18 20v-7" /></>,
  database: <><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" /></>,
  file: <><path d="M6 2h9l5 5v15H6z" /><path d="M15 2v5h5" /></>,
  layers: <><path d="M12 3l8 4-8 4-8-4z" /><path d="M4 11l8 4 8-4" /><path d="M4 15l8 4 8-4" /></>,
  trend: <><path d="M3 17l6-6 4 4 8-8" /><path d="M21 7v5h-5" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></>,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></>,
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

export type NavItem = { id: string; label: string; icon: IconName; href: string; count?: number };
export type NavSection = { heading: string; items: NavItem[] };

export function AppShell({ rail, drawer, children }: { rail: ReactNode; drawer?: ReactNode; children: ReactNode }) {
  return (
    <div className={drawer ? "nz-app" : "nz-app no-drawer"}>
      <a className="nz-skip-link" href="#nzi-main-content">Skip to main content</a>
      {rail}
      <main className="nz-main" id="nzi-main-content" tabIndex={-1}>{children}</main>
      {drawer}
    </div>
  );
}

export function WorkspaceRail({
  sections, activeId, user,
}: { sections: NavSection[]; activeId?: string; user: { initials: string; name: string; role: string } }) {
  return (
    <aside className="nz-rail">
      <div className="nz-brand">
        <div className="mark">N</div>
        <div className="wm">NZI Pro<small>Insights platform</small></div>
      </div>
      {sections.map((s) => (
        <div key={s.heading}>
          <div className="nz-navsec">{s.heading}</div>
          <nav className="nz-nav" aria-label={s.heading}>
            {s.items.map((it) => (
              <a key={it.id} href={it.href} className={it.id === activeId ? "active" : undefined} aria-current={it.id === activeId ? "page" : undefined}>
                <Icon name={it.icon} />
                {it.label}
                {typeof it.count === "number" && <span className="count">{it.count}</span>}
              </a>
            ))}
          </nav>
        </div>
      ))}
      <div className="nz-railfoot">
        <div className="av">{user.initials}</div>
        <a className="who" href="/account" title="Account security">{user.name}<small>{user.role}</small></a>
        <form action="/api/auth/logout" method="post"><button type="submit" className="nz-signout" aria-label={`Sign out ${user.name}`} title="Sign out"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/><path d="M14 4h5a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5"/></svg></button></form>
      </div>
    </aside>
  );
}

export function TopBar({ crumbs, searchPlaceholder = "Search…" }: { crumbs: ReactNode; searchPlaceholder?: string }) {
  return (
    <div className="nz-topbar">
      <div className="nz-crumbs">{crumbs}</div>
      <CommandSearch placeholder={searchPlaceholder} icon={<Icon name="search" />} />
    </div>
  );
}

export function EvidenceDrawer({
  kicker, title, subtitle, children, actions,
}: { kicker: string; title: string; subtitle: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <aside className="nz-drawer" aria-label={`${kicker}: ${title}`}>
      <div className="nz-dh">
        <div className="kick">{kicker}</div>
        <h3>{title}</h3>
        <div className="m">{subtitle}</div>
      </div>
      <div className="nz-dbody" tabIndex={0}>{children}</div>
      {actions && <div className="nz-dact">{actions}</div>}
    </aside>
  );
}
