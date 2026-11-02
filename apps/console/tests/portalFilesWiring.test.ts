// Portal files in the console (BRIEF-portal-files-secure-upload-storage): dark until `portal-files` is on, no storage identifier or durable
// link reaches the browser, and every file route is behind the flag and the audited commands. The gate itself is proved in isolated-backend.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const source = (path: string) => readFileSync(resolve(root, path), "utf8");
const routes = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? routes(path) : name === "route.ts" ? [path] : [];
});
const fileRoutes = [...routes(resolve(root, "app/api/portal/files")), ...routes(resolve(root, "app/api/isolated/clients/[clientId]/files"))];

describe("portal files routes", () => {
  it("are six, each behind the flag (404 while it is off) before anything else is read", () => {
    assert.equal(fileRoutes.length, 6);
    for (const path of fileRoutes) {
      const text = readFileSync(path, "utf8");
      for (const verb of text.matchAll(/export async function (GET|POST)[\s\S]*?\n}\n/g)) {
        assert.match(verb[0], /try \{\s+requirePortalFiles\(\);/, `${path} ${verb[1]}`);
      }
    }
  });

  it("write only through the audited commands, and the portal's also hold the origin and session checks", () => {
    for (const path of fileRoutes.filter((candidate) => /\.ts$/.test(candidate) && readFileSync(candidate, "utf8").includes("export async function POST"))) {
      const text = readFileSync(path, "utf8");
      assert.match(text, /recordPortalFileUpload|recordClientFileDelivery|issuePortalFileDownload|issueClientFileDownload|rescanClientFile|deactivateClientFile/, path);
      if (path.includes(`${"portal"}${"\\"}files`) || path.includes("portal/files")) assert.match(text, /requirePortalOrigin\(request\)/, path);
    }
  });

  it("never serve bytes or a durable link: a download is a POST that returns a signed URL, with no caching", () => {
    for (const path of fileRoutes.filter((candidate) => candidate.endsWith(join("download", "route.ts")))) {
      const text = readFileSync(path, "utf8");
      assert.doesNotMatch(text, /export async function GET/);
      assert.match(text, /Cache-Control": "private, no-store"/);
      assert.doesNotMatch(text, /externalItemId|storageProvider|\.bytes|arrayBuffer/);
    }
  });
});

describe("the scanner is part of every route that ingests or re-checks a file", () => {
  it("calls configuredScanner (so an unconfigured scanner is a 503, never a silent skip)", () => {
    for (const path of fileRoutes) {
      const text = readFileSync(path, "utf8");
      if (/ingestFile\(|rescanClientFile\(/.test(text)) assert.match(text, /configuredScanner\(\)/, path);
    }
  });
});

describe("the Files panel", () => {
  const panel = source("app/clients/[clientId]/PortalFilesPanel.tsx");
  it("is shown only when portal-files is on, inside Portal Management", () => {
    assert.match(source("app/clients/[clientId]/PortalManagementArea.tsx"), /portalFeatureEnabled\("portal-files"\) \? <PortalFilesPanel/);
    assert.doesNotMatch(source("../../render.yaml"), /portal-files/, "dark by absence: the token is the dashboard's to add");
  });
  it("knows no storage identifier, provider or hosting service, and opens a download only from a freshly issued URL", () => {
    assert.doesNotMatch(panel, /externalItemId|storageProvider|sharepoint|graph\.microsoft/i);
    assert.match(panel, /\/download`, \{\}, crypto\.randomUUID\(\)\)/);
    assert.match(panel, /window\.open\(result\.data\.url, "_blank", "noopener"\)/);
  });
  it("offers a download only for a released file, a re-check only for a held one, and withdraws only with a reason", () => {
    assert.match(panel, /file\.status === "released" \? <button[\s\S]*?>Download<\/button>/);
    assert.match(panel, /file\.status === "quarantined" \? <button[\s\S]*?>Check again<\/button>/);
    assert.match(panel, /if \(!reason\.trim\(\)\) return;/);
  });
});
