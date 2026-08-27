import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {it} from "node:test";

const read=(path:string)=>readFileSync(new URL(path,import.meta.url),"utf8"),styles=read("../../../packages/ui/src/styles.css"),layout=read("../app/portal/layout.tsx"),workspace=read("../app/portal-preview/PortalWorkspace.tsx"),root=read("../app/layout.tsx");
it("provides one keyboard skip target across every client portal route",()=>{assert.match(layout,/className="nz-skip-link"/);assert.match(layout,/href="#portal-route-content"/);assert.match(layout,/id="portal-route-content"/);assert.match(layout,/tabIndex=\{-1\}/);});
it("implements the ARIA tab keyboard pattern for the report workspace",()=>{for(const token of ['role="tablist"','role="tab"','role="tabpanel"','aria-selected','aria-controls','aria-labelledby','tabIndex={tab===item.id?0:-1}','ArrowLeft','ArrowRight','Home','End'])assert.ok(workspace.includes(token),token);});
it("keeps focus visible for links, buttons, inputs, selects and textareas",()=>{for(const selector of ["a:focus-visible","button:focus-visible",".nz-inp:focus-visible",".nz-sel:focus-visible",".nz-notes:focus-visible",'[role="tab"]:focus-visible'])assert.ok(styles.includes(selector),selector);assert.match(styles,/outline:3px solid #0B7A4B/);});
it("uses contrast-safe primary controls and removes nonessential motion",()=>{assert.match(styles,/\.nz-btn\.pri\{background:var\(--pine\).*color:#fff/);assert.match(styles,/\.nz-portal-brand>span\{[^}]*color:#052E1F/);assert.match(styles,/@media \(prefers-reduced-motion:reduce\)/);assert.match(styles,/transition-duration:\.01ms!important/);});
it("declares the document language",()=>{assert.match(root,/<html lang="en"/);});
