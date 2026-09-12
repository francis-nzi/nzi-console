import type { ElementType } from "react";

/**
 * One step in the trail. Every crumb has a route — including the current page, which is
 * still a link so it can be copied, opened in a new tab and returned to after a drawer
 * or a filter has changed the view. `current` marks it, it does not disable it.
 */
export type Crumb = { label: string; href: string; current?: boolean };

/**
 * The application breadcrumb. One structure everywhere: it is built from canonical
 * client/job data by the crumb builders, never assembled inline per page, so a job page
 * cannot quietly drop the client it belongs to.
 *
 * `link` lets the app supply its router's link (Next's `Link`) while the package itself
 * stays framework-free and falls back to a plain anchor.
 */
export function Breadcrumbs({ items, link: Anchor = "a" }: { items: readonly Crumb[]; link?: ElementType }) {
  return <nav aria-label="Breadcrumb" className="nz-crumbnav">
    <ol className="nz-crumblist">
      {items.map((item, index) => <li key={`${index}-${item.href}`}>
        {index > 0 ? <span className="nz-crumbsep" aria-hidden="true">/</span> : null}
        <Anchor href={item.href} className={item.current ? "nz-crumb current" : "nz-crumb"} aria-current={item.current ? "page" : undefined}>{item.label}</Anchor>
      </li>)}
    </ol>
  </nav>;
}
