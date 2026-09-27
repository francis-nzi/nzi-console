"use client";

import { createContext, useContext, type ReactNode } from "react";

/** Who is signed in, as the rail shows it. Resolved from the session by the app, never hard-coded. */
export type RailUser = { initials: string; name: string; role: string };

const RailUserContext = createContext<RailUser | null>(null);

/** Provided once, at the root, from the session: every rail below it shows that person. */
export function RailUserProvider({ user, children }: { user: RailUser | null; children: ReactNode }) {
  return <RailUserContext.Provider value={user}>{children}</RailUserContext.Provider>;
}

export function RailUserBlock() {
  const user = useContext(RailUserContext);
  if (!user) {
    return <div className="nz-railfoot"><div className="av" aria-hidden="true">?</div><a className="who" href="/login">Not signed in<small>Sign in</small></a></div>;
  }
  return (
    <div className="nz-railfoot">
      <div className="av" aria-hidden="true">{user.initials}</div>
      <a className="who" href="/account" title="Account security">{user.name}<small>{user.role}</small></a>
      <form action="/api/auth/logout" method="post"><button type="submit" className="nz-signout" aria-label={`Sign out ${user.name}`} title="Sign out"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/><path d="M14 4h5a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5"/></svg></button></form>
    </div>
  );
}
