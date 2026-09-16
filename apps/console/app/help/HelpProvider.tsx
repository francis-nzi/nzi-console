"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { HelpContext } from "@nzi/ui";
import { useEditAccess } from "../lib/useEditAccess";
import { helpContextForPath } from "./helpContext";
import { HelpDrawer } from "./HelpDrawer";

/**
 * Hosts the help drawer once, for the whole app.
 *
 * Mounted in the root layout, so the `?` that `TopBar` renders has something to open on
 * every page without any page being asked to wire it up. The drawer itself is only mounted
 * while open — its tabs fetch, and a closed drawer should cost nothing.
 *
 * Page-awareness comes from the route, which is the only signal available everywhere. The
 * alternative — each page declaring its own context — would work until the page that forgot.
 */
export function HelpProvider({ children, writeEnabled }: { children: React.ReactNode; writeEnabled: boolean }) {
  const [open, setOpen] = useState(false);
  const path = usePathname() ?? "/";
  const opener = useRef<HTMLElement | null>(null);

  // The server check is authoritative; this decides whether the Review tab is worth showing.
  const approve = useEditAccess("knowledge.approve", writeEnabled);
  const publish = useEditAccess("knowledge.publish", writeEnabled);

  const toggle = useCallback(() => {
    // Remembered before the drawer takes focus, so closing returns it to the `?` rather
    // than to the top of the document.
    opener.current = document.activeElement as HTMLElement | null;
    setOpen((current) => !current);
  }, []);

  const control = useMemo(() => ({
    open: toggle, isOpen: open,
    // Said here, not in @nzi/ui: what help contains is the app's business.
    label: "Help — guided tours, the knowledge library, and asking a question",
  }), [toggle, open]);
  const context = useMemo(() => helpContextForPath(path), [path]);

  return (
    <HelpContext.Provider value={control}>
      {children}
      {open ? <HelpDrawer
        context={context}
        capabilities={{ approve: approve.state === "allowed", publish: publish.state === "allowed" }}
        onClose={() => setOpen(false)}
        returnFocusTo={opener.current}
      /> : null}
    </HelpContext.Provider>
  );
}
